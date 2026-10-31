// 监听判定：四类源的触发条件、白黑名单、时间窗。不发任何网络请求。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, inWindow } from '../tools/lib/watch.mjs'

const ME = { uid: '10000002', nickname: 'tester' }
const base = (over = {}) => ({
  listen: {
    allDay: true,
    oncePerPerson: true,
    forum: { enabled: true, items: [{ id: '23064', title: '爆友生活区' }], allowUsers: [], denyUsers: [], allowForums: [], denyForums: [], allowTopics: [], denyTopics: [] },
    topic: { enabled: true, items: [{ id: '1000001' }], floors: true, comments: true, allowUsers: [], denyUsers: [], allowForums: [], denyForums: [], allowTopics: [], denyTopics: [] },
    atme: { enabled: true, allowUsers: [], denyUsers: [], allowForums: [], denyForums: [], allowTopics: [], denyTopics: [] },
    at: { enabled: true, onlyFriend: false, items: [], forums: [], allowUsers: [], denyUsers: [], allowForums: [], denyForums: [], allowTopics: [], denyTopics: [] },
    ...over,
  },
  owner: { uid: '11111', name: '大号' },
  self: { uid: ME.uid, name: ME.nickname },
})

const floor = (over = {}) => ({
  source: 'topic', kind: 'floor', sectionId: '23064', sectionTitle: '爆友生活区',
  topicId: '1000001', topicTitle: '测试帖', floorId: '2000003', position: '4楼',
  uid: '22222', nickname: '路人', content: '随便说点什么', ...over,
})

test('@ 我 才回', () => {
  const cfg = base()
  assert.equal(evaluate(cfg, floor({ content: '路过看看' }), ME).action, 'skip')
  assert.equal(evaluate(cfg, floor({ content: '@tester 在吗' }), ME).action, 'reply')
})

test('自己发的不回', () => {
  const cfg = base()
  assert.equal(evaluate(cfg, floor({ uid: ME.uid, content: '@tester 我自己' }), ME).why, 'self')
})

test('大号 @ 我直接回，不走名单', () => {
  const cfg = base()
  // 大号 @ 我：不用加好友、不进白名单，直接放行
  const r = evaluate(cfg, floor({ uid: '11111', content: '@tester 总结一下' }), ME)
  assert.equal(r.action, 'reply')
  assert.equal(r.why, 'owner')
  // 名单拦不住大号（主人优先）
  cfg.listen.at.denyUsers = ['11111']
  assert.equal(evaluate(cfg, floor({ uid: '11111', content: '@tester 总结一下' }), ME).action, 'reply')
})

test('大号没 @ 我也不回（不许乱发评论）', () => {
  const cfg = base()
  const r = evaluate(cfg, floor({ uid: '11111', content: '今天吃什么' }), ME)
  assert.equal(r.action, 'skip')
  assert.equal(r.why, 'no-trigger')
})

test('黑名单里的用户 @ 我也不回', () => {
  const cfg = base()
  cfg.listen.at.denyUsers = ['22222']
  const r = evaluate(cfg, floor({ content: '@tester 在吗' }), ME)
  assert.equal(r.action, 'skip')
  assert.equal(r.why, 'at-user-deny')
})

test('白名单非空时名单外的人不回', () => {
  const cfg = base()
  cfg.listen.at.allowUsers = ['33333']
  assert.equal(evaluate(cfg, floor({ content: '@tester 在吗' }), ME).action, 'skip')
  assert.equal(evaluate(cfg, floor({ uid: '33333', content: '@tester 在吗' }), ME).action, 'reply')
})

test('at 的帖子白名单限制生效', () => {
  const cfg = base()
  cfg.listen.at.allowTopics = ['1000002']
  const r = evaluate(cfg, floor({ content: '@tester 在吗' }), ME)
  assert.equal(r.action, 'skip')
  assert.equal(r.why, 'at-topic-not-allowed')
})

test('源自己的名单独立生效', () => {
  const cfg = base()
  cfg.listen.topic.denyUsers = ['22222']
  const r = evaluate(cfg, floor({ content: '@tester 在吗' }), ME)
  // at 名单放行，但 topic 源名单拦下
  assert.equal(r.action, 'skip')
  assert.equal(r.why, 'topic-user-deny')
})

test('论坛板块白名单拦下非目标板块', () => {
  const cfg = base()
  cfg.listen.forum.allowForums = ['6044']
  const c = { source: 'forum', kind: 'topic', sectionId: '23064', sectionTitle: '爆友生活区', topicId: '1', uid: '22222', nickname: '路人', content: '@tester 你好' }
  assert.equal(evaluate(cfg, c, ME).why, 'forum-forum-not-allowed')
})

/* ───── @ 我通知源：平台已确认「有人 @ 了你」，不再拿正文匹配一遍 ───── */

// 通知源真正的形态：to_info 是 <kb-contact data-id="..."/> 富文本，正文没有字面 @
const notice = (over = {}) => floor({
  source: 'atme', kind: 'floor', content: '<kb-contact data-id="10000002" data-value="@tester"/>总结一下',
  noticeId: '50000001', ...over,
})

test('@ 我通知：富文本 @ 认得出来（triggerMode=plain 也不会被挡）', () => {
  const cfg = base({ triggerMode: 'plain' })
  const r = evaluate(cfg, notice(), ME)
  // 正文里没有字面 @tester，靠平台通知本身成立
  assert.equal(r.action, 'reply')
  assert.equal(r.via, 'notice')
})

test('@ 我通知：source 关掉就一条都不回', () => {
  const cfg = base({ atme: { enabled: false, allowUsers: [], denyUsers: [], allowForums: [], denyForums: [], allowTopics: [], denyTopics: [] } })
  const r = evaluate(cfg, notice(), ME)
  assert.equal(r.action, 'skip')
  assert.equal(r.why, 'atme-off')
})

test('@ 我通知：at.items（额外盯的帖子）不限制通知源', () => {
  const cfg = base()
  cfg.listen.at.items = [{ id: '9999999' }]
  // 通知里的是别的帖子，但通知源是全站的 @，不该被这个清单挡掉
  assert.equal(evaluate(cfg, notice(), ME).action, 'reply')
  // 普通帖子源扫到的内容仍然受它限制
  assert.equal(evaluate(cfg, floor({ content: '@tester 在吗' }), ME).why, 'at-topic-not-allowed')
})

test('@ 我通知：自己的 @ 和不认识的人照样走名单', () => {
  const cfg = base()
  assert.equal(evaluate(cfg, notice({ uid: ME.uid }), ME).why, 'self')
  cfg.listen.atme.denyUsers = ['22222']
  assert.equal(evaluate(cfg, notice(), ME).why, 'atme-user-deny')
})

test('时间窗', () => {
  const cfg = base({ allDay: false, windows: [{ start: '08:00', end: '12:00' }] })
  assert.equal(inWindow(cfg, new Date(2026, 0, 1, 9, 0)), true)
  assert.equal(inWindow(cfg, new Date(2026, 0, 1, 13, 0)), false)
  const cross = base({ allDay: false, windows: [{ start: '22:00', end: '06:00' }] })
  assert.equal(inWindow(cross, new Date(2026, 0, 1, 23, 0)), true)
  assert.equal(inWindow(cross, new Date(2026, 0, 1, 2, 0)), true)
  assert.equal(inWindow(cross, new Date(2026, 0, 1, 12, 0)), false)
})
