/**
 * dsh-hykb-whale —— 宿主侧插件（设置壳 + 监听调度）
 *
 * 挂三条东西：
 *   1. 设置页 API：/dsh-hykb/api/settings → 读写 ~/.dsh/hykb-whale.config.json
 *   2. 扫码登录：/dsh-hykb/api/auth/qr/{start,poll} → 复刻 QRLogin 状态机
 *   3. 监听循环：按 listen.intervalSec 读帖子 → 找 @我 的楼层 → AI 生成回复 → 发楼中楼
 *
 * 所有出网请求都过 tools/lib/traffic.mjs（读写分桶预算 + 写冷却 + 撞风控退避），
 * 所有写操作都追加到 ~/.hykb-ai/audit.jsonl。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBrowseClock } from './browse-clock.js'
// 静态引入工具链的路径层与配置层：配置/凭据位置、默认值、密钥落盘口径都只有那一份实现。
import * as P from '../tools/lib/paths.mjs'
import * as C from '../tools/lib/config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
// 配置/凭据路径统一走 tools/lib/paths.mjs —— 那边认 HYKB_WHALE_CONFIG 覆盖，这里别再硬编码一份。
const CFG_FILE = P.configPath()
const CRED_FILE = P.credentialsPath()
const PERSONA_FILE = P.personaPath()
const MASK = '••••••••'

const FILTER = () => Object.fromEntries(C.FILTER_KEYS.map((k) => [k, []]))
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const merge = C.merge

/** 默认配置只有一份（tools/lib/config.mjs 的 DEFAULTS），这里不再抄第二份。 */
function readConfig() {
  const cfg = C.config()
  let hasUser = false
  try { hasUser = Object.keys(C.readRaw()).length > 0 } catch {}
  return { ...cfg, __hasUserFile: hasUser }
}
/** 写盘交给 config.mjs：apiKey 会被搬进 ~/.hykb-ai/ai-key，配置里不留明文。 */
function writeConfig(next) {
  const patch = { ...next }
  delete patch.__hasUserFile
  return C.writeConfig(patch)
}
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,，]+/)).map((x) => String(x).trim()).filter(Boolean)

/** items / forums 统一成 [{ id, title }]。必须在 String() 之前判对象，否则全部烤成 "[object Object]"。 */
const toIdTitle = (v) => {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s,，]+/)
  const out = []
  for (const x of arr) {
    if (isObj(x) || typeof x === 'object' && x !== null) {
      const id = String(x.id ?? x.value ?? '').trim()
      if (id) out.push({ id, title: String(x.title ?? x.label ?? '').trim() })
    } else {
      const id = String(x ?? '').trim()
      if (id) out.push({ id, title: '' })
    }
  }
  return out
}

/** 请求体 JSON 解析：畸形返回 null，由调用方回 400，不抛成 500。 */
const parseBody = (raw) => {
  const t = String(raw || '').trim()
  if (!t) return {}
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

/** 布尔型数字字段：0 是合法值，不能用 || 兜底（否则 replyMax:0 会变成 3）。 */
const numOr = (v, def, lo, hi) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

/** 设置页可能传来字符串或数组，统一成数组；数字字段卡范围 */
function normalizeListen(l) {
  l.intervalSec = numOr(l.intervalSec, 60, 20, 3600)
  l.maxTopicsPerTick = numOr(l.maxTopicsPerTick, 6, 1, 20)
  l.maxRepliesPerTick = numOr(l.maxRepliesPerTick, 3, 1, 20)
  l.allDay = l.allDay !== false
  // @ 触发口径：非法值一律回 both，不然设置页传个拼错的字符串就变成"永远不回"
  l.triggerMode = ['both', 'rich', 'plain'].includes(l.triggerMode) ? l.triggerMode : 'both'
  if (!Array.isArray(l.windows) || !l.windows.length) l.windows = [{ start: '08:00', end: '24:00' }]
  l.windows = l.windows.map((w) => ({ start: String(w?.start || '08:00'), end: String(w?.end || '24:00') }))
  for (const key of ['forum', 'topic', 'at', 'atme']) {
    const src = isObj(l[key]) ? l[key] : (l[key] = {})
    // atme 是唯一「不填任何 id 也能干活」的源，默认开着；其余三个默认关着
    src.enabled = key === 'atme' ? src.enabled !== false : src.enabled === true
    // items 统一成 [{id,title}]：纯字符串（板块 id / 帖子链接）也认
    src.items = toIdTitle(src.items)
    for (const k of Object.keys(FILTER())) src[k] = listOf(src[k])
    if (key === 'at') src.forums = toIdTitle(src.forums)
  }
  l.topic.floors = l.topic.floors !== false
  l.topic.comments = l.topic.comments !== false
  return l
}

/**
 * 只回"能不能用"，不回显任何凭据内容。
 * 重点：hasPauth 为假时 present 也算假 —— 只有 uid 没有 Pauth 是半张票，
 * 读帖能跑但写操作一律 5001，界面上不该显示成"已登录"。
 */
function credState() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    const hasPauth = !!c.Pauth
    return {
      present: !!(c.uid && hasPauth),
      uid: c.uid || '',
      nickname: c.nickname || '',
      hasPauth,
      needLogin: !(c.uid && hasPauth),
      why: !c.uid ? '没有登录态' : (!hasPauth ? '只有 uid 没有 Pauth（半张票）：能读不能写，重新扫码登录一次' : ''),
    }
  } catch { return { present: false, uid: '', nickname: '', hasPauth: false, needLogin: true, why: '没有凭据文件' } }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default {
  name: 'dsh-hykb-whale',
  // 注意：inject 只能写一个数组。写成两个对象键会互相覆盖 → sessionController 拿不到 → 生物钟静默不干活。
  inject: ['webServer', 'connection', 'sessionController'],
  apply(ctx) {
    function isLoopbackReq(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }
    function isTrustedReq(req) {
      if (isLoopbackReq(req)) return true
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }
    /** 安全组件默认值必须是"关"：栅栏不可用 → 拒绝 */
    function rejected(req, res) {
      if (isTrustedReq(req) === false) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) { rejected.warned = true; console.warn('[hykb-whale] 信任栅栏不可用 → fail-closed') }
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind, path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        },
      }))
    }
    ctx.effect(() => () => { for (const d of disposers) { try { d() } catch {} } })

    /** 延迟加载工具链模块（插件加载失败不能拖垮整个 DSH）；Windows 绝对路径必须转成 file:// URL 才能 import */
    const toolsDir = () => readConfig().toolsPath || path.join(HERE, '..', 'tools')
    const L = (name) => import(pathToFileURL(path.join(toolsDir(), 'lib', name)).href)

    /* ───────────────── 设置 ───────────────── */
    const KNOWN = new Set(['owner', 'self', 'ai', 'persona', 'prompt', 'listen', 'browse', 'risk', 'summary', 'post', 'toolsPath'])
    route('exact', '/dsh-hykb/api/settings', async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readConfig()
        // 密钥永不回显：只告诉前端"填过没"，回一个掩码占位
        cfg.ai = { ...cfg.ai, apiKey: cfg.ai?.apiKey ? MASK : '' }
        json(res, 200, { ok: true, config: cfg, credentials: credState(), configPath: CFG_FILE, credPath: CRED_FILE })
        return
      }
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const cur = readConfig(); delete cur.__hasUserFile
      const prevListen = JSON.parse(JSON.stringify(cur.listen || {}))
      const incoming = isObj(body.config) ? body.config : (isObj(body) ? body : {})
      const filtered = {}
      for (const [k, v] of Object.entries(incoming)) if (KNOWN.has(k)) filtered[k] = v
      const next = merge(cur, filtered)
      // 外层键即使传成 null / 字符串也要变成对象，否则下面 next.risk.writeGapSec 直接 TypeError
      for (const k of ['owner', 'self', 'ai', 'prompt', 'listen', 'browse', 'risk', 'summary', 'post']) {
        if (!isObj(next[k])) next[k] = isObj(cur[k]) ? { ...cur[k] } : {}
      }
      // summary.maxComments 是深读楼层上限：设置页能改就也得卡范围，否则 1e9 会把整帖拉下来
      next.summary.maxComments = numOr(next.summary.maxComments, 50, 1, 500)
      next.ai.temperature = numOr(next.ai.temperature, 0.7, 0, 2)
      next.ai.maxTokens = numOr(next.ai.maxTokens, 800, 50, 4000)
      // 掩码原样回传 = 没改密钥，保住原来的
      if (next.ai && next.ai.apiKey === MASK) next.ai.apiKey = cur.ai?.apiKey || ''
      if (next.ai && typeof next.ai.apiKey === 'string') next.ai.apiKey = next.ai.apiKey.trim()
      // 范围校验：别让设置页写负数或离谱值
      next.listen.intervalSec = numOr(next.listen.intervalSec, 60, 20, 3600)
      next.risk.writeGapSec = numOr(next.risk.writeGapSec, 120, 30, 3600)
      next.risk.writeHourly = numOr(next.risk.writeHourly, 12, 1, 60)
      next.risk.writeDaily = numOr(next.risk.writeDaily, 30, 1, 300)
      normalizeListen(next.listen)
      // 刷帖范围钳制：间隔太短会白烧读额度，pick 太大会让 AI 开始编
      const B = next.browse || (next.browse = {})
      B.intervalSec = numOr(B.intervalSec, 3600, 300, 86400)
      B.pages = numOr(B.pages, 1, 1, 5)
      B.maxSections = numOr(B.maxSections, 6, 1, 20)
      B.pick = numOr(B.pick, 8, 1, 20)
      B.deep = numOr(B.deep, 3, 0, 8)
      B.replyMax = numOr(B.replyMax, 3, 0, 10)
      B.replyMinScore = numOr(B.replyMinScore, 40, 0, 1e6)
      B.minScore = numOr(B.minScore, 0, 0, 1e6)
      if (!Array.isArray(B.windows) || !B.windows.length) B.windows = [{ start: '08:00', end: '24:00' }]
      B.windows = B.windows.map((w) => ({ start: String(w?.start || '08:00'), end: String(w?.end || '24:00') }))
      // 设置页的 list 字段在输入过程中是字符串（"23064,3"），不转成数组 browse.mjs 的 .map 会炸
      B.sections = listOf(B.sections)
      B.muteTitles = listOf(B.muteTitles)
      B.defaultSections = listOf(B.defaultSections)
      for (const k of Object.keys(FILTER())) B[k] = listOf(B[k])
      B.allDay = B.allDay !== false
      B.skipTop = B.skipTop !== false
      B.autoReply = B.autoReply === true
      B.wake = B.wake !== false
      B.sessionId = String(B.sessionId || 'hykb-whale').trim() || 'hykb-whale'
      if (!Array.isArray(B.defaultSections) || !B.defaultSections.length) {
        B.defaultSections = ['23064', '3', '134', '31959', '41278', '58124']
      }
      // 提示词：规则是自由文本，后缀会原样贴在每条发出去的话后面，卡长度
      next.prompt.rules = String(next.prompt.rules ?? '').slice(0, 4000)
      next.prompt.suffix = String(next.prompt.suffix ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
      // 发帖：板块只认 {id,title}；每日上限卡死，日报每小时一轮，不卡就刷屏
      const Po = next.post
      Po.enabled = Po.enabled === true
      Po.links = Po.links !== false
      const sec = isObj(Po.section) ? Po.section : { id: typeof Po.section === 'string' ? Po.section : '' }
      Po.section = { id: String(sec.id ?? '').replace(/\D/g, '').slice(0, 12), title: String(sec.title ?? '').slice(0, 40) }
      Po.title = String(Po.title ?? '').trim().slice(0, 60) || '快爆论坛日报 {date}'
      Po.maxPerDay = numOr(Po.maxPerDay, 1, 1, 5)
      Po.minPicks = numOr(Po.minPicks, 3, 1, 20)
      writeConfig(next)
      // 监听范围变了就清掉旧帖的去重记录，否则换完帖子它永远显示"已回"
      let forgot = 0
      try { const w = await L('watch.mjs'); forgot = w.syncScope(next.listen || {}, prevListen) } catch {}
      // 改完立刻生效：让调度按新配置重算
      try { sched.invalidate() } catch {}
      const shown = { ...next, ai: { ...next.ai, apiKey: next.ai?.apiKey ? MASK : '' } }
      json(res, 200, { ok: true, config: shown, forgot, warn: next.risk.writeDaily > 50 ? '每天 >50 条：看起来像刷量，平台可能限流' : null })
    })

    /* ───────────────── 扫码登录 ───────────────── */
    // 扫码会话：给个 TTL（平台二维码本身也就几分钟有效），过期就当没这回事，
    // 别再拿一个几小时前的 qrcode 去轮询；顺便记下轮询次数避免无限转。
    const LOGIN_TTL_MS = 5 * 60 * 1000
    let pendingLogin = null
    const loginAlive = () => {
      if (!pendingLogin) return null
      if (Date.now() - pendingLogin.at > LOGIN_TTL_MS) { pendingLogin = null; return null }
      return pendingLogin
    }
    route('exact', '/dsh-hykb/api/auth/qr/start', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const { qrCreate } = await L('hykb-api.mjs')
        // 上一次没扫完就作废，但要在响应里说清楚，不然用户以为自己的码被换了很奇怪
        const replaced = Boolean(loginAlive())
        const jar = {}
        const first = await qrCreate()
        if (first.data?.code !== 100 || !first.data?.result?.qrcode) {
          json(res, 503, { ok: false, error: '取二维码失败：' + JSON.stringify(first.data).slice(0, 200) }); return
        }
        Object.assign(jar, first.cookies)
        pendingLogin = { qrcode: first.data.result.qrcode, jar, at: Date.now() }
        // 客户端只拿 dataURL 画 img：服务端只给二维码内容，图像在本地生成
        let image = ''
        try {
          const QR = (await import('qrcode')).default
          image = await QR.toDataURL(pendingLogin.qrcode, { width: 220, margin: 2, errorCorrectionLevel: 'M' })
        } catch (e) { console.warn('[hykb-whale] 二维码渲染失败：' + e.message) }
        json(res, 200, { ok: true, qrcode: pendingLogin.qrcode, content: pendingLogin.qrcode, image, replaced, expiresInSec: Math.round(LOGIN_TTL_MS / 1000) })
      } catch (e) { json(res, 503, { ok: false, error: String(e.message) }) }
    })
    route('exact', '/dsh-hykb/api/auth/qr/poll', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!loginAlive()) { json(res, 400, { ok: false, error: '没有进行中的扫码会话（或已过期），先 start' }); return }
      try {
        const { qrPoll, qrAuthCallback } = await L('hykb-api.mjs')
        const jarMap = new Map(Object.entries(pendingLogin.jar))
        const { data, cookies } = await qrPoll(pendingLogin.qrcode, jarMap)
        for (const [k, v] of Object.entries(cookies)) pendingLogin.jar[k] = v
        const r = data.result || {}
        let phase = 'UNKNOWN'
        // 快爆不下发独立的 uid cookie，uid 藏在 Pauth 第 1 段里，所以判据只看 Pauth。
        // 之前要求 jar.uid && jar.Pauth，uid 永远不来，前端就一直卡在"正在写入登录态"。
        if (pendingLogin.jar.Pauth) phase = 'LOGIN'
        else if (data.code === 102) phase = 'EXPIRED'
        else if (typeof r.status === 'number') phase = ['WAIT', 'SCANNED', 'CONFIRMED', 'CANCELLED'][r.status] || ('STATUS_' + r.status)
        else if (r.uid) phase = 'AUTH'

        // 轮询回 uid 只代表手机端确认了；Pauth 要再调一次 AuthCallBack 才下发。
        // 少了这一步会落出 uid 有、Pauth 空的凭据 —— 页面上看着"登录了"，写操作全是 5001。
        if (phase === 'AUTH') {
          // 手机确认后要再调一次 AuthCallBack 才下发 Pauth。这一步不能无限重试：
          // 之前没有上限，服务端迟迟不给 Pauth 时前端就永远停在"正在写入登录态"。
          pendingLogin.authTries = (pendingLogin.authTries || 0) + 1
          const back = await qrAuthCallback(r, jarMap)
          for (const [k, v] of Object.entries(back.cookies)) pendingLogin.jar[k] = v
          if (back.data?.status === -2) {
            json(res, 200, { ok: true, phase: 'NEED_IDCARD', done: false, error: '这个账号还没实名认证，去网页端补完再扫一次' })
            return
          }
          if (pendingLogin.jar.Pauth) {
            phase = 'LOGIN'
          } else if (pendingLogin.authTries >= 3) {
            const why = '扫码已确认，但服务端 3 次都没下发 Pauth（回包：' + JSON.stringify(back.data).slice(0, 160) + '）'
            pendingLogin = null
            json(res, 200, { ok: true, phase: 'AUTH_FAILED', done: false, error: why })
            return
          } else {
            phase = 'CONFIRMED'
          }
        }

        if (phase === 'LOGIN') {
          const { saveCred } = await L('cred.mjs')
          // saveCred 内部会 deriveCred：uid / nickname 缺失时从 Pauth 解出来。
          const cred = saveCred({
            uid: String(r.uid || ''),
            Pauth: pendingLogin.jar.Pauth || '',
            Uauth: pendingLogin.jar.Uauth || '',
            nickname: pendingLogin.jar.nickname || '',
          })
          pendingLogin = null
          const cur = readConfig(); delete cur.__hasUserFile
          writeConfig({ ...cur, self: { uid: cred.uid, name: cred.nickname } })
          json(res, 200, { ok: true, phase: 'LOGIN', done: true, uid: cred.uid, nickname: cred.nickname })
          return
        }
        json(res, 200, { ok: true, phase, done: false })
      } catch (e) { json(res, 503, { ok: false, error: String(e.message) }) }
    })

    /** 手动贴 cookie（扫码不方便时的退路） */
    route('exact', '/dsh-hykb/api/cookie', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        const raw = String(body.cookie || body.text || '')
        const grab = (k) => (raw.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]+)')) || [])[1] || ''
        const { saveCred, deriveCred } = await L('cred.mjs')
        // uid 不必单独给：快爆的 uid 就在 Pauth 第 1 段里，deriveCred 会补。
        const cred = deriveCred({
          uid: body.uid || grab('uid'),
          Pauth: body.Pauth || grab('Pauth'),
          Uauth: body.Uauth || grab('Uauth'),
          nickname: body.nickname || grab('nickname'),
        })
        if (!cred.Pauth) { json(res, 400, { ok: false, error: '没找到 Pauth —— 至少要把 Pauth 这一条复制全' }); return }
        if (!cred.uid) { json(res, 400, { ok: false, error: 'Pauth 看着不对（第 1 段应该是纯数字 uid），检查有没有复制全' }); return }
        const saved = saveCred(cred)
        const cur = readConfig(); delete cur.__hasUserFile
        writeConfig({ ...cur, self: { uid: saved.uid, name: saved.nickname } })
        json(res, 200, { ok: true, uid: saved.uid, nickname: saved.nickname })
      } catch (e) { json(res, 400, { ok: false, error: String(e.message) }) }
    })

    /** 退出登录：删掉本地凭据。不调平台的登出接口——那会把同一账号在别处的网页登录也踢掉。 */
    route('exact', '/dsh-hykb/api/logout', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        try { fs.unlinkSync(CRED_FILE) } catch (e) { if (e.code !== 'ENOENT') throw e }
        const cur = readConfig(); delete cur.__hasUserFile
        writeConfig({ ...cur, self: { uid: '', name: '' } })
        try { sched.invalidate() } catch {}
        json(res, 200, { ok: true, credentials: credState() })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 人设 ───────────────── */
    route('exact', '/dsh-hykb/api/persona', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method === 'GET') {
        let text = ''
        try { text = fs.readFileSync(PERSONA_FILE, 'utf8') } catch {}
        json(res, 200, { ok: true, text, bytes: Buffer.byteLength(text, 'utf8') })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const text = String(body.text ?? '')
      if (text.length > 20000) { json(res, 400, { ok: false, error: '人设太长（上限 20000 字符）' }); return }
      fs.mkdirSync(path.dirname(PERSONA_FILE), { recursive: true })
      const tmp = PERSONA_FILE + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, text, { mode: 0o600 })
      P.harden(tmp)
      fs.renameSync(tmp, PERSONA_FILE)
      P.harden(PERSONA_FILE)
      json(res, 200, { ok: true, bytes: Buffer.byteLength(text, 'utf8') })
    })

    /* ───────────────── 状态 / 限流 ───────────────── */
    async function postState() {
      try {
        const { loadPostLog, postedToday } = await L('post.mjs')
        const book = loadPostLog()
        const last = book[book.length - 1] || null
        return { today: postedToday(P.localDay(), book), last: last && { at: last.at, title: last.title, section: last.section, ok: last.ok, msg: last.msg } }
      } catch { return { today: 0, last: null } }
    }
    route('exact', '/dsh-hykb/api/status', async (req, res) => {
      try {
        const { trafficState } = await L('traffic.mjs')
        const { aiReady } = await L('ai.mjs')
        json(res, 200, {
          ok: true,
          credentials: credState(),
          aiReady: aiReady(),
          traffic: trafficState(),
          listen: { running: sched.running, lastTickAt: sched.lastTickAt, lastError: sched.lastError, lastResult: sched.lastResult },
          browse: browseClock ? browseClock.status() : { enabled: false, reason: '时钟未启动' },
          post: await postState(),
          configPath: CFG_FILE,
        })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 监听调度 ───────────────── */
    const sched = {
      running: false,
      lastTickAt: 0,
      lastError: null,
      lastResult: null,
      timer: null,
      invalidate() { if (this.running) { clearTimeout(this.timer); this.schedule(0) } },
      schedule(delayMs) {
        clearTimeout(this.timer)
        const cfg = readConfig()
        const wait = delayMs ?? cfg.listen.intervalSec * 1000
        this.timer = setTimeout(() => this.tick().catch(() => {}), wait)
        if (this.timer.unref) this.timer.unref()
      },
      async start() {
        if (this.running) return { already: true }
        this.running = true
        this.schedule(1500)
        return { started: true }
      },
      stop() { this.running = false; clearTimeout(this.timer); return { stopped: true } },
      async tick() {
        if (!this.running) return
        const cfg = readConfig()
        this.lastTickAt = Date.now()
        // 监听关掉就直接停车，不再每分钟空转一次 readConfig + 动态 import。
        // 重新开始靠 /listen 的 start（或插件重载）。
        if (!cfg.listen.enabled) {
          this.running = false
          clearTimeout(this.timer)
          this.lastError = null
          return
        }
        try {
          // 监听逻辑全在 tools/lib/watch.mjs，与 CLI 共用同一份实现，避免两边漂移
          const w = await L('watch.mjs')
          const res = await w.tick(cfg, { dryRun: false, log: (m) => console.log('[hykb-whale] ' + m) })
          this.lastError = null
          this.lastResult = res
        } catch (e) {
          this.lastError = String(e.message ?? e)
        } finally {
          if (this.running) this.schedule()
        }
      },
    }

    route('exact', '/dsh-hykb/api/listen', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      try {
        if (body.action === 'stop') { json(res, 200, { ok: true, ...sched.stop() }); return }
        const r = await sched.start()
        json(res, 200, { ok: true, ...r })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 监听预览（不真发） ───────────────── */
    route('exact', '/dsh-hykb/api/watch', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        const w = await L('watch.mjs')
        if (body.action === 'reset') { w.resetPrimed(); json(res, 200, { ok: true, reset: true }); return }
        const cfg = readConfig()
        const lines = []
        const result = await w.tick(cfg, { dryRun: true, log: (m) => lines.push(m) })
        json(res, 200, { ok: true, result, log: lines })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 刷帖（日报 / 预览 / 立即跑一轮） ───────────────── */
    route('exact', '/dsh-hykb/api/browse', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        const cfg = readConfig()
        const lines = []
        const log = (m) => lines.push(m)

        if (body.action === 'preview') {
          const d = await L('digest.mjs')
          const out = await d.previewDigest(cfg, { log, limit: body.limit })
          json(res, 200, { ok: true, ...out, log: lines })
          return
        }
        if (body.action === 'run') {
          const d = await L('digest.mjs')
          // post:true = 手动「发一篇」：不看 post.enabled，但每日上限照算
          const stats = await d.runDigest(cfg, { dryRun: body.dry !== false, log, forcePost: body.post === true })
          json(res, 200, { ok: true, stats, log: lines })
          return
        }
        if (body.action === 'catalog') {
          // 全站板块目录，给设置页的板块选择器用（读一次网络）
          const f = await L('forum.mjs')
          const cat = await f.sectionCatalog()
          if (cat.code !== 100) { json(res, 502, { ok: false, error: '板块目录没拉到（code=' + cat.code + '）' }); return }
          json(res, 200, { ok: true, sections: cat.sections })
          return
        }
        if (body.action === 'sections') {
          const b = await L('browse.mjs')
          const secs = await b.resolveSections(cfg, { log })
          json(res, 200, { ok: true, sections: secs, log: lines })
          return
        }
        json(res, 400, { ok: false, error: '未知 action：' + String(body.action) })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    // 日报文件：GET 列表 / GET ?date= 取正文
    route('exact', '/dsh-hykb/api/digest', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      try {
        const { digestDir, digestPath } = await L('paths.mjs')
        const url = new URL(req.url, 'http://x')
        const date = url.searchParams.get('date')
        if (date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' }); return }
          let text = ''
          try { text = fs.readFileSync(digestPath(date), 'utf8') } catch {}
          json(res, 200, { ok: true, date, text })
          return
        }
        let files = []
        try {
          files = fs.readdirSync(digestDir())
            .filter((f) => /^digest-\d{4}-\d{2}-\d{2}\.md$/.test(f))
            .map((f) => ({ date: f.slice(7, 17), bytes: fs.statSync(path.join(digestDir(), f)).size }))
            .sort((a, b) => (a.date < b.date ? 1 : -1))
            .slice(0, 60)
        } catch {}
        json(res, 200, { ok: true, dir: digestDir(), files })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    // 插件加载时如果配置里已经开了监听，自动起来
    try { if (readConfig().listen.enabled) sched.start() } catch {}

    // 刷帖时钟：与监听各自独立，互不影响
    let browseClock = null
    try {
      browseClock = startBrowseClock(ctx, {
        dshHome: DSH_HOME,
        cwd: path.join(DSH_HOME, 'hykb-work'),
        readConfig,
        loadTool: L,
        log: (m) => { try { console.log('[hykb-whale] ' + m) } catch {} },
      })
      if (!browseClock.status().hasSession) console.warn('[hykb-whale] 没有 sessionController：日报照写，但不会叫醒会话（headless 模式下属正常）')
    } catch (e) {
      console.warn('[hykb-whale] 刷帖时钟启动失败：' + e.message)
    }

    ctx.effect(() => () => { try { browseClock?.stop() } catch {} })

    console.log('[hykb-whale] 设置页已挂载：/dsh-hykb/ · 配置 ' + CFG_FILE)
  },
}
