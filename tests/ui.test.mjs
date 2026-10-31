/**
 * 设置页静态渲染测试 —— 没有浏览器也要能验：
 *   1. FIELDS 里每个 path 都真的存在于配置默认值（写错路径 = 界面上是个空框，不报错）
 *   2. 每张卡都能渲染出来，不出现 undefined / NaN / [object Object] 漏到文本里
 *   3. 卡片序号连续、不重号
 *
 * 做法：假 window.__ModuleLoader__ + 假 react（hooks 按调用顺序返回预设值），
 *      递归展开函数组件拿到完整元素树，再遍历取文本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')

/** 假 react：createElement 造朴素节点，hooks 按顺序取值 */
function makeReact(overrides = {}) {
  let i = 0
  const take = (init) => (i - 1 in overrides ? overrides[i - 1] : init)
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false && c !== true) }),
    useState(init) { i += 1; const v = take(init); return [v, () => {}] },
    useCallback(fn) { i += 1; take(fn); return fn },
    useMemo(fn) { i += 1; take(fn); return fn() },
    useEffect() { i += 1 },
    useRef(v) { i += 1; take(v); return { current: v } },
    __reset() { i = 0 },
  }
  return React
}

/** 递归展开：函数组件直接调用，返回元素树 */
function expand(node, depth = 0) {
  if (node == null || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => expand(n, depth))
  if (typeof node.type === 'function') {
    if (depth > 40) throw new Error('组件递归过深：' + (node.type.name || '?'))
    return expand(node.type({ ...node.props, children: node.children }), depth + 1)
  }
  return { ...node, children: (node.children || []).map((c) => expand(c, depth + 1)) }
}

function texts(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  for (const c of node.children || []) texts(c, out)
  return out
}

function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children || []) collect(c, pred, out)
  return out
}

/** 从磁盘读默认配置（工具链那份，最全） */
async function defaults() {
  const mod = await import(pathToFileURL(path.join(HERE, '..', 'tools', 'lib', 'config.mjs')).href)
  return mod.DEFAULTS || mod.default || null
}

async function loadClient(overrides) {
  const src = fs.readFileSync(CLIENT, 'utf8')
  let factory = null
  const React = makeReact(overrides)
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f } } },
    document: { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } },
  }
  const fn = new Function('window', 'document', src)
  fn(sandbox.window, sandbox.document)
  assert.ok(factory, 'client.js 没有调用 window.__ModuleLoader__.load')
  const mod = factory((name) => {
    if (name !== 'react') throw new Error('未知依赖：' + name)
    return React
  })
  return { mod, React }
}

test('FIELDS 里每个 path 都存在于默认配置', async () => {
  const { mod } = await loadClient()
  const D = await defaults()
  assert.ok(D, '读不到 tools/lib/config.mjs 的 DEFAULTS')
  const missing = []
  for (const f of mod.FIELDS) {
    const v = f.path.reduce((o, k) => (o == null ? undefined : o[k]), D)
    if (v === undefined) missing.push(f.path.join('.'))
  }
  assert.deepEqual(missing, [], '这些字段路径在配置里不存在：' + missing.join(', '))
})

test('FIELDS 的 sec 都有对应卡片、字段不重复', async () => {
  const { mod } = await loadClient()
  const secs = new Set(mod.FIELDS.map((f) => f.sec))
  assert.deepEqual([...secs].sort(), ['ai', 'browse', 'reply', 'risk', 'who'])
  const seen = new Set()
  for (const f of mod.FIELDS) {
    const k = f.path.join('.')
    assert.ok(!seen.has(k), '字段重复定义：' + k)
    seen.add(k)
  }
})

test('整页能渲染：卡片序号连续、无 undefined / NaN 漏进文本', async () => {
  const D = await defaults()
  const status = {
    ok: true,
    credentials: { present: true, uid: '123', nickname: '大肥鱼', hasPauth: true },
    aiReady: true,
    traffic: { readHour: 1, readDay: 2, writeHour: 3, writeDay: 4 },
    listen: { running: false, lastTickAt: null, lastError: null },
    browse: { enabled: true, hasSession: true, lastRunAt: null, lastError: null, lastResult: { scanned: 115, picked: 8, replied: 0 } },
  }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbWhaleSection, {}))
  const all = texts(tree).join(' ')
  assert.ok(all.includes('快爆小号'), '页头没渲染出来')
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!all.includes(bad), '文本里漏出了 ' + bad)
  }

  const cards = collect(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className === 'hkw-card')
  assert.ok(cards.length >= 6, '卡片数不对：' + cards.length)
  const nos = collect(tree, (n) => n.props && n.props.className === 'hkw-no').map((n) => texts(n).join(''))
  assert.deepEqual(nos, ['1', '2', '3', '4', '5', '6'])
})

test('必做步骤缺一项时状态条会标红', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: false }, aiReady: false, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: false, hasSession: false } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbWhaleSection, {}))
  const dots = collect(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className === 'hkw-dot')
    .map((n) => n.props['data-s'])
  assert.ok(dots.includes('bad'), '未登录 / 未接 AI 时应该有红灯')
  const all = texts(tree).join(' ')
  assert.ok(all.includes('未登录') && all.includes('未配置'), '状态文字不对')
  assert.ok(all.includes('宿主无会话能力'), '没有会话能力时应该显式提示')
})

test('没有保存按钮，只留一行自动保存状态', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: true, hasSession: true } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbWhaleSection, {}))

  const saveBtns = collect(tree, (n) => n.type === 'button' && texts(n).join('').trim() === '保存')
  assert.equal(saveBtns.length, 0, '保存按钮应该已经删掉了')
  assert.equal(collect(tree, (n) => n.props && n.props.className === 'hkw-bar').length, 0, '浮动保存条应该已经删掉了')

  const rows = collect(tree, (n) => n.props && n.props.className === 'hkw-saverow')
  assert.equal(rows.length, 1, '应该有一行保存状态')
  assert.match(texts(rows[0]).join(''), /自动保存/, '空闲时要说明改完自己会存')
})

test('点一下开关就自动 POST 配置，不用再点保存', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: true, hasSession: true } }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opt) => {
    const method = (opt && opt.method) || 'GET'
    calls.push({ url, method, body: opt && opt.body })
    const payload = String(url).endsWith('/status') ? status : { ok: true, config: D }
    return { json: async () => payload }
  }
  try {
    const { mod, React } = await loadClient({ 0: D, 1: status })
    React.__reset()
    const tree = expand(React.createElement(mod.HykbWhaleSection, {}))
    const switches = collect(tree, (n) => n.type === 'button' && n.props.role === 'switch')
    assert.ok(switches.length > 0, '页面上应该有关关')
    switches[0].props.onClick()
    assert.equal(calls.length, 0, '点完不该立刻发请求，要先去抖')
    await new Promise((r) => setTimeout(r, 500))
    const posts = calls.filter((c) => c.method === 'POST' && String(c.url).endsWith('/settings'))
    assert.equal(posts.length, 1, '去抖结束后应该自动提交一次配置')
    assert.ok(JSON.parse(posts[0].body).config, 'POST 体里应该带整份配置')
  } finally {
    globalThis.fetch = realFetch
  }
})
