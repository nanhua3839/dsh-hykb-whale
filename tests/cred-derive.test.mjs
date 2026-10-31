import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { uidFromPauth, nicknameFromPauth, deriveCred } from '../tools/lib/cred.mjs'
import { credentialsPath } from '../tools/lib/paths.mjs'
import plugin from '../lib/index.js'

// Pauth 形状（虚构数据）：uid|nickname|avatar|credential|expires|sign|hmac
const PAUTH = '10000001|%E6%B5%8B%E8%AF%95%E5%B0%8F%E5%8F%B7|https%3A%2F%2Fexample.com%2Favatar.png|00000000000000000000000000000000|1824988330|1|00000000000000000000000000000000'

test('uid 从 Pauth 第 1 段解出来', () => {
  assert.equal(uidFromPauth(PAUTH), '10000001')
  assert.equal(uidFromPauth(''), '')
  assert.equal(uidFromPauth('abc|def'), '', '非纯数字不算 uid')
})

test('nickname 从 Pauth 第 2 段解出来并解码', () => {
  assert.equal(nicknameFromPauth(PAUTH), '测试小号')
  assert.equal(nicknameFromPauth('123'), '')
})

test('昵称里带竖线时按段数差拼回来', () => {
  // 服务端靠 (总段数 - 7) 判断昵称占了几段
  const pauth = '42|a|b|http://x|cred|1800000000|1|sign'
  assert.equal(nicknameFromPauth(pauth), 'a|b')
  assert.equal(uidFromPauth(pauth), '42')
})

test('deriveCred 补齐 uid 与 nickname，且不改入参', () => {
  const src = { Pauth: PAUTH }
  const out = deriveCred(src)
  assert.equal(out.uid, '10000001')
  assert.equal(out.nickname, '测试小号')
  assert.equal(src.uid, undefined, '入参不应被改写')
  // 已给的字段优先，不被推导覆盖
  const keep = deriveCred({ uid: '999', nickname: '手填', Pauth: PAUTH })
  assert.equal(keep.uid, '999')
  assert.equal(keep.nickname, '手填')
})

// ── 路由级：只给 Pauth 也必须能写入，uid 由服务端自己解 ──
const LOOPBACK = { host: '127.0.0.1:51548' }
function fakeRes() {
  const out = { code: 0, body: '' }
  return { out, setHeader() {}, writeHead(c) { out.code = c }, end(b) { out.body = String(b || '') }, writableEnded: false }
}
function postReq(body) {
  const handlers = {}
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const req = {
    method: 'POST', url: '/', headers: LOOPBACK, body: raw,
    on(ev, fn) {
      if (ev === 'data' && raw) queueMicrotask(() => fn(Buffer.from(raw, 'utf8')))
      if (ev === 'end') queueMicrotask(() => fn())
      return req
    },
    resume() {}, destroy() {}, socket: { remoteAddress: '127.0.0.1' },
  }
  return req
}
function setup() {
  const routes = []
  const ctx = {
    effect: (fn) => { fn() },
    get: () => ({ isTrusted: () => true, requestRejection: () => null }),
    webServer: { register: (o) => { routes.push(o); return () => {} } },
  }
  plugin.apply(ctx)
  return routes.find((x) => String(x.path || x.pathname).endsWith('/cookie'))
}

test('/cookie 只给 Pauth 也能写入，uid/nickname 自动解出', async () => {
  const file = credentialsPath()
  let backup = null
  try { backup = fs.readFileSync(file, 'utf8') } catch {}
  try {
    const route = setup()
    const res = fakeRes()
    await route.handler(postReq({ Pauth: PAUTH }), res)
    assert.equal(res.out.code, 200, '回包：' + res.out.body)
    const j = JSON.parse(res.out.body)
    assert.equal(j.ok, true)
    assert.equal(j.uid, '10000001')
    assert.equal(j.nickname, '测试小号')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.uid, '10000001')
    assert.equal(saved.Pauth, PAUTH)
  } finally {
    if (backup === null) { try { fs.unlinkSync(file) } catch {} }
    else fs.writeFileSync(file, backup)
  }
})

test('/cookie 的 Pauth 第 1 段不是数字时明确报错，不落盘', async () => {
  const file = credentialsPath()
  let backup = null
  try { backup = fs.readFileSync(file, 'utf8') } catch {}
  try {
    const route = setup()
    const res = fakeRes()
    await route.handler(postReq({ Pauth: 'not-a-uid|x|y' }), res)
    assert.equal(res.out.code, 400)
    assert.match(JSON.parse(res.out.body).error, /Pauth/)
    assert.equal(fs.readFileSync(file, 'utf8'), backup, '拒绝时不得改凭据文件')
  } finally {
    if (backup === null) { try { fs.unlinkSync(file) } catch {} }
    else fs.writeFileSync(file, backup)
  }
})
