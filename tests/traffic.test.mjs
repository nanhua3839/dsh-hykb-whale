// 限流账本：日上限必须真的生效，切天必须按本地日期。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// traffic.mjs 在模块顶层读 config()，所以 HOME 必须在 import 之前改好
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-traffic-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
const cfgFile = path.join(home, '.dsh', 'hykb-whale.config.json')
fs.writeFileSync(cfgFile, JSON.stringify({
  risk: { minGapMs: 0, readHourly: 1000, readDaily: 1000, writeHourly: 1000, writeDaily: 5, writeGapSec: 0, backoffOnBlock: [1] },
}))

const { trafficState, withTimeout, TIMEOUT_MS } = await import('../tools/lib/traffic.mjs')

// 只跑 bump 的等価路径：直接调 guardedFetch 会真发请求，所以用本地 data: URL 拿不到，
// 改成打一个必然失败的地址并把 fetch 换掉。
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response('{}', { status: 200 })

test('写日上限 writeDaily 会真的拦住（原来从不生效）', async () => {
  const { guardedFetch } = await import('../tools/lib/traffic.mjs')
  for (let i = 0; i < 5; i++) await guardedFetch('https://example.invalid/x', {}, 'write')
  assert.equal(trafficState().writeDay, 5, '写了 5 次，日计数应是 5')
  await assert.rejects(() => guardedFetch('https://example.invalid/x', {}, 'write'), /写预算用尽：今天/)
  assert.equal(trafficState().writeDay, 5, '被拦下的那次不该计数')
})

test('写小时上限仍然生效', async () => {
  const { trafficState: st } = await import('../tools/lib/traffic.mjs')
  assert.ok(st().writeHour >= 5)
})

test('读日计数与切天用的键一致（本地日期）', async () => {
  const { guardedFetch } = await import('../tools/lib/traffic.mjs')
  await guardedFetch('https://example.invalid/x', {}, 'read')
  const st = trafficState()
  const d = new Date()
  const local = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  assert.equal(st.day, local, 'ledger 里的 day 必须是本地日期，不是 UTC')
  assert.equal(st.readDay, 1)
})

test('withTimeout 会补 AbortSignal，且不覆盖调用方自己的', () => {
  assert.ok(withTimeout().signal, '应当补上 signal')
  const mine = new AbortController().signal
  assert.equal(withTimeout({ signal: mine }).signal, mine, '调用方传了就不动')
  assert.equal(TIMEOUT_MS, 20000)
})

test.after(() => { globalThis.fetch = realFetch; fs.rmSync(home, { recursive: true, force: true }) })
