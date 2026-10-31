// 去重 / 已处理记录：同一层楼永远只回一次，同一人 N 天内只回一次。
import fs from 'node:fs'
import { seenPath, credDir, ensureDir, auditPath, harden } from './paths.mjs'

const DAY = 86400000

const EMPTY = () => ({ replies: {}, persons: {} })

/** 原始读盘（不带基线快照），内部用。 */
function readRaw() {
  try {
    const v = JSON.parse(fs.readFileSync(seenPath(), 'utf8'))
    const out = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}
    if (!out.replies || typeof out.replies !== 'object') out.replies = {}
    if (!out.persons || typeof out.persons !== 'object') out.persons = {}
    return out
  } catch { return EMPTY() }
}

const clone = (o) => JSON.parse(JSON.stringify(o))

export function loadSeen() {
  const data = readRaw()
  const s = { ...data, replies: { ...data.replies }, persons: { ...data.persons } }
  // 记下读盘时的快照。saveSeen 靠它算出"这次到底改了哪些键"，
  // 把改动合并到最新的磁盘状态上，而不是整体覆盖掉别的进程刚写进去的记录。
  Object.defineProperty(s, '__base', { value: data, enumerable: false, writable: true, configurable: true })
  return s
}

/** 进程间互斥：watch 监听与 browse 日报是两条独立链路，都可能同时读写 seen.json。 */
function withLock(fn, { timeoutMs = 5000 } = {}) {
  ensureDir(credDir())
  const lock = seenPath() + '.lock'
  const t0 = Date.now()
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx')
      try { fs.writeSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
      break
    } catch (e) {
      if (e.code !== 'EEXIST') return fn()          // 拿不到锁文件能力（只读 FS 等）就直跑
      // 陈旧锁（持锁进程崩了）超过 15s 直接清掉
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15000) { fs.rmSync(lock, { force: true }); continue } } catch {}
      if (Date.now() - t0 > timeoutMs) return fn()  // 等太久就放弃互斥，宁可写也别卡死
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try { return fn() } finally { try { fs.rmSync(lock, { force: true }) } catch {} }
}

function writeRaw(data) {
  ensureDir(credDir())
  const f = seenPath()
  const tmp = f + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
}

export function saveSeen(s) {
  const base = s.__base
  withLock(() => {
    const latest = readRaw()
    if (!base) { writeRaw({ ...s, replies: { ...s.replies }, persons: { ...s.persons } }); return }
    // 三方合并：只把本进程这次改动过的键应用到最新状态上
    for (const bucket of ['replies', 'persons']) {
      const mine = s[bucket] || {}
      const old = base[bucket] || {}
      const out = latest[bucket] || (latest[bucket] = {})
      for (const k of Object.keys(mine)) {
        if (JSON.stringify(mine[k]) !== JSON.stringify(old[k])) out[k] = mine[k]
      }
      for (const k of Object.keys(old)) if (!(k in mine)) delete out[k]
    }
    for (const k of Object.keys(s)) {
      if (k === 'replies' || k === 'persons' || k === '__base') continue
      if (JSON.stringify(s[k]) !== JSON.stringify(base[k])) latest[k] = s[k]
    }
    for (const k of Object.keys(base)) {
      if (k === 'replies' || k === 'persons' || k === '__base') continue
      if (!(k in s)) delete latest[k]
    }
    writeRaw(latest)
  })
}

export function seenReply(s, replyId) {
  return Boolean(s.replies[String(replyId)])
}

export function markReply(s, replyId, meta = {}) {
  s.replies[String(replyId)] = { at: Date.now(), ...meta }
  const keys = Object.keys(s.replies)
  if (keys.length > 5000) {
    keys.sort((a, b) => (s.replies[a].at || 0) - (s.replies[b].at || 0))
    for (const k of keys.slice(0, keys.length - 5000)) delete s.replies[k]
  }
}

export function seenPerson(s, uid, days = 30) {
  const rec = s.persons[String(uid)]
  if (!rec) return false
  return Date.now() - rec.at < days * DAY
}

export function markPerson(s, uid, meta = {}) {
  s.persons[String(uid)] = { at: Date.now(), ...meta }
}

/** 审计：每次真正发出的写操作都记一条，只追加不覆盖。 */
export function audit(entry) {
  ensureDir(credDir())
  try {
    const file = auditPath()
    const fresh = !fs.existsSync(file)
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
    // 审计日志里有 uid / 楼层号，首次创建时顺手收权（Windows 上只能靠 icacls）。
    if (fresh) harden(file)
  } catch { /* 审计失败不能挡住主流程 */ }
}
