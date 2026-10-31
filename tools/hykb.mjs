#!/usr/bin/env node
// 好游快爆 · AI 小号 —— 命令行入口
//
//   hykb.mjs login                扫码登录（打印二维码块字符 + 存 cookie）
//   hykb.mjs whoami               打印当前登录账号
//   hykb.mjs read <topicId>       读帖子（标题 + 楼层）
//   hykb.mjs reply <topicId> <文本>   发主回复
//   hykb.mjs comment <topicId> <楼层id> <文本>   楼中楼
//   hykb.mjs del <楼层id>         删自己的楼层
//   hykb.mjs summary <topicId>     AI 总结
//   hykb.mjs listen               常驻监听（大号@小号 → AI 回复）
//   hykb.mjs traffic              看限流状态
import { createRequire } from 'node:module'
import { loadCred, missingForWrite, writeFailText, cookieHeader } from './lib/cred.mjs'
import { config, writeConfig, configPath } from './lib/config.mjs'
import { login } from './lib/login.mjs'
import { topicDetail, replyOperate, commentOperate, msgInfo, topicPage } from './lib/hykb-api.mjs'
import { chat, aiReady, summarizePrompt, replyPrompt } from './lib/ai.mjs'
import { trafficState } from './lib/traffic.mjs'
import { audit } from './lib/state.mjs'
import { tick as watchTick, resetPrimed, inWindow } from './lib/watch.mjs'
import { sectionTopics, sectionCatalog, parseSectionId, parseTopicId } from './lib/forum.mjs'
import { previewDigest, runDigest } from './lib/digest.mjs'
import { resolveSections } from './lib/browse.mjs'
import { digestPath, digestDir } from './lib/paths.mjs'

const [cmd, ...args] = process.argv.slice(2)
const fail = (m) => { console.error('✗ ' + m); process.exit(1) }
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/* ─────────── 二维码块字符 ─────────── */
const requireLocal = createRequire(import.meta.url)

function qrBlock(content) {
  let QR
  // 本地没装 qrcode 就退回只打印内容串，不阻断登录
  try { QR = requireLocal('qrcode') } catch { return null }
  const q = QR.create(content, { errorCorrectionLevel: 'L' })
  const n = q.modules.size
  const g = (r, c) => (r >= 0 && r < n && c >= 0 && c < n) ? q.modules.data[r * n + c] : 0
  const Q = 2, rows = []
  for (let r = -Q; r < n + Q; r += 2) {
    let line = ''
    for (let c = -Q; c < n + Q; c++) {
      const t = g(r, c), b = g(r + 1, c)
      line += t && b ? '██' : t ? '▀▀' : b ? '▄▄' : '  '
    }
    rows.push(line)
  }
  return rows
}

/* ─────────── 子命令 ─────────── */
async function cmdLogin() {
  const r = await login({
    onQr: (c) => {
      console.log('二维码内容：' + c)
      const rows = qrBlock(c)
      if (rows) { console.log(''); rows.forEach((x) => console.log(x)); console.log('') }
      console.log('用快爆 APP 扫码 → 手机上确认。' + (rows ? '' : '（本地没装 qrcode 包，只能看到上面的内容串）'))
    },
    onPhase: (p) => console.log('  状态：' + p),
    timeoutSec: 300,
  })
  console.log('✓ 登录成功 uid=' + r.uid + ' nickname=' + r.nickname)
  console.log('  cookie 已存：' + '~/.hykb-ai/credentials.json')
}

async function cmdWhoami() {
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、') + '（重跑 login）')
  const m = await msgInfo()
  console.log('uid=' + c.uid + '  nickname=' + c.nickname)
  console.log('未读：' + JSON.stringify(m.data || m))
}

async function cmdRead() {
  const topicId = args[0] || fail('用法：hykb.mjs read <topicId>')
  const j = await topicDetail(topicId, { sort: 1 })
  if (j.code !== 100) fail('读帖子失败：' + JSON.stringify(j).slice(0, 200))
  const t = j.result.topic
  console.log('标题：' + t.title)
  console.log('作者：' + (t.user?.nickname || t.uid) + '　板块：' + (t.section?.title || t.sid) + '　回复：' + t.reply_count)
  console.log('正文：' + strip(t.content).slice(0, 400))
  const rl = j.result.reply || []
  console.log('--- 楼层（' + rl.length + '）---')
  for (const r of rl) {
    console.log(r.position + ' [' + r.id + '] ' + (r.user?.nickname || r.uid) + '：' + strip(r.content).slice(0, 80))
  }
}

async function cmdReply() {
  const topicId = args[0] || fail('用法：hykb.mjs reply <topicId> <文本>')
  const text = args.slice(1).join(' ')
  if (!text) fail('缺文本')
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、'))
  const j = await replyOperate({ tid: topicId, content: text, type: 3, state: 1 })
  if (j.code !== 100) fail(writeFailText(j.code, j.msg))
  audit({ action: 'reply', topicId, ok: true })
  console.log('✓ ' + j.msg)
}

async function cmdComment() {
  const topicId = args[0], floorId = args[1], text = args.slice(2).join(' ')
  if (!topicId || !floorId || !text) fail('用法：hykb.mjs comment <topicId> <楼层id> <文本>')
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、'))
  const jd = await topicDetail(topicId, { sort: 1 })
  if (jd.code !== 100) fail('拿不到帖子的 fid：' + JSON.stringify(jd).slice(0, 150))
  const fid = jd.result.topic.sid
  const j = await commentOperate({ fid, replyId: floorId, commentId: 0, content: text })
  if (j.code !== 100) fail(writeFailText(j.code, j.msg))
  audit({ action: 'comment', topicId, floorId, ok: true })
  console.log('✓ ' + j.msg)
}

async function cmdDel() {
  const floorId = args[0] || fail('用法：hykb.mjs del <楼层id>')
  const tid = args[1]
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、'))
  const j = await replyOperate({ tid: tid || 0, replyId: floorId, type: 4, state: 1 })
  if (j.code !== 100) fail(writeFailText(j.code, j.msg))
  audit({ action: 'delete', floorId, ok: true })
  console.log('✓ ' + j.msg)
}

async function cmdSummary() {
  const topicId = args[0] || fail('用法：hykb.mjs summary <topicId>')
  if (!aiReady()) fail('AI 未配置：去设置页填 baseUrl / model / apiKey')
  const j = await topicDetail(topicId, { sort: 2 })
  if (j.code !== 100) fail('读帖子失败：' + JSON.stringify(j).slice(0, 150))
  const t = j.result.topic
  const rl = (j.result.reply || []).map((r) => ({ ...r, user: r.user || { nickname: r.uid } }))
  console.log('【' + t.title + '】共 ' + rl.length + ' 层\n')
  // 楼层上限跟着配置走：这帖几百层时不能让一次总结把读额度和 token 全吃掉。
  const maxFloors = config().summary?.maxComments ?? 60
  const out = await chat(summarizePrompt(t, rl, { maxFloors }), { maxTokens: 900 })
  console.log(out)
}

async function cmdTraffic() {
  const s = trafficState()
  console.log('读：本小时 ' + s.readHour + '　今天 ' + s.readDay)
  const gap = s.lastWriteAt ? Math.max(0, Math.round((Date.now() - s.lastWriteAt) / 1000)) : -1
  console.log('写：本小时 ' + s.writeHour + '　今天 ' + s.writeDay + '　' + (gap < 0 ? '冷却 无（还没写过）' : '上次写 ' + gap + 's 前'))
  if (s.pausedForSec) console.log('⚠ 风控暂停中，还需 ' + s.pausedForSec + ' 秒')
}

function describeSources(cfg) {
  const L = cfg.listen
  const parts = []
  if (L.forum?.enabled) parts.push('论坛[' + (L.forum.items || []).map((x) => x.title || x.id).join(',') + ']')
  if (L.topic?.enabled) parts.push('帖子[' + (L.topic.items || []).map((x) => x.title || x.id).join(',') + ']')
  if (L.at?.enabled) parts.push('@我')
  return parts.length ? parts.join(' + ') : '（没有启用任何监听源）'
}

async function cmdListen() {
  const cfg = config()
  const dryRun = args.includes('--dry-run')
  const once = args.includes('--once')
  if (!aiReady()) fail('AI 未配置：去设置页填 baseUrl / model / apiKey')
  const src = describeSources(cfg)
  if (src.startsWith('（')) fail('没有启用任何监听源：去设置页勾选「监听论坛 / 监听帖子 / 有人@我」')
  console.log('[listen] ' + src + '  间隔=' + cfg.listen.intervalSec + 's  我的 uid=' + loadCred().uid + (dryRun ? '  [dry-run]' : ''))
  for (;;) {
    try {
      const s = await watchTick(cfg, { dryRun })
      if (s.bootstrapped) console.log('[listen] 已登记历史内容，下一轮开始真正监听')
      else if (s.scanned) console.log('[listen] 扫 ' + s.scanned + ' 条，回 ' + s.replied + '，跳过 ' + s.skipped)
    } catch (e) { console.error('[listen] ' + e.message) }
    if (once) return
    await new Promise((r) => setTimeout(r, Math.max(20, cfg.listen.intervalSec) * 1000))
  }
}

async function cmdWatch() {
  // watch：手动跑一轮，默认 dry-run，确认没问题再加 --send
  const cfg = config()
  const send = args.includes('--send')
  const reset = args.includes('--reset')
  if (reset) { resetPrimed(); console.log('已清空 bootstrap 标记，下一轮会重新登记历史内容') }
  const s = await watchTick(cfg, { dryRun: !send })
  console.log('\n扫到 ' + s.scanned + ' 条，回复 ' + s.replied + ' 条，跳过 ' + s.skipped + ' 条' + (s.bootstrapped ? '（首次扫描，只登记）' : '') + (send ? '' : '（dry-run，未真发）'))
}

async function cmdForum() {
  const sub = args[0]
  if (sub === 'list' || !sub) {
    const r = await sectionCatalog()
    if (r.code !== 100) fail('拉板块目录失败：' + r.msg)
    console.log('共 ' + r.sections.length + ' 个板块：')
    for (const s of r.sections) console.log('  ' + s.id.padStart(6) + '  ' + s.title + '  （' + s.group + '，讨论 ' + s.discuss + '）')
    return
  }
  if (sub === 'topics') {
    const sid = parseSectionId(args[1]) || fail('用法：hykb.mjs forum topics <板块id>')
    const j = await sectionTopics(sid, {})
    if (j.code !== 100) fail('读板块失败：' + j.code + ' ' + (j.msg || ''))
    const list = j.result?.data || []
    console.log('板块 ' + sid + ' 最新 ' + list.length + ' 帖（按最后回复时间）：')
    for (const t of list) {
      console.log('  ' + t.id + '  ' + String(t.title || '(无标题)').slice(0, 30).padEnd(32) + ' 回复' + String(t.reply_count).padStart(3) + '  ' + (t.time_str || t.time))
    }
    return
  }
  fail('用法：hykb.mjs forum list | forum topics <板块id>')
}


/* ─────────── 刷帖 / 日报 ─────────── */
async function cmdBrowse() {
  const cfg = config()
  const sub = args[0]
  if (sub === 'sections' || sub === 'list') {
    const picked = await resolveSections(cfg, { log: (m) => console.log(m) })
    console.log('本轮会扫这些板块：')
    for (const s of picked) console.log('  ' + String(s.id).padStart(6) + '  ' + (s.title || '(未命名)'))
    if (!picked.length) console.log('  （空：板块目录没拉到，或 browse.sections 被名单全过滤）')
    return
  }
  const dry = args.includes('--dry') || !args.includes('--send')
  const r = await previewDigest(cfg, { log: (m) => console.log(m) })
  console.log('\n扫到 ' + r.scanned + ' 帖，前 ' + r.top.length + ' 名：')
  for (const t of r.top) {
    console.log('  ' + String(t.score).padStart(6) + ' 分  ' + t.topicId + '  ' + String(t.title || '(无标题)').slice(0, 34).padEnd(36) + '  ' + (t.sectionTitle || '') + '  回复' + t.replyCount)
  }
  if (dry) console.log('\n（只读预览，未写日报、未回帖。要真跑：hykb.mjs digest）')
}

async function cmdDigest() {
  const cfg = config()
  const dry = args.includes('--dry')
  if (!aiReady()) console.log('⚠ AI 未配置：日报会退回原始清单（去设置页填 baseUrl / model / apiKey）')
  const r = await runDigest(cfg, { dryRun: dry, log: (m) => console.log(m) })
  console.log('\n扫 ' + r.scanned + ' 帖，选 ' + r.picked.length + ' 帖' + (r.replied ? '，回 ' + r.replied + ' 帖' : '') + (dry ? '（dry-run，未发写请求）' : ''))
  if (r.file) console.log('日报：' + r.file)
  else console.log('日报目录：' + digestDir())
  if (r.text) { console.log('\n--- 日报正文 ---\n'); console.log(r.text) }
}

const TABLE = { login: cmdLogin, whoami: cmdWhoami, read: cmdRead, reply: cmdReply, comment: cmdComment, del: cmdDel, summary: cmdSummary, traffic: cmdTraffic, listen: cmdListen, watch: cmdWatch, forum: cmdForum, browse: cmdBrowse, digest: cmdDigest, config: async () => console.log(configPath()) }
const fn = TABLE[cmd]
if (!fn) { console.log('用法: hykb.mjs <' + Object.keys(TABLE).join('|') + '>'); process.exit(1) }
fn().catch((e) => fail(e.message))