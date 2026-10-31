// 去重账本：两个进程同时写不能互相覆盖（watch 监听与同日报告是两条独立链路）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-seen-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })

const { loadSeen, saveSeen, markReply, seenReply, markPerson, seenPerson } = await import('../tools/lib/state.mjs')

test('两个读取方交错保存，两边的记录都要活下来', () => {
  const a = loadSeen()
  const b = loadSeen()
  markReply(a, 'f:111:222', { replied: true })
  saveSeen(a)
  markReply(b, 'b:333', { digest: true })
  saveSeen(b)
  const now = loadSeen()
  assert.ok(seenReply(now, 'f:111:222'), 'a 写的楼层记录被 b 覆盖了')
  assert.ok(seenReply(now, 'b:333'), 'b 自己写的记录丢了')
})

test('删除是删除，不会被旧快照复活', () => {
  const s = loadSeen()
  delete s.replies['f:111:222']
  saveSeen(s)
  assert.equal(seenReply(loadSeen(), 'f:111:222'), false)
})

test('bootstrap 标记等顶层键不会被合并逻辑写丢', () => {
  const s = loadSeen()
  s.__primed = true
  s.__primedAt = 1712345678901
  saveSeen(s)
  const now = loadSeen()
  assert.equal(now.__primed, true)
  assert.equal(now.__primedAt, 1712345678901)
  // 取消 bootstrap 也要生效
  delete now.__primed
  saveSeen(now)
  assert.equal('__primed' in loadSeen(), false)
})

test('同一人 N 天冷却照旧', () => {
  const s = loadSeen()
  markPerson(s, '9001')
  saveSeen(s)
  assert.equal(seenPerson(loadSeen(), '9001', 30), true)
})

test('写入完成后不残留锁文件', () => {
  const lock = path.join(home, '.hykb-ai', 'seen.json.lock')
  assert.equal(fs.existsSync(lock), false)
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
