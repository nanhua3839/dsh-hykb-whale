// 日报层：扫板块 → 打分排序 → 深读前几帖 → 写日报落盘 →（可选）对高分帖回帖。
//
// 这是「自动刷论坛」的落点。watch.mjs 负责被动回 @，browse.mjs 负责主动选题，
// 这里把两者串成一轮完整动作，产出一份人能读的日报。
import fs from 'node:fs'
import path from 'node:path'
import { gather, rank, score, markPicked, fallbackDigest } from './browse.mjs'
import { topicDetail, replyOperate } from './hykb-api.mjs'
import { chat, aiReady, digestPrompt, browseReplyPrompt, topicGistPrompt, applySuffix } from './ai.mjs'
import { publishDigest, linksTail } from './post.mjs'
import { loadSeen, saveSeen, seenReply, markReply, audit } from './state.mjs'
import { digestDir, digestPath, ensureDir } from './paths.mjs'

const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const today = (now = new Date()) => now.toLocaleDateString('sv-SE')

/** 深读一帖：拿楼层，压成日报能用的摘要。读失败不致命，返回 null。 */
async function deepRead(topicId, { maxFloors = 12 } = {}) {
  try {
    const j = await topicDetail(topicId, { sort: 2 })
    if (j.code !== 100) return null
    const t = j.result?.topic || {}
    const replies = j.result?.reply || []
    return {
      topic: t,
      floors: replies.slice(0, maxFloors).map((r) => ({
        nickname: r.user?.nickname || String(r.uid || ''),
        uid: String(r.uid || ''),
        content: strip(r.content),
        position: r.position,
      })),
      replyCount: replies.length,
    }
  } catch { return null }
}

/**
 * 跑一轮刷帖。
 * @returns {Promise<{date:string, scanned:number, picked:Array, file:string, text:string, replied:number, dryRun:boolean}>}
 */
export async function runDigest(cfg, { dryRun = false, log = () => {}, now = new Date(), forcePost = false } = {}) {
  const B = cfg.browse || {}
  const date = today(now)
  const stats = { date, scanned: 0, picked: [], file: '', text: '', replied: 0, dryRun, post: null }

  const cands = await gather(cfg, { log })
  stats.scanned = cands.length
  if (!cands.length) { log('[digest] 没扫到帖子（板块为空或被名单全过滤）'); return stats }

  const seen = loadSeen()
  const { picks, ranked } = rank(cfg, cands, { now: now.getTime(), seen })
  if (!picks.length) { log('[digest] 打分后没有新帖可写（都进过日报或低于 minScore）'); return stats }

  // 深读前几帖：先逐帖压成一句速读，再拿速读合成日报。
  // 直接把原始楼层塞进综述 prompt 会让模型跟着楼层的重复 emoji 退化成乱码，所以分两段。
  const deep = Math.min(picks.length, Math.max(1, Number(B.deep) || 3))
  // 深读楼层上限走 summary.maxComments：之前这里固定 12 层，配置项等于不存在。
  const maxFloors = Math.max(1, Number(cfg.summary?.maxComments) || 12)
  for (let i = 0; i < picks.length; i++) {
    if (i >= deep) continue
    const d = await deepRead(picks[i].topicId, { maxFloors })
    if (!d) continue
    picks[i].floors = d.floors
    if (!picks[i].content && d.topic.content) picks[i].content = strip(d.topic.content).slice(0, 600)
    if (!aiReady()) continue
    try {
      picks[i].gist = await chat(topicGistPrompt(d.topic, d.floors), { maxTokens: 260, temperature: 0.3 })
    } catch (e) { log('[digest] 速读失败 ' + picks[i].topicId + '：' + e.message) }
  }

  let body = ''
  if (aiReady()) {
    try {
      body = await chat(digestPrompt({
        picks,
        persona: cfg.persona,
        date,
        style: cfg.summary?.style,
      }), { maxTokens: 1600, temperature: 0.4 })
    } catch (e) {
      log('[digest] AI 综述失败，退回骨架日报：' + e.message)
    }
  } else {
    log('[digest] AI 未配置，写骨架日报')
  }
  if (!body) body = fallbackDigest(picks, { date, note: aiReady() ? 'AI 综述失败，这是原始清单' : 'AI 未配置，这是原始清单' })
  // 原帖链接由代码拼：模型写的链接不可信，也可能漏。骨架日报每帖已带链接，就不重复。
  else if (cfg.post?.links !== false) body = String(body).trim() + '\n\n' + linksTail(picks)

  stats.text = body
  stats.picked = picks.map((p) => ({ topicId: p.topicId, title: p.title, score: p.score, sectionTitle: p.sectionTitle }))
  // 落盘：同一天多轮是追加，不覆盖。dry-run 一律不写文件——「不真发」不该产出半份日报。
  if (dryRun) {
    log('[digest] [dry-run] 备好 ' + picks.length + ' 帖的日报（不写文件、不进已读）')
  } else {
    ensureDir(digestDir())
    const file = digestPath(date)
    const head = '\n<!-- ' + new Date().toISOString() + ' · 扫 ' + stats.scanned + ' 帖 · 选 ' + picks.length + ' 帖 -->\n'
    const block = (fs.existsSync(file) ? head : '# 好游快爆 · 日报 ' + date + '\n') + '\n' + body + '\n'
    fs.appendFileSync(file, block)
    stats.file = file
    log('[digest] 写了 ' + picks.length + ' 帖 → ' + file)
  }

  // 发帖：日报原样发成一篇新帖。放在自动回帖前面——写冷却期间后面的回帖会被拦，主产物优先。
  if (forcePost || cfg.post?.enabled) {
    try {
      stats.post = await publishDigest({ body, picks, cfg, date, dryRun, force: forcePost, log })
    } catch (e) {
      stats.post = { status: 'failed', reason: e.message }
    }
    if (stats.post.status === 'skipped') log('[post] 没发：' + stats.post.reason)
    else if (stats.post.status === 'failed') log('[post] 发帖失败：' + stats.post.reason)
  }

  // 自动回帖：只对过线的高分帖，且受写预算与写冷却约束（traffic.mjs 会把关）
  const maxReply = Math.max(0, Number(B.replyMax) || 0)
  if (B.autoReply && maxReply > 0) {
    const minScore = Number(B.replyMinScore) || 0
    const targets = picks.filter((p) => p.score >= minScore).slice(0, maxReply)
    for (const p of targets) {
      if (seenReply(seen, 'r:' + p.topicId)) continue
      let text = ''
      try {
        const d = await deepRead(p.topicId, { maxFloors: 8 })
        const floors = d?.floors || []
        let gist = ''
        if (aiReady()) {
          try { gist = await chat(topicGistPrompt(d?.topic || p, floors), { maxTokens: 220, temperature: 0.3 }) } catch {}
        }
        text = await chat(browseReplyPrompt({
          topic: d?.topic || { title: p.title, content: p.content },
          floors,
          persona: cfg.persona,
          gist,
        }), { maxTokens: 200 })
      } catch (e) { log('[digest] 生成回帖失败 ' + p.topicId + '：' + e.message); continue }
      text = applySuffix(strip(text).slice(0, 200), { suffix: cfg.prompt?.suffix, max: 200 })
      if (!text) continue
      if (dryRun) {
        log('[digest] [dry-run] 会回 ' + p.topicId + '：' + text)
        continue
      }
      let out
      try { out = await replyOperate({ tid: p.topicId, content: text, type: 3, state: 1 }) }
      catch (e) { log('[digest] 回帖被拦 ' + p.topicId + '：' + e.message); audit({ action: 'browse-reply', topicId: p.topicId, ok: false, msg: e.message }); continue }
      if (out.code === 100) {
        log('[digest] ✓ 回了 ' + p.topicId + '：' + text)
        audit({ action: 'browse-reply', topicId: p.topicId, score: p.score, text, ok: true })
        markReply(seen, 'r:' + p.topicId, { replied: true })
        stats.replied++
      } else {
        log('[digest] ✗ ' + p.topicId + ' code=' + out.code + ' ' + (out.msg || ''))
        audit({ action: 'browse-reply', topicId: p.topicId, ok: false, code: out.code, msg: out.msg })
        markReply(seen, 'r:' + p.topicId, { fail: out.code })
      }
    }
  }

  // 只有真跑才把「这批帖已进日报」写进 seen。dry-run 写进去会让当天的候选池被永久跳过。
  if (!dryRun) {
    markPicked(seen, picks)
    saveSeen(seen)
  }
  return stats
}

/** 只读一遍：不落盘、不回帖，给设置页「现在试试」和 CLI browse --dry 用。 */
export async function previewDigest(cfg, { log = () => {}, now = new Date(), limit } = {}) {
  const cands = await gather(cfg, { log })
  const { picks, ranked } = rank(cfg, cands, { now: now.getTime(), seen: loadSeen(), fresh: false })
  const n = Math.max(1, Number(limit) || Number(cfg.browse?.pick) || 8)
  return {
    scanned: cands.length,
    top: ranked.slice(0, n).map((x) => ({
      topicId: x.topicId, title: x.title, sectionTitle: x.sectionTitle,
      score: x.score, replyCount: x.replyCount, upVote: x.upVote, timeStr: x.timeStr,
    })),
    picks: picks.slice(0, n).map((x) => ({ topicId: x.topicId, title: x.title, score: x.score })),
  }
}
