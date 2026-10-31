// 白黑名单语义：空名单=不限；黑名单优先；白名单非空则必须命中。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitList, makeFilter } from '../tools/lib/filter.mjs'

test('splitList 认中英文逗号、空格、换行', () => {
  assert.deepEqual(splitList('a,b，c d\ne'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(splitList(''), [])
  assert.deepEqual(splitList(['x ', ' y']), ['x', 'y'])
})

test('空名单全部放行', () => {
  const f = makeFilter({})
  assert.equal(f.user('1', '甲').ok, true)
  assert.equal(f.forum('23064', '爆友生活区').ok, true)
  assert.equal(f.topic('1000001').ok, true)
})

test('黑名单优先于白名单', () => {
  const f = makeFilter({ allowUsers: ['甲'], denyUsers: ['甲'] })
  const r = f.user('1', '甲')
  assert.equal(r.ok, false)
  assert.equal(r.why, 'user-deny')
})

test('白名单非空但没命中就拒', () => {
  const f = makeFilter({ allowUsers: ['乙'] })
  assert.equal(f.user('1', '甲').ok, false)
  assert.equal(f.user('1', '甲').why, 'user-not-allowed')
  assert.equal(f.user('2', '乙').ok, true)
})

test('uid 和昵称都参与匹配', () => {
  const f = makeFilter({ denyUsers: ['10000002'] })
  assert.equal(f.user('10000002', '随便什么名').ok, false)
  assert.equal(f.user('999', '随便什么名').ok, true)
})

test('板块认 id 也认板块名', () => {
  const f = makeFilter({ allowForums: ['爆友生活区'] })
  assert.equal(f.forum('23064', '爆友生活区').ok, true)
  assert.equal(f.forum('6044', '洛克王国：世界').ok, false)
  const g = makeFilter({ denyForums: ['23064'] })
  assert.equal(g.forum('23064', '爆友生活区').ok, false)
})

test('帖子认 id 也认链接形式', () => {
  const f = makeFilter({ denyTopics: ['1000001'] })
  assert.equal(f.topic('1000001').ok, false)
  assert.equal(f.topic('https://m.bbs.3839.com/post-1000001.htm').ok, false)
  assert.equal(f.topic('1000002').ok, true)
})
