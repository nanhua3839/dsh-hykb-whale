import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../lib/index.js'

const LOOPBACK = { host: '127.0.0.1:51548' }

function makeCtx({ connection } = {}) {
  const routes = []
  const ctx = {
    effect: (fn) => { fn() },
    get: (n) => (n === 'connection' ? connection : undefined),
    webServer: { register: (o) => { routes.push(o); return () => {} } },
  }
  return { ctx, routes }
}

function fakeRes() {
  const out = { code: 0, body: '' }
  return {
    out,
    setHeader() {}, writeHead(c) { out.code = c }, end(b) { out.body = String(b || '') },
    writableEnded: false,
  }
}
// readBody 要等 'end'，不喂 body 的请求会永远挂着 —— 所以这里必须真的把 data/end 发出去
function fakeReq(headers = LOOPBACK, body = '') {
  const handlers = {}
  const req = {
    method: 'GET', url: '/', headers, body,
    on(ev, fn) {
      handlers[ev] = fn
      // readBody 用 Buffer.concat 拼包，这里必须给 Buffer，给字符串会 TypeError
      if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(body, 'utf8')))
      if (ev === 'end') queueMicrotask(() => fn())
      return req
    },
    resume() {}, destroy() {},
    socket: { remoteAddress: '127.0.0.1' },
  }
  return req
}
const postReq = (body, headers = LOOPBACK) => {
  const r = fakeReq(headers, typeof body === 'string' ? body : JSON.stringify(body))
  r.method = 'POST'
  return r
}
const find = (routes, suffix) => routes.find((x) => String(x.path || x.pathname).endsWith(suffix))

test('plugin 导出声明完整', () => {
  assert.equal(plugin.name, 'dsh-hykb-whale')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('webServer'))
  assert.equal(typeof plugin.apply, 'function')
})

test('七条路由全部挂上', () => {
  const { ctx, routes } = makeCtx()
  plugin.apply(ctx)
  assert.ok(routes.length >= 7, '至少挂 7 条路由，实际 ' + routes.length)
  const paths = routes.map((r) => String(r.path || r.pathname))
  for (const want of [
    '/dsh-hykb/api/settings', '/dsh-hykb/api/auth/qr/start', '/dsh-hykb/api/auth/qr/poll',
    '/dsh-hykb/api/cookie', '/dsh-hykb/api/persona', '/dsh-hykb/api/status', '/dsh-hykb/api/listen',
  ]) {
    assert.ok(paths.some((p) => p.endsWith(want)), '缺路由 ' + want + '，现有 ' + paths.join(' | '))
  }
})

test('connection 服务缺失时 fail-closed 503', async () => {
  const { ctx, routes } = makeCtx({ connection: undefined })
  plugin.apply(ctx)
  const res = fakeRes()
  await routes[0].handler(fakeReq(), res)
  assert.equal(res.out.code, 503)
  assert.match(res.out.body, /fail-closed/)
})

test('外部 Host 头一律 403', async () => {
  const { ctx, routes } = makeCtx({ connection: undefined })
  plugin.apply(ctx)
  const res = fakeRes()
  await routes[0].handler(fakeReq({ host: 'evil.example.com' }), res)
  assert.equal(res.out.code, 403)
  assert.match(res.out.body, /不受信任/)
})

test('connection 明确拒绝时按其状态码挡下', async () => {
  const { ctx, routes } = makeCtx({
    connection: { isTrusted: (r) => r.headers.host === '127.0.0.1:51548', requestRejection: () => 401 },
  })
  plugin.apply(ctx)
  const res = fakeRes()
  await routes[0].handler(fakeReq({ host: 'evil.example.com' }), res)
  assert.equal(res.out.code, 403, '非 loopback 在 isTrusted 阶段就被挡')
})

test('status 返回凭据、AI 就绪与限流状态', async () => {
  const { ctx, routes } = makeCtx({
    connection: { isTrusted: () => true, requestRejection: () => null },
  })
  plugin.apply(ctx)
  const res = fakeRes()
  await find(routes, '/status').handler(fakeReq(), res)
  assert.equal(res.out.code, 200)
  const j = JSON.parse(res.out.body)
  assert.ok(j.ok)
  assert.ok(j.credentials)
  assert.equal(typeof j.aiReady, 'boolean')
  assert.ok(j.traffic, 'status 应带限流状态')
  assert.equal(typeof j.listen?.running, 'boolean')
  assert.ok(j.browse, 'status 应带刷帖时钟状态')
  assert.equal(typeof j.browse.enabled, 'boolean')
  assert.equal(typeof j.browse.hasSession, 'boolean', '没 sessionController 时要把这个事实报出来')
})

test('刷帖与日报两条路由挂上，且未配置 action 时 400', async () => {
  const { ctx, routes } = makeCtx({
    connection: { isTrusted: () => true, requestRejection: () => null },
  })
  plugin.apply(ctx)
  const browse = find(routes, '/browse')
  const digest = find(routes, '/digest')
  assert.ok(browse, '缺 /browse 路由')
  assert.ok(digest, '缺 /digest 路由')

  const res = fakeRes()
  await browse.handler(postReq({ action: 'nope' }), res)
  assert.equal(res.out.code, 400, '未知 action 应回 400，实际 ' + res.out.code + ' ' + res.out.body.slice(0, 120))
})

test('settings GET 把密钥掩码，不外泄明文', async () => {
  const { ctx, routes } = makeCtx({
    connection: { isTrusted: () => true, requestRejection: () => null },
  })
  plugin.apply(ctx)
  const res = fakeRes()
  await find(routes, '/settings').handler(fakeReq(), res)
  assert.equal(res.out.code, 200)
  const j = JSON.parse(res.out.body)
  assert.equal(typeof j.config, 'object')
  const key = String(j.config?.ai?.apiKey ?? '')
  assert.ok(!/^sk-/.test(key), '明文密钥泄漏：' + key.slice(0, 6))
})

test('persona 超大输入被拒', async () => {
  const { ctx, routes } = makeCtx({
    connection: { isTrusted: () => true, requestRejection: () => null },
  })
  plugin.apply(ctx)
  const r = find(routes, '/persona')
  if (!r) return
  const res = fakeRes()
  await r.handler(postReq({ text: 'x'.repeat(30000) }), res)
  assert.equal(res.out.code, 400, '超长人设应被拒，实际 ' + res.out.code)
})
