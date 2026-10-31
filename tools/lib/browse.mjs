// 刷帖层：把「板块流」变成一份可排序的候选池 + 一份日报。
//
// 与 watch.mjs 的分工：
//   watch  = 被动的（有人 @ 我 / 大号发帖 → 回一句）
//   browse = 主动的（自己逛板块 → 选题 → 读帖 → 写日报 → 可选回帖）
//
// 数据来源：
//   sectionTopics(sectionId,{lastId,cursor}) —— 翻页靠上一页返回的 last_id + cursor 成对回传。
import { sectionTopics, sectionCatalog } from './forum.mjs'
import { makeFilter } from './filter.mjs'
import { loadSeen, saveSeen, seenReply, markReply } from './state.mjs'

const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
/** 目录里的 discuss_num 是「23.8万」这种字符串，直接 Number() 会变 0。 */
const cnNum = (v) => {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim()
  const m = s.match(/^([\d.]+)\s*(万|亿)?/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return m[2] === '亿' ? n * 1e8 : m[2] === '万' ? n * 1e4 : n
}
/** 标题命中静音词 = 活动/公告帖，刷论坛的人不想看这些。 */
const muted = (title, list) => {
  const t = String(title || '')
  return (list || []).some((w) => w && t.includes(String(w)))
}

/** 帖子列表里的 status 是字符串；前端也是这么过滤的（t.status==='1' && t.client_status!=='4'）。 */
function visible(t) {
  if (String(t.status ?? '1') !== '1') return false
  if (String(t.client_status ?? '') === '4') return false
  if (String(t.del_status ?? '0') !== '0') return false
  return true
}

/** 帖子时间可能是秒也可能是毫秒，统一成毫秒；认不出来就当 0（不给新鲜度加分）。 */
function timeMs(t) {
  const raw = Number(t.time ?? 0)
  if (!raw) return 0
  return raw < 1e12 ? raw * 1000 : raw
}

/**
 * 要扫哪些板块。用户没填就自己挑：推荐论坛里讨论数最高的前 N 个。
 * @returns {Promise<Array<{id:string,title:string}>>}
 */
export async function resolveSections(cfg, { log = () => {} } = {}) {
  const B = cfg.browse || {}
  const list = (B.sections || []).map((x) => (typeof x === 'string' ? { id: x, title: '' } : x)).filter((x) => x && x.id)
  if (list.length) return list.slice(0, Math.max(1, Number(B.maxSections) || 6))
  const cat = await sectionCatalog()
  if (cat.code !== 100 || !cat.sections.length) {
    log('[browse] 拉板块目录失败：' + (cat.msg || cat.code))
    return []
  }
  const byId = new Map(cat.sections.map((s) => [String(s.id), s]))
  const want = (B.defaultSections || []).map(String).filter(Boolean)
  const picked = want
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((s) => ({ id: String(s.id), title: s.title || '' }))
  if (picked.length) {
    log('[browse] 未指定板块，用默认公共讨论区：' + picked.map((x) => x.title || x.id).join(' / '))
    return picked.slice(0, Math.max(1, Number(B.maxSections) || 6))
  }
  // 默认列表里一个都认不出来（平台改版）→ 退回讨论数最高的几个
  const pool = cat.sections.slice().sort((a, b) => cnNum(b.discuss) - cnNum(a.discuss))
  const fallback = pool.slice(0, Math.max(1, Number(B.maxSections) || 6)).map((s) => ({ id: String(s.id), title: s.title || '' }))
  log('[browse] 默认板块失效，退回热门：' + fallback.map((x) => x.title || x.id).join(' / '))
  return fallback
}

/**
 * 按配置扫若干板块的帖子流（每板块翻 pages 页）。
 * 只读，不发任何写请求。
 */
export async function gather(cfg, { log = () => {} } = {}) {
  const B = cfg.browse || {}
  const sections = await resolveSections(cfg, { log })
  const fForum = makeFilter(B)
  const out = []
  const seenIds = new Set()
  const pages = Math.min(5, Math.max(1, Number(B.pages) || 1))

  for (const sec of sections) {
    const f = fForum.forum(sec.id, sec.title)
    if (!f.ok) { log('[browse] 跳过板块 ' + (sec.title || sec.id) + '：' + f.why); continue }
    let lastId = 0, cursor = 0
    for (let p = 0; p < pages; p++) {
      let j
      try { j = await sectionTopics(sec.id, { lastId, cursor }) }
      catch (e) { log('[browse] ' + (sec.title || sec.id) + ' 读失败：' + e.message); break }
      if (j.code !== 100) { log('[browse] ' + (sec.title || sec.id) + ' code=' + j.code + ' ' + (j.msg || '')); break }
      const list = j.result?.data || []
      for (const t of list) {
        if (!visible(t)) continue
        if (B.skipTop !== false && num(t.is_top) > 0) continue
        if (muted(t.title, B.muteTitles)) continue
        const id = String(t.id)
        if (seenIds.has(id)) continue
        seenIds.add(id)
        out.push({
          topicId: id,
          title: strip(t.title),
          content: strip(t.content).slice(0, 600),
          sectionId: String(sec.id),
          sectionTitle: sec.title || strip(t.c_subject || t.p_subject || ''),
          uid: String(t.uid || ''),
          nickname: t.user?.nickname || String(t.uid || ''),
          replyCount: num(t.reply_count),
          commentCount: num(t.comment_count),
          upVote: num(t.up_vote),
          views: num(t.views),
          isEssence: num(t.is_essence) > 0,
          isTop: num(t.is_top) > 0,
          timeMs: timeMs(t),
          timeStr: t.time_str || '',
        })
      }
      const nextLast = j.result?.last_id, nextCur = j.result?.cursor
      if (!list.length || nextLast === undefined || String(nextLast) === String(lastId)) break
      lastId = nextLast; cursor = nextCur
      if (list.length < 10) break
    }
    log('[browse] ' + (sec.title || sec.id) + ' 扫到 ' + out.filter((x) => x.sectionId === String(sec.id)).length + ' 帖')
  }
  return out
}

/**
 * 打分：互动量给分，新鲜度按半衰期衰减，精华/置顶各加一点。
 * 分数是「值不值得读」的相对排序依据，不是绝对量纲。
 */
export function score(t, S = {}, now = Date.now()) {
  const w = {
    reply: 3, comment: 1, vote: 2, view: 0.01,
    fresh: 6, essence: 8, top: 2, ageHalfLifeHours: 24,
    ...(S || {}),
  }
  let s = 0
  s += num(t.replyCount) * num(w.reply)
  s += num(t.commentCount) * num(w.comment)
  s += num(t.upVote) * num(w.vote)
  s += num(t.views) * num(w.view)
  if (t.isEssence) s += num(w.essence)
  if (t.isTop) s += num(w.top)
  if (t.timeMs) {
    const ageH = Math.max(0, (now - t.timeMs) / 3600000)
    const half = Math.max(1, num(w.ageHalfLifeHours) || 24)
    s += num(w.fresh) * Math.pow(0.5, ageH / half)
  }
  return Math.round(s * 10) / 10
}

/**
 * 排序 + 过滤 + 去重（已经进过日报的帖子不再重复选）。
 * @returns {{picks:Array, ranked:Array}}
 */
export function rank(cfg, cands, { now = Date.now(), seen = null, fresh = true } = {}) {
  const B = cfg.browse || {}
  const fUser = makeFilter(B)
  const fTopic = makeFilter(B)
  const st = seen || loadSeen()
  const scored = []
  for (const t of cands) {
    const u = fUser.user(t.uid, t.nickname)
    if (!u.ok) continue
    const tp = fTopic.topic(t.topicId)
    if (!tp.ok) continue
    const sc = score(t, B.score, now)
    scored.push({ ...t, score: sc })
  }
  scored.sort((a, b) => b.score - a.score)
  const minScore = num(B.minScore)
  const pool = scored.filter((x) => x.score >= minScore)
  const picks = fresh ? pool.filter((x) => !seenReply(st, 'b:' + x.topicId)) : pool
  return { picks: picks.slice(0, Math.max(1, Number(B.pick) || 8)), ranked: scored }
}

/** 把这一轮选中的帖子登记成「已进过日报」，下一轮不再重复选。 */
export function markPicked(seen, picks) {
  for (const p of picks) markReply(seen, 'b:' + p.topicId, { digest: true, score: p.score })
}

/** 日报的纯文本骨架（AI 挂了也能落一份能看的东西，不静默丢数据）。 */
export function fallbackDigest(picks, meta) {
  const lines = ['# 好游快爆 · 日报 ' + meta.date, '']
  if (meta.note) lines.push('> ' + meta.note, '')
  for (const p of picks) {
    lines.push('## ' + (p.title || '(无标题)') + '　' + p.score + ' 分')
    lines.push('- 板块：' + (p.sectionTitle || p.sectionId) + '　作者：' + (p.nickname || p.uid))
    lines.push('- 回复 ' + p.replyCount + '　评论 ' + p.commentCount + '　赞 ' + p.upVote + '　浏览 ' + p.views + '　' + (p.timeStr || ''))
    if (p.content) lines.push('- 摘录：' + p.content.slice(0, 160))
    lines.push('- 链接：https://bbs.3839.com/thread-' + p.topicId + '.htm')
    lines.push('')
  }
  return lines.join('\n')
}
