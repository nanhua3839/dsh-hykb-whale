// 监听引擎：四类监听源 + 白黑名单 + 去重冷却 + AI 回复，全部在这里。
//
// 四类源：
//   ① forum  —— 填板块 id，扫这个板块的最新帖子（按最后回复时间倒序的第一页）
//   ② topic  —— 填帖子 id/链接，扫这帖的主楼层和楼中楼
//   ③ at     —— @ 我：消息中心的 mode=3 通知列表（全站唯一能拿到「谁 @ 了我」明细的地方），
//               不需要填任何 id 就能工作 —— 这就是「什么都不配、只靠别人 @ 她就回」的那条路
//   ④ at 的名单与范围 —— 对 ①②③ 扫到的内容统一做「算不算叫我」的收窄
//
// 触发条件（满足任一）：
//   · 内容 @ 我（富文本 kb-contact 或纯文本 @昵称，判据在 trigger.mjs）
//   · 作者是 owner（大号）—— 这就是「大号发帖/回帖 → 小号接话」的主场景
//
// 首次扫描只登记不回复（bootstrap）：否则第一次启动会把历史内容全回一遍。
import { sectionTopics } from './forum.mjs'
import { topicDetail, replyOperate, commentOperate, atList } from './hykb-api.mjs'
import { makeFilter } from './filter.mjs'
import { matchTrigger } from './trigger.mjs'
import { loadSeen, saveSeen, seenReply, markReply, seenPerson, markPerson, audit } from './state.mjs'
import { loadCred, missingForWrite } from './cred.mjs'
import { chat, replyPrompt, replySummaryPrompt, applySuffix } from './ai.mjs'

const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/** keyOf 产出的三类前缀；别的（b:/r:）是刷帖层自己的标记。 */
const LISTEN_KEY_PREFIX = new Set(['t', 'f', 'c'])

/** 触发文本是「让我总结这帖」的意思 */
const WANT_SUMMARY = /总结|汇总|概括|梳理|讲(了)?(啥|什么)|说(了)?(啥|什么)|什么内容|大概内容|什么情况/

/** 把多行总结压成能直接发出去的一段（保留换行，但不超过论坛能接受的体量） */
function toPostText(md) {
  return String(md || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 900)
}

/** 去重键：带 topicId，换监听范围时能只清掉这一帖的记录。 */
const keyOf = (c) =>
  c.kind === 'topic' ? 't:' + c.topicId
  : c.kind === 'floor' ? 'f:' + c.topicId + ':' + c.floorId
  : 'c:' + c.topicId + ':' + c.commentId

/** 「@ 我」通知里的 time 是人话（"55分钟前"），不是时间戳：只用来挡掉太旧的，解析不了就放行。 */
const ATME_MAX_AGE_MIN = 7 * 24 * 60
function noticeAgeMin(s) {
  const m = /^(\d+)\s*(秒|分钟|小时|天)前$/.exec(String(s || '').trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] === '秒' ? n / 60 : m[2] === '分钟' ? n : m[2] === '小时' ? n * 60 : n * 1440
}

/**
 * 把四类源的当前内容扫成候选列表。只读，不发任何东西。
 * @returns {Promise<Array>} 候选事件
 */
export async function collect(cfg, { log = () => {} } = {}) {
  const out = []
  const L = cfg.listen || {}

  /* ① 论坛源：扫板块第一页的帖子 */
  if (L.forum?.enabled) {
    for (const item of L.forum.items || []) {
      if (!item?.id) continue
      const j = await sectionTopics(item.id, {})
      if (j.code !== 100) { log('[forum] ' + item.id + ' 读失败 ' + j.code + ' ' + (j.msg || '')); continue }
      const list = j.result?.data || []
      for (const t of list) {
        out.push({
          source: 'forum', kind: 'topic',
          sectionId: String(item.id), sectionTitle: item.title || '',
          topicId: String(t.id), topicTitle: t.title || '',
          uid: String(t.uid), nickname: t.user?.nickname || t.uid,
          content: strip(t.title) + ' ' + strip(t.content),
          timeStr: t.time_str || '', replyCount: t.reply_count,
          raw: t,
        })
      }
      log('[forum] ' + (item.title || item.id) + ' 扫到 ' + list.length + ' 帖')
    }
  }

  /* ③ @ 我 源：消息中心的通知列表。整条链路里唯一「什么都不用填」的源。 */
  // mode=3 就是消息中心第三个 tab「@我的」。它给的是明细（谁、哪个帖、哪层楼），
  // 拿不到正文本身，所以还要按 tid 去读一次帖，把 rid 那层楼捞出来。
  if (L.atme?.enabled !== false) {
    const capAtme = Math.max(1, Number(L.maxTopicsPerTick) || 6)
    let j = null
    try {
      j = await atList({ mode: 3 })
    } catch (e) {
      log('[atme] 通知读失败 ' + e.message)
    }
    if (j && j.code !== 100) log('[atme] 通知读失败 ' + j.code + ' ' + (j.msg || ''))
    const all = (j && j.code === 100 ? j.result?.data || [] : [])
    const pick = all.filter((n) => {
      if (String(n.del_status) === '1') return false          // 内容已删，没正文也没楼层
      if (String(n.type) !== '202') return false              // 200 = 发帖里@我，没有楼层可回
      if (!n.tid || !n.rid || String(n.rid) === '0') return false
      const age = noticeAgeMin(n.time)
      return age == null || age <= ATME_MAX_AGE_MIN
    })
    if (all.length) log('[atme] 通知 ' + all.length + ' 条，可用 ' + pick.length + ' 条')

    // 同一帖里的多条 @ 只读一次帖
    const byTopic = new Map()
    for (const n of pick) {
      const tid = String(n.tid)
      if (!byTopic.has(tid)) byTopic.set(tid, [])
      byTopic.get(tid).push(n)
    }
    const atmeTids = [...byTopic.keys()].slice(0, capAtme)
    if (byTopic.size > atmeTids.length) {
      log('[atme] 本轮只读前 ' + atmeTids.length + ' 帖（上限 maxTopicsPerTick=' + capAtme + '，通知里共 ' + byTopic.size + ' 帖）')
    }
    for (const tid of atmeTids) {
      const jj = await topicDetail(tid, { sort: 2 })
      if (jj.code !== 100) { log('[atme] ' + tid + ' 读失败 ' + jj.code + ' ' + (jj.msg || '')); continue }
      const topic = jj.result?.topic || {}
      const replies = jj.result?.reply || []
      for (const n of byTopic.get(tid)) {
        const rid = String(n.rid)
        const floor = replies.find((r) => String(r.id) === rid)
        out.push({
          source: 'atme', kind: 'floor',
          sectionId: String(topic.sid || ''), sectionTitle: topic.section?.title || n.from_info || '',
          topicId: tid, topicTitle: topic.title || '',
          floorId: rid, position: floor?.position || '',
          uid: String(n.from_uid || floor?.uid || ''),
          nickname: n.from_nickname || floor?.user?.nickname || String(n.from_uid || ''),
          // 楼层不在第一页时用通知里的富文本兜底，commentOperate 只认 replyId，照样能回
          content: floor?.content || n.to_info || '',
          timeStr: floor?.time_str || n.time || '',
          noticeId: String(n.id || ''),
          topic, replies,
        })
      }
      log('[atme] ' + (topic.title || tid) + ' 命中 ' + byTopic.get(tid).length + ' 条通知')
    }
  }

  /* ② 帖子源：扫指定帖的楼层与楼中楼 */
  // maxTopicsPerTick 是每轮最多读几个帖：帖子源的条数直接受它约束，
  // 不然一次 tick 把所有帖都拉一遍，读额度会在几秒内见底。
  const capTopics = Math.max(1, Number(L.maxTopicsPerTick) || 6)
  const allTopics = (L.topic?.enabled ? (L.topic.items || []) : [])
    .concat((L.at?.enabled ? (L.at.items || []) : []))
  const topicItems = allTopics.slice(0, capTopics)
  if (allTopics.length > topicItems.length) {
    log('[topic] 本轮只读前 ' + topicItems.length + ' 帖（上限 maxTopicsPerTick=' + capTopics + '，共 ' + allTopics.length + ' 帖在列）')
  }
  const seenTopic = new Set()
  for (const item of topicItems) {
    if (!item?.id || seenTopic.has(String(item.id))) continue
    seenTopic.add(String(item.id))
    const src = (L.topic?.items || []).some((x) => String(x.id) === String(item.id)) ? 'topic' : 'at'
    const j = await topicDetail(item.id, { sort: 2 })
    if (j.code !== 100) { log('[topic] ' + item.id + ' 读失败 ' + j.code + ' ' + (j.msg || '')); continue }
    const topic = j.result?.topic || {}
    const replies = j.result?.reply || []
    const wantFloors = src === 'topic' ? L.topic?.floors !== false : true
    const wantComments = src === 'topic' ? L.topic?.comments !== false : true

    if (wantFloors) {
      for (const r of replies) {
        out.push({
          source: src, kind: 'floor',
          sectionId: String(topic.sid || ''), sectionTitle: topic.section?.title || '',
          topicId: String(item.id), topicTitle: topic.title || '',
          floorId: String(r.id), position: r.position,
          uid: String(r.uid), nickname: r.user?.nickname || r.uid,
          content: r.content || '', timeStr: r.time_str || '',
          topic, replies,
        })
      }
    }
    if (wantComments) {
      for (const r of replies) {
        for (const c of (r.comment?.info || [])) {
          out.push({
            source: src, kind: 'comment',
            sectionId: String(topic.sid || ''), sectionTitle: topic.section?.title || '',
            topicId: String(item.id), topicTitle: topic.title || '',
            floorId: String(r.id), commentId: String(c.id), position: r.position,
            uid: String(c.uid), nickname: c.user?.nickname || c.uid,
            content: c.content || '', timeStr: c.time_str || '',
            topic, replies,
          })
        }
      }
    }
    log('[topic] ' + (topic.title || item.id) + ' 楼层 ' + replies.length + '，楼中楼 ' + replies.reduce((n, r) => n + (r.comment?.info?.length || 0), 0))
  }

  return out
}

/**
 * 判定一条候选要不要回。
 * @returns {{action:'reply'|'skip', why:string, via?:string}}
 */
export function evaluate(cfg, cand, me) {
  const L = cfg.listen || {}
  const ownerUid = String(cfg.owner?.uid || '')

  if (!cand.uid || String(cand.uid) === String(me.uid)) return { action: 'skip', why: 'self' }
  if (cand.source === 'atme' && L.atme?.enabled === false) return { action: 'skip', why: 'atme-off' }

  // 触发条件只有一个：内容里 @ 我。作者是大号不等于叫我，不能凭这个就回。
  // atme 源例外：平台的通知本身就是「有人 @ 了你」，再拿正文匹配一遍反而会被
  // triggerMode='plain'（只认文字 @）挡掉 —— 富文本里的 @ 是 <kb-contact> 标签，不是字面 @。
  const isNotice = cand.source === 'atme'
  const trig = isNotice ? { hit: true, via: 'notice' } : matchTrigger(cand.content, me, cfg.listen?.triggerMode)
  if (!trig.hit) return { action: 'skip', why: 'no-trigger' }
  const byOwner = ownerUid && String(cand.uid) === ownerUid

  // 内容本身的筛选（板块 / 帖子）先过一遍，避免对不想看的地方做任何动作
  const group = L[cand.source] || {}

  // 主人 @ 我 一律放行：不用加好友、不用进白名单
  if (byOwner) return { action: 'reply', why: 'owner', via: trig.via || null }

  // 其他人 @ 我 还要再过一道 at 的名单与范围限制
  if (L.at?.enabled) {
    const fa = makeFilter(L.at)
    const u = fa.user(cand.uid, cand.nickname)
    if (!u.ok) return { action: 'skip', why: 'at-' + u.why }
    const f = fa.forum(cand.sectionId, cand.sectionTitle)
    if (!f.ok) return { action: 'skip', why: 'at-' + f.why }
    const t = fa.topic(cand.topicId)
    if (!t.ok) return { action: 'skip', why: 'at-' + t.why }
    // at.items / at.forums 非空 = 只在这些范围里应 @
    // at.items 对 atme 不生效：那个清单是「额外要盯的帖子」，而通知本身已经是全站的 @。
    if (!isNotice && (L.at.items || []).length && !L.at.items.some((x) => String(x.id) === String(cand.topicId))) {
      return { action: 'skip', why: 'at-topic-not-allowed' }
    }
    if ((L.at.forums || []).length && !L.at.forums.some((x) => String(x.id) === String(cand.sectionId))) {
      return { action: 'skip', why: 'at-forum-not-allowed' }
    }
  }

  // 源自己的名单
  const fs = makeFilter(group)
  const su = fs.user(cand.uid, cand.nickname)
  if (!su.ok) return { action: 'skip', why: cand.source + '-' + su.why }
  const sf = fs.forum(cand.sectionId, cand.sectionTitle)
  if (!sf.ok) return { action: 'skip', why: cand.source + '-' + sf.why }
  const st = fs.topic(cand.topicId)
  if (!st.ok) return { action: 'skip', why: cand.source + '-' + st.why }

  return { action: 'reply', why: 'at', via: trig.via || null }
}

/** 在哪些时间窗内允许干活。allDay=true 时永远允许。 */
export function inWindow(cfg, now = new Date()) {
  const L = cfg.listen || {}
  if (L.allDay !== false) return true
  const mins = now.getHours() * 60 + now.getMinutes()
  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  for (const w of L.windows || []) {
    const a = toMin(w.start)
    const b = toMin(w.end) === 0 ? 1440 : toMin(w.end)
    if (a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b)) return true
  }
  return false
}

/**
 * 跑一轮。dryRun=true 时只打印打算做什么，不发任何写请求。
 * @returns {Promise<{scanned:number, replied:number, skipped:number, bootstrapped:boolean}>}
 */
export async function tick(cfg, { dryRun = false, log = console.log } = {}) {
  const seen = loadSeen()
  const me = { uid: cfg.self?.uid || '', nickname: cfg.self?.name || '' }
  const stats = { scanned: 0, replied: 0, skipped: 0, bootstrapped: false, blocked: null }

  if (!inWindow(cfg)) { log('[watch] 不在时间窗内，跳过本轮'); return stats }

  // 没有 Pauth 就没有写权限：读帖能跑，发出去一律 5001。
  // 与其每轮都发一遍再失败，不如在入口就停下来说清楚（dryRun 仍然放行，方便预览）。
  if (!dryRun) {
    const miss = missingForWrite(loadCred())
    if (miss.length) {
      log('[watch] 写权限缺失：' + miss.join('、') + ' —— 本轮只登记不发送。去设置页扫码登录一次再开监听')
      stats.blocked = 'no-pauth'
      return stats
    }
  }

  const cands = await collect(cfg, { log })
  stats.scanned = cands.length

  // 首次扫描：只登记，不回复（dry-run 不登记，预览不能改变真实状态）
  const primed = seen.__primed === true
  if (!primed && !dryRun) {
    for (const c of cands) markReply(seen, keyOf(c), { boot: true })
    seen.__primed = true
    seen.__primedAt = Date.now()
    saveSeen(seen)
    stats.bootstrapped = true
    log('[watch] 首次扫描，登记 ' + cands.length + ' 条历史内容，不回复')
    return stats
  }

  const cap = Math.max(1, Number(cfg.listen?.maxRepliesPerTick) || 3)
  const repliedTopics = new Set()

  for (const c of cands) {
    if (stats.replied >= cap) { log('[watch] 本轮已达上限 ' + cap + ' 条，剩下的下轮再说'); break }
    // 同一帖一轮只回一条：两个楼层都 @ 我时，发两遍几乎一样的回复等于刷屏
    if (repliedTopics.has(String(c.topicId))) {
      if (!dryRun) markReply(seen, keyOf(c), { skip: 'same-topic-this-tick' })
      stats.skipped++
      continue
    }
    const k = keyOf(c)
    if (seenReply(seen, k)) continue
    const ev = evaluate(cfg, c, me)
    if (ev.action === 'skip') {
      if (!dryRun) markReply(seen, k, { skip: ev.why })
      stats.skipped++
      continue
    }
    const who = c.nickname || c.uid
    const text = strip(c.content)
    const where = c.kind === 'topic'
      ? ('新帖 ' + c.topicId)
      : (c.topicId + ' ' + (c.position ? (String(c.position).endsWith('楼') ? c.position : c.position + '楼') : (c.floorId + '楼')))
    log('[hit/' + ev.why + (ev.via ? '/' + ev.via : '') + '] ' + where + ' ' + who + '：' + text.slice(0, 60))

    if (cfg.listen.oncePerPerson && seenPerson(seen, c.uid)) {
      log('  [skip] ' + who + ' 冷却期内已回过')
      if (!dryRun) markReply(seen, k, { skip: 'person-cooldown' })
      stats.skipped++
      continue
    }

    let reply
    try {
      // 对方是让我「总结 / 说说这帖讲了啥」→ 真总结，不是敷衍一句
      if (WANT_SUMMARY.test(text)) {
        reply = await chat(replySummaryPrompt(
          c.topic || { id: c.topicId, title: c.topicTitle, content: '' },
          c.replies || [],
          cfg.persona,
        ), { maxTokens: 400, temperature: 0.5 })
        reply = applySuffix(toPostText(reply), { suffix: cfg.prompt?.suffix, max: 900, sep: '\n' })
      } else {
        reply = await chat(replyPrompt({
          topic: c.topic || { id: c.topicId, title: c.topicTitle, content: '' },
          floors: c.replies || [],
          trigger: { nickname: who, uid: c.uid },
          persona: cfg.persona,
          triggerText: text,
        }), { maxTokens: cfg.ai?.maxTokens ? Math.min(300, cfg.ai.maxTokens) : 300 })
        reply = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        reply = applySuffix(reply, { suffix: cfg.prompt?.suffix, max: 200 })
      }
    } catch (e) { log('  [ai] ' + e.message); continue }
    if (!reply) { log('  [ai] 空回复，跳过'); continue }

    if (dryRun) {
      log('  [dry-run] 会回复：' + reply)
      repliedTopics.add(String(c.topicId))
      stats.replied++
      continue
    }

    let out
    if (c.kind === 'topic') {
      out = await replyOperate({ tid: c.topicId, content: reply, type: 3, state: 1 })
    } else {
      out = await commentOperate({ fid: c.sectionId, replyId: c.floorId, commentId: 0, content: reply })
    }

    if (out.code === 100) {
      log('  ✓ 已回复：' + reply)
      audit({ action: 'auto-' + c.kind, topicId: c.topicId, floorId: c.floorId || null, triggerUid: c.uid, via: ev.why, text: reply, ok: true })
      markReply(seen, k, { replied: true })
      repliedTopics.add(String(c.topicId))
      markPerson(seen, c.uid, { nickname: who })
      saveSeen(seen)
      stats.replied++
    } else {
      log('  ✗ ' + out.code + ' ' + (out.msg || ''))
      audit({ action: 'auto-' + c.kind, topicId: c.topicId, floorId: c.floorId || null, ok: false, code: out.code, msg: out.msg })
      markReply(seen, k, { fail: out.code })
    }
  }

  if (!dryRun) saveSeen(seen)
  return stats
}

/** 清掉 bootstrap 标记，下次 tick 会重新登记（改了监听范围后用它，避免把旧内容当新内容回）。 */
export function resetPrimed() {
  const seen = loadSeen()
  delete seen.__primed
  delete seen.__primedAt
  saveSeen(seen)
}

/**
 * 忘掉某帖的全部去重记录：改监听范围或想让旧内容重新可回时用。
 * 只动这一帖的键，别的地方的记录不受影响。
 */
export function forgetTopics(topicIds) {
  const seen = loadSeen()
  const ids = new Set((topicIds || []).map(String).filter(Boolean))
  if (!ids.size) return 0
  let n = 0
  for (const k of Object.keys(seen.replies || {})) {
    // 键格式见 keyOf：t:<topicId>（整帖）/ f:<topicId>:<floorId> / c:<topicId>:<commentId>。
    // b:<topicId> 是刷帖日报的标记、r:<topicId> 是日报回帖标记，都不属于监听记录，别误删。
    const parts = String(k).split(':')
    if (!LISTEN_KEY_PREFIX.has(parts[0]) || parts.length < 2) continue
    if (ids.has(String(parts[1]))) { delete seen.replies[k]; n++ }
  }
  saveSeen(seen)
  return n
}

/**
 * 监听范围变了（换了帖子/板块）就忘掉旧帖的去重记录，
 * 否则那些帖永远标着"已回"，改配置等于没改。
 * 返回被清掉的键数。
 */
export function syncScope(cfg, prevCfg) {
  const now = scopeTopics(cfg)
  const before = scopeTopics(prevCfg || {})
  const dropped = before.filter((id) => !now.includes(id))
  if (!dropped.length) return 0
  return forgetTopics(dropped)
}

/** 当前配置扫到的所有帖子 id（用于 forgetTopics 定范围）。 */
export function scopeTopics(cfg) {
  const L = cfg.listen || {}
  const ids = []
  if (L.topic?.enabled) for (const x of L.topic.items || []) ids.push(String(x.id))
  if (L.at?.enabled) for (const x of L.at.items || []) ids.push(String(x.id))
  return Array.from(new Set(ids.filter(Boolean)))
}
