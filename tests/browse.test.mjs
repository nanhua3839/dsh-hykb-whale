import test from 'node:test'
import assert from 'node:assert/strict'
import { score, rank, markPicked } from '../tools/lib/browse.mjs'
import { tidy, tidyFloors } from '../tools/lib/ai.mjs'

const NOW = Date.parse('2026-10-31T12:00:00Z')

const mk = (over = {}) => ({
  topicId: '1', title: 't', sectionId: '23064', sectionTitle: '爆友生活区',
  uid: 'u1', nickname: 'n1', content: '',
  replyCount: 0, commentCount: 0, upVote: 0, views: 0,
  isEssence: false, isTop: false, timeMs: NOW, ...over,
})

const emptySeen = () => ({ replies: {}, people: {} })

test('score 按权重线性叠加', () => {
  const s = score(mk({ replyCount: 10, commentCount: 4, upVote: 5, views: 300, timeMs: 0 }), {}, NOW)
  // 10*3 + 4*1 + 5*2 + 300*0.01 = 30+4+10+3 = 47
  assert.equal(s, 47)
})

test('score 对新鲜帖加分、对老帖衰减', () => {
  const fresh = score(mk({ timeMs: NOW }), {}, NOW)
  const day = score(mk({ timeMs: NOW - 86400000 }), {}, NOW)
  const week = score(mk({ timeMs: NOW - 7 * 86400000 }), {}, NOW)
  assert.ok(fresh > day && day > week)
  assert.equal(fresh, 6)   // 刚发的拿满 fresh 分
  assert.equal(day, 3)     // 半衰期 24h → 减半
})

test('score 认精华与置顶', () => {
  assert.equal(score(mk({ isEssence: true }), {}, NOW), 6 + 8)
  assert.equal(score(mk({ isTop: true }), {}, NOW), 6 + 2)
})

test('rank 降序、过 minScore、按 pick 截断', () => {
  const cfg = { browse: { pick: 2, minScore: 10 } }
  const cands = [
    mk({ topicId: 'a', replyCount: 1 }),      // 3 + 6 = 9 → 低于线
    mk({ topicId: 'b', replyCount: 5 }),      // 15 + 6 = 21
    mk({ topicId: 'c', replyCount: 9 }),      // 27 + 6 = 33
    mk({ topicId: 'd', replyCount: 7 }),      // 21 + 6 = 27
  ]
  const { picks, ranked } = rank(cfg, cands, { now: NOW, seen: emptySeen(), fresh: false })
  assert.deepEqual(ranked.map((x) => x.topicId), ['c', 'd', 'b', 'a'])
  assert.deepEqual(picks.map((x) => x.topicId), ['c', 'd'])
})

test('rank 的 fresh 模式跳过已进过日报的帖子', () => {
  const cfg = { browse: { pick: 5 } }
  const cands = [mk({ topicId: 'a', replyCount: 9 }), mk({ topicId: 'b', replyCount: 8 })]
  const seen = emptySeen()
  markPicked(seen, [{ topicId: 'a', score: 1 }])
  const { picks } = rank(cfg, cands, { now: NOW, seen, fresh: true })
  assert.deepEqual(picks.map((x) => x.topicId), ['b'])
})

test('rank 尊重黑名单（先黑后白）', () => {
  const cfg = { browse: { pick: 5, denyUsers: ['u1'] } }
  const { picks } = rank(cfg, [mk({ topicId: 'a', replyCount: 9 })], { now: NOW, seen: emptySeen(), fresh: false })
  assert.equal(picks.length, 0)
})

test('tidy 折叠重复 emoji 与重复短语', () => {
  assert.equal(tidy('恭喜🎉🎉🎉🎉🎉🎉'), '恭喜🎉')
  assert.equal(tidy('哈哈哈哈哈哈哈哈哈哈'), '哈')
  assert.equal(tidy('<b>加粗</b>  正文'), '加粗 正文')
  assert.equal(tidy('一二三四五六七八九十', 4), '一二三四…')
})

test('tidyFloors 去重并丢掉纯 emoji / 过短楼层', () => {
  const out = tidyFloors([
    { nickname: 'a', content: '恭喜🎉🎉🎉' },
    { nickname: 'b', content: '恭喜🎉🎉🎉' },
    { nickname: 'c', content: '🎉' },
    { nickname: 'd', content: '这个二游定义我觉得要看内容导向' },
  ], { max: 8, len: 90 })
  assert.equal(out.length, 2)
  assert.equal(out[0].nickname, 'a')
  assert.equal(out[1].nickname, 'd')
})
