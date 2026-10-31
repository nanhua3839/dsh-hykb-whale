// 发帖层：把一轮日报整理成一篇论坛帖，发到指定板块。
//
// 日报本身由 digest.mjs 生成（Markdown）；这里负责：
//   · 文末「原帖链接」清单（代码拼，不让模型编链接）
//   · Markdown → 快爆编辑器的 HTML（只有 div / h2 / b / br，平台没有 <a>，链接是纯文本）
//   · 标题模板、每日上限、发帖台账 ~/.hykb-ai/posts.json
// 真正的网络调用是 hykb-api.mjs 的 setThread，写预算 / 写冷却由 traffic.mjs 把关。
import fs from 'node:fs'
import { setThread } from './hykb-api.mjs'
import { loadCred, missingForWrite, CODE_HINTS } from './cred.mjs'
import { threadUrl, applySuffix } from './ai.mjs'
import { audit } from './state.mjs'
import { postLogPath, credDir, ensureDir, harden } from './paths.mjs'

export const TITLE_MAX = 48

/** 文末原帖清单。每帖一行：序号 + 标题 + 链接。 */
export function linksTail(picks) {
  const rows = (picks || []).filter((p) => p && p.topicId)
  if (!rows.length) return ''
  return ['## 原帖链接', ...rows.map((p, i) => (i + 1) + '. ' + (p.title || '(无标题)') + ' ' + threadUrl(p.topicId))].join('\n')
}

/** 标题模板：{date} 换成日期；超过平台上限就截断。 */
export function postTitle(tpl, { date } = {}) {
  const t = String(tpl || '').trim() || '快爆论坛日报 {date}'
  return t.replace(/\{date\}/g, date || '').trim().slice(0, TITLE_MAX)
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

/**
 * 日报 Markdown → 快爆编辑器 HTML。
 * 第一行的「# 标题」丢掉（标题单独走 title 字段）；## / ### → h2；**粗体** → b；
 * 其余每行一个 <div>，空行 <div><br></div>（编辑器自己就是这么存的）。HTML 注释一律去掉。
 */
export function toThreadHtml(md) {
  const lines = String(md || '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  while (lines.length && !lines[0].trim()) lines.shift()
  if (lines.length && /^#\s/.test(lines[0])) lines.shift()
  const out = []
  let blank = true
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { if (!blank) out.push('<div><br></div>'); blank = true; continue }
    blank = false
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) { out.push('<h2>' + inline(h[1]) + '</h2>'); continue }
    const q = /^>\s?(.*)$/.exec(line)
    out.push('<div>' + inline(q ? q[1] : line) + '</div>')
  }
  while (out.length && out[out.length - 1] === '<div><br></div>') out.pop()
  return out.join('')
}

/** 帖子正文（Markdown）：日报 + 原帖链接 + 固定后缀。 */
export function postMarkdown(body, picks, cfg) {
  const P = cfg?.post || {}
  let md = String(body || '').trim()
  // 骨架日报每帖已经自带「- 链接：」，再拼一份清单就重复了
  const hasAll = (picks || []).every((p) => !p.topicId || md.includes(threadUrl(p.topicId)) || md.includes('thread-' + p.topicId + '.htm'))
  if (P.links !== false && !hasAll) md += '\n\n' + linksTail(picks)
  return applySuffix(md, { suffix: cfg?.prompt?.suffix, sep: '\n\n' })
}

/* ---------------- 台账 ---------------- */

export function loadPostLog() {
  try {
    const j = JSON.parse(fs.readFileSync(postLogPath(), 'utf8'))
    return Array.isArray(j) ? j : []
  } catch { return [] }
}

function savePostLog(list) {
  ensureDir(credDir())
  const file = postLogPath()
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-200), null, 2))
  fs.renameSync(tmp, file)
  try { harden(file) } catch {}
}

export const postedToday = (date, log = loadPostLog()) => log.filter((x) => x.ok && x.date === date).length

/**
 * 把一份日报发成帖子。
 * @param {object} o
 * @param {string} o.body   日报 Markdown
 * @param {Array}  o.picks  选中的帖（要 topicId / title）
 * @param {object} o.cfg
 * @param {string} o.date
 * @param {boolean} [o.dryRun]  只拼好不发
 * @param {boolean} [o.force]   手动「现在发一篇」：不看 post.enabled 和 minPicks，但每日上限照样算
 * @returns {Promise<{status:'posted'|'preview'|'skipped'|'failed', reason?:string, title?:string, section?:object, code?:number, msg?:string, html?:string, markdown?:string}>}
 */
export async function publishDigest({ body, picks, cfg, date, dryRun = false, force = false, log = () => {} }) {
  const P = cfg?.post || {}
  if (!force && !P.enabled) return { status: 'skipped', reason: '发帖没开' }
  const sec = P.section && P.section.id ? { id: String(P.section.id), title: String(P.section.title || '') } : null
  if (!sec) return { status: 'skipped', reason: '还没选发到哪个板块' }
  const minPicks = Math.max(1, Number(P.minPicks) || 1)
  if (!force && (picks || []).length < minPicks) return { status: 'skipped', reason: '只选到 ' + (picks || []).length + ' 帖，不到 ' + minPicks + ' 帖不发' }

  const markdown = postMarkdown(body, picks, cfg)
  let title = postTitle(P.title, { date })
  const html = toThreadHtml(markdown)
  if (!html) return { status: 'skipped', reason: '日报是空的' }

  const book = loadPostLog()
  const done = postedToday(date, book)
  const cap = Math.max(1, Number(P.maxPerDay) || 1)
  if (done >= cap) return { status: 'skipped', reason: '今天已经发了 ' + done + ' 篇（上限 ' + cap + '）', title, section: sec }
  if (done > 0) title = (title + ' · ' + (done + 1)).slice(0, TITLE_MAX)

  if (dryRun) {
    log('[post] [dry-run] 会发到「' + (sec.title || sec.id) + '」：' + title)
    return { status: 'preview', title, section: sec, html, markdown }
  }

  let cred
  try { cred = loadCred() } catch { return { status: 'failed', reason: '还没登录快爆', title, section: sec } }
  const miss = missingForWrite(cred)
  if (miss.length) return { status: 'failed', reason: '登录态不能发帖：缺 ' + miss.join('、'), title, section: sec }

  let out
  try { out = await setThread({ fid: sec.id, title, content: html }) }
  catch (e) {
    log('[post] 发帖被拦：' + e.message)
    audit({ action: 'post', fid: sec.id, title, ok: false, msg: e.message })
    return { status: 'failed', reason: e.message, title, section: sec }
  }
  const ok = out && out.code === 100
  const msg = String(out?.msg || CODE_HINTS[out?.code] || '')
  book.push({ at: new Date().toISOString(), date, fid: sec.id, section: sec.title, title, ok, code: out?.code, msg, picks: (picks || []).map((p) => p.topicId) })
  savePostLog(book)
  audit({ action: 'post', fid: sec.id, title, ok, code: out?.code, msg })
  if (ok) {
    log('[post] ✓ 发到「' + (sec.title || sec.id) + '」：' + title)
    return { status: 'posted', title, section: sec, code: 100, msg, html, markdown }
  }
  log('[post] ✗ code=' + out?.code + ' ' + msg)
  return { status: 'failed', reason: msg || ('code=' + out?.code), code: out?.code, title, section: sec, markdown }
}
