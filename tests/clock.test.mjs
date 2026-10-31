import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessionDelivery } from '../lib/session-delivery.js'
import { startBrowseClock } from '../lib/browse-clock.js'

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-clock-'))

function fakeController() {
  const calls = { create: [], prompt: [] }
  return {
    calls,
    async create(a) { calls.create.push(a); return { sessionId: a.sessionId } },
    async prompt(a) { calls.prompt.push(a); return { ok: true } },
  }
}

test('session-delivery 首次投递前建会话，之后复用同一个', async () => {
  const home = tmpHome()
  const c = fakeController()
  const d = createSessionDelivery({ controller: c, dshHome: home, cwd: home, sessionId: 'hykb-whale' })
  assert.equal(d.sessionId, 'hykb-whale')
  await d.send({ mode: 'queue', content: [{ type: 'text', text: '第一段' }] })
  await d.send({ mode: 'queue', content: [{ type: 'text', text: '第二段' }] })
  assert.equal(c.calls.create.length, 1, '只该建一次会话')
  assert.equal(c.calls.prompt.length, 2)
  assert.equal(c.calls.prompt[0].sessionId, 'hykb-whale')
  assert.equal(c.calls.prompt[0].content[0].text, '第一段')
  // 状态落盘，重启后沿用同一个会话 id
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'hykb-session.json'), 'utf8'))
  assert.equal(saved.id, 'hykb-whale')
  assert.ok(saved.deliveredAt > 0)
})

test('session-delivery 把身份块拼在正文前面', async () => {
  const home = tmpHome()
  const c = fakeController()
  const d = createSessionDelivery({ controller: c, dshHome: home, cwd: home, sessionId: 's', persona: () => '［身份］你是小号。' })
  await d.send({ mode: 'queue', content: [{ type: 'text', text: '正文' }] })
  assert.equal(c.calls.prompt[0].content[0].text, '［身份］你是小号。\n\n正文')
})

test('session-delivery 状态文件损坏时抛错而不是静默新建', async () => {
  const home = tmpHome()
  fs.writeFileSync(path.join(home, 'hykb-session.json'), '{坏掉的 json')
  assert.throws(
    () => createSessionDelivery({ controller: fakeController(), dshHome: home, cwd: home, sessionId: 's' }),
    /会话状态损坏/
  )
})

test('session-delivery 投递失败时抛出，且下次会重建会话', async () => {
  const home = tmpHome()
  let fail = true
  const calls = { create: 0, prompt: 0 }
  const c = {
    async create() { calls.create += 1; return {} },
    async prompt() { calls.prompt += 1; if (fail) throw new Error('宿主忙'); return {} },
  }
  const d = createSessionDelivery({ controller: c, dshHome: home, cwd: home, sessionId: 's' })
  await assert.rejects(() => d.send({ mode: 'queue', content: [{ type: 'text', text: 'x' }] }), /宿主忙/)
  fail = false
  await d.send({ mode: 'queue', content: [{ type: 'text', text: 'y' }] })
  assert.equal(calls.create, 2, '失败后 ready 复位，下一次应重新 create')
})

test('browse-clock 关掉时不刷、不开时不叫醒', async () => {
  const home = tmpHome()
  let cfg = { browse: { enabled: false }, persona: {} }
  let digestCalls = 0
  const c = fakeController()
  const clock = startBrowseClock({ sessionController: c, get: () => undefined }, {
    dshHome: home, cwd: home,
    readConfig: () => cfg,
    loadTool: async () => ({ runDigest: async () => { digestCalls += 1; return { scanned: 1, picked: [], replied: 0, file: 'f' } } }),
  })
  try {
    await clock.runNow()
    assert.equal(digestCalls, 0, '关着就不该刷')
    assert.equal(clock.status().enabled, false)
    assert.equal(clock.status().hasSession, true)
  } finally { clock.stop() }
})

test('browse-clock 开起来后跑一轮并叫醒会话', async () => {
  const home = tmpHome()
  const cfg = { browse: { enabled: true, allDay: true, intervalSec: 300, wake: true, sessionId: 'hykb-whale' }, persona: { name: '小号', ownerTitle: '主人' } }
  const c = fakeController()
  const clock = startBrowseClock({ sessionController: c, get: () => undefined }, {
    dshHome: home, cwd: home,
    readConfig: () => cfg,
    loadTool: async () => ({
      runDigest: async () => ({ scanned: 12, picked: [{ topicId: '1' }], replied: 0, file: home + '/digest.md' }),
    }),
  })
  try {
    await clock.runNow()
    assert.equal(clock.status().lastResult.scanned, 12)
    assert.equal(c.calls.prompt.length, 1, '应该叫醒一次')
    assert.match(c.calls.prompt[0].content[0].text, /【刷帖】/)
    // 间隔没到，第二轮不该再跑
    await clock.runNow()
    assert.equal(c.calls.prompt.length, 1, '间隔没到不该重复叫醒')
  } finally { clock.stop() }
})

test('browse-clock 没有可写内容时不叫醒', async () => {
  const home = tmpHome()
  const cfg = { browse: { enabled: true, allDay: true, intervalSec: 300, wake: true }, persona: {} }
  const c = fakeController()
  const clock = startBrowseClock({ sessionController: c, get: () => undefined }, {
    dshHome: home, cwd: home,
    readConfig: () => cfg,
    loadTool: async () => ({ runDigest: async () => ({ scanned: 5, picked: [], replied: 0, file: 'f' }) }),
  })
  try {
    await clock.runNow()
    assert.equal(c.calls.prompt.length, 0, '没选到帖子就不该打扰她')
  } finally { clock.stop() }
})
