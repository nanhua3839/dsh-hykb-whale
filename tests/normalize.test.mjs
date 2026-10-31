// 设置页保存归一化：对象型 items 不能变成 "[object Object]"，0 值不能被吞掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-norm-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })

const plugin = (await import('../lib/index.js')).default

// 宿主自带信任栅栏也照喂一份，测试的重点是归一化而不是 fail-closed
const CONN = { isTrusted: () => true, requestRejection: () => null }

function makeCtx() {
  const routes = []
  return {
    routes,
    ctx: {
      effect: (fn) => { fn() },
      get: (n) => (n === 'connection' ? CONN : undefined),
      webServer: { register: (o) => { routes.push(o); return () => {} } },
    },
  }
}

function fakeRes() {
  const out = { code: 0, body: '' }
  return { out, setHeader() {}, writeHead(c) { out.code = c }, end(b) { out.body = String(b || '') }, writableEnded: false }
}
function fakeReq(body, headers = { host: '127.0.0.1:51548' }) {
  const handlers = {}
  const req = {
    method: 'POST', url: '/', headers,
    on(ev, fn) {
      handlers[ev] = fn
      if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(body, 'utf8')))
      if (ev === 'end') queueMicrotask(() => fn())
      return req
    },
    resume() {}, destroy() {},
    socket: { remoteAddress: '127.0.0.1' },
  }
  return req
}

async function save(cfg) {
  const { ctx, routes } = makeCtx()
  plugin.apply(ctx)
  const route = routes.find((r) => r.path === '/dsh-hykb/api/settings')
  const res = fakeRes()
  await route.handler(fakeReq(JSON.stringify({ config: cfg })), res)
  return { code: res.out.code, body: res.out.body ? JSON.parse(res.out.body) : null }
}

test('对象型 topic.items 保留 id 与 title（原来是 [object Object]）', async () => {
  const { code, body } = await save({
    listen: { topic: { enabled: true, items: [{ id: '1000003', title: '测试论坛请忽略' }] } },
  })
  assert.equal(code, 200)
  assert.deepEqual(body.config.listen.topic.items, [{ id: '1000003', title: '测试论坛请忽略' }])
})

test('字符串型 items 仍然可用', async () => {
  const { body } = await save({ listen: { topic: { enabled: true, items: '1000003, 1000004' } } })
  assert.deepEqual(body.config.listen.topic.items, [
    { id: '1000003', title: '' },
    { id: '1000004', title: '' },
  ])
})

test('at.forums 同样保留对象形态', async () => {
  const { body } = await save({ listen: { at: { enabled: true, forums: [{ id: '23064', title: '爆友生活区' }] } } })
  assert.deepEqual(body.config.listen.at.forums, [{ id: '23064', title: '爆友生活区' }])
})

test('replyMax / deep 的 0 不再被 || 吞成默认值', async () => {
  const { body } = await save({ browse: { autoReply: false, replyMax: 0, deep: 0, replyMinScore: 0, pick: 1, minScore: 0 } })
  assert.equal(body.config.browse.replyMax, 0)
  assert.equal(body.config.browse.deep, 0)
  assert.equal(body.config.browse.replyMinScore, 0)
})

test('risk 传 null / 字符串不会 500，也不会写坏配置', async () => {
  const a = await save({ risk: null })
  assert.equal(a.code, 200, 'null 应当被兜成对象，不该 TypeError')
  assert.equal(typeof a.body.config.risk.writeHourly, 'number')
  const b = await save({ risk: 'x' })
  assert.equal(b.code, 200)
  assert.equal(typeof b.body.config.risk.writeDaily, 'number')
})

test('畸形 JSON 回 400 而不是 500', async () => {
  const { ctx, routes } = makeCtx()
  plugin.apply(ctx)
  const route = routes.find((r) => r.path === '/dsh-hykb/api/settings')
  const res = fakeRes()
  const req = fakeReq('{not json')
  await route.handler(req, res)
  assert.equal(res.out.code, 400)
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
