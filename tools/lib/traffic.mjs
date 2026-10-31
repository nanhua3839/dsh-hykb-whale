// 限流层：所有出网请求都必须过这里。
// 读 600/时·3000/天，写 12/时·30/天，写冷却 120 秒，全局最小间隔 1500ms。
// 撞到风控就全局暂停并指数退避，值写死不开放旋钮 —— 出事没人调得回来。
import fs from 'node:fs'
import { ledgerPath, credDir, ensureDir, harden } from './paths.mjs'
import { config } from './config.mjs'

const DAY = 86400000
const HOUR = 3600000

let lastAt = 0
let pausedUntil = 0
let blockRound = 0

function load() {
  try { return JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')) } catch { return {} }
}
function save(l) {
  ensureDir(credDir())
  const f = ledgerPath()
  // 带 pid 的临时名：两个进程同时保存时不会互相踩掉写了一半的文件。
  const tmp = f + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2), { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
}

/** 切天用本地日期（UTC 日在东八区要到 08:00 才翻页，用户看到的"今天"会错位）。 */
function dayKey(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function nowBuckets(l) {
  const now = Date.now()
  const today = dayKey(now)
  const rd = l.readDay === today || l.writeDay === today ? l : {}
  const read = rd.readHourTs && now - rd.readHourTs < HOUR ? (rd.readHour || 0) : 0
  const write = rd.writeHourTs && now - rd.writeHourTs < HOUR ? (rd.writeHour || 0) : 0
  return {
    day: rd.readDay || rd.writeDay || '',
    readHour: read,
    readDay: rd.readDay === today ? (rd.readDayCount || 0) : 0,
    writeHour: write,
    writeDay: rd.writeDay === today ? (rd.writeDayCount || 0) : 0,
    lastWriteAt: rd.lastWriteAt || 0,
  }
}

function bump(kind) {
  const l = load()
  const today = dayKey()
  const now = Date.now()
  if (l.readDay !== today) { l.readDay = today; l.readDayCount = 0 }
  // 写日计数原来只写 writeDayCount、从不写 writeDay，导致 nowBuckets 永远读到 0，
  // risk.writeDaily 形同不存在。这里补上日期戳，两道日上限才都真的生效。
  if (l.writeDay !== today) { l.writeDay = today; l.writeDayCount = 0 }
  if (!l.readHourTs || now - l.readHourTs >= HOUR) { l.readHourTs = now; l.readHour = 0 }
  if (!l.writeHourTs || now - l.writeHourTs >= HOUR) { l.writeHourTs = now; l.writeHour = 0 }
  if (kind === 'read') { l.readHour = (l.readHour || 0) + 1; l.readDayCount = (l.readDayCount || 0) + 1 }
  else { l.writeHour = (l.writeHour || 0) + 1; l.writeDayCount = (l.writeDayCount || 0) + 1; l.lastWriteAt = now }
  save(l)
  return nowBuckets(l)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 单次请求硬超时。没有它，一次网络挂起就能让 sched.tick 永不返回，界面还显示"运行中"。 */
export const TIMEOUT_MS = 20000

/** 给任何 fetch 的 init 补一个 AbortSignal（调用方自己传了就不动）。 */
export function withTimeout(init = {}, ms = TIMEOUT_MS) {
  if (init.signal) return init
  return { ...init, signal: AbortSignal.timeout(ms) }
}

/**
 * 受控请求。kind: 'read' | 'write'
 * 返回 Response；超预算 / 冷却中 / 全局暂停直接抛错（不重试、不偷偷放行）。
 */
export async function guardedFetch(url, init = {}, kind = 'read') {
  const cfg = config()
  const risk = cfg.risk
  const now = Date.now()

  if (pausedUntil > now) {
    const left = Math.ceil((pausedUntil - now) / 1000)
    throw new Error('风控暂停中，还需 ' + left + ' 秒（撞到 ' + blockRound + ' 级退避）')
  }

  const b = nowBuckets(load())
  if (kind === 'read') {
    if (b.readHour >= risk.readHourly) throw new Error('读预算用尽：本小时 ' + b.readHour + '/' + risk.readHourly + '，等到下一个整点')
    if (b.readDay >= risk.readDaily) throw new Error('读预算用尽：今天 ' + b.readDay + '/' + risk.readDaily)
  } else {
    if (b.writeHour >= risk.writeHourly) throw new Error('写预算用尽：本小时 ' + b.writeHour + '/' + risk.writeHourly)
    if (b.writeDay >= risk.writeDaily) throw new Error('写预算用尽：今天 ' + b.writeDay + '/' + risk.writeDaily)
    const gapLeft = risk.writeGapSec * 1000 - (now - b.lastWriteAt)
    if (b.lastWriteAt && gapLeft > 0) throw new Error('写冷却中，还需 ' + Math.ceil(gapLeft / 1000) + ' 秒')
  }

  const wait = risk.minGapMs - (now - lastAt)
  if (wait > 0) await sleep(wait)
  lastAt = Date.now()

  let res
  try {
    res = await fetch(url, {
      redirect: 'manual',
      ...withTimeout(init),
      headers: { 'user-agent': UA, 'referer': 'https://bbs.3839.com/', ...(init.headers || {}) },
    })
  } catch (e) {
    // 超时也算一种"没拿到"，但不动风控退避计数——那是给平台明确拒绝用的
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('请求超时（' + Math.round(TIMEOUT_MS / 1000) + 's）：' + url)
    throw e
  }

  bump(kind)

  // 撞风控就全局暂停
  if (res.status === 412 || res.status === 429 || res.status === 403) {
    const secs = risk.backoffOnBlock[Math.min(blockRound, risk.backoffOnBlock.length - 1)] || 300
    pausedUntil = Date.now() + secs * 1000
    blockRound += 1
    throw new Error('撞到风控 HTTP ' + res.status + '，全局暂停 ' + secs + ' 秒')
  }
  if (res.status === 200) blockRound = 0
  return res
}

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

export function trafficState() {
  const b = nowBuckets(load())
  return { ...b, pausedForSec: Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000)), blockRound }
}
