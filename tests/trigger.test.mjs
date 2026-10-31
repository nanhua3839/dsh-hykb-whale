import test from 'node:test'
import assert from 'node:assert/strict'
import { matchTrigger } from '../tools/lib/trigger.mjs'

const me = { uid: '10000002', nickname: 'tester' }

test('富文本 kb-contact 三种引号写法都算触发', () => {
  assert.equal(matchTrigger('<kb-contact data-id="10000002" data-value="@tester"/> 在吗', me).via, 'rich')
  assert.equal(matchTrigger("<kb-contact data-id='10000002' /> x", me).via, 'rich')
  assert.equal(matchTrigger('<kb-contact data-id=10000002 /> x', me).via, 'rich')
})

test('纯文本 @昵称 算触发', () => {
  assert.equal(matchTrigger('@tester 在吗', me).via, 'plain')
  assert.equal(matchTrigger('@tester在吗', me).via, 'plain')
  assert.equal(matchTrigger('@tester, 在吗', me).via, 'plain')
})

test('更长昵称不算叫我', () => {
  assert.equal(matchTrigger('@tester2 不是叫我', me).hit, false)
  assert.equal(matchTrigger('@tester_ 不是叫我', me).hit, false)
})

test('无关内容不触发', () => {
  assert.equal(matchTrigger('随便说点什么 @someone', me).hit, false)
  assert.equal(matchTrigger('', me).hit, false)
  assert.equal(matchTrigger(undefined, me).hit, false)
})

test('没配昵称时只认富文本', () => {
  const n = { uid: '10000002' }
  assert.equal(matchTrigger('@tester 在吗', n).hit, false)
  assert.equal(matchTrigger('<kb-contact data-id="10000002"/> x', n).hit, true)
})
