// 刷帖 dry-run：不能落盘、不能把候选标记成已读、不能毒化第二天的选帖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-digest-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
const digestDir = path.join(home, '.dsh', 'hykb-work')
fs.mkdirSync(digestDir, { recursive: true })

const { runDigest } = await import('../tools/lib/digest.mjs')
const { loadSeen, seenReply } = await import('../tools/lib/state.mjs')

// gather 会真的出网，这里把 fetch 换成"板块里恰好有 2 帖"的桩，
// 测试只验证 dry-run 的副作用边界，不验证抓取逻辑。
const realFetch = globalThis.fetch
let seq = 0
globalThis.fetch = async (url) => {
  seq++
  const u = String(url)
  if (u.includes('section_topic')) {
    return new Response(JSON.stringify({ code: 100, result: { data: [
      { id: '111', title: 'A 帖', uid: '1', user: { nickname: '甲' }, content: 'a', time_str: '刚刚', reply_count: 1, time: String(Date.now()).slice(0, 10) },
      { id: '222', title: 'B 帖', uid: '2', user: { nickname: '乙' }, content: 'b', time_str: '刚刚', reply_count: 1, time: String(Date.now()).slice(0, 10) },
    ], last_id: '0', cursor: 0 } }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: 100, result: {} }), { status: 200 })
}
const cfg = {
  browse: { sections: ['23064'], pages: 1, pick: 8, deep: 0, autoReply: false, replyMax: 0, minScore: 0, muteTitles: [], skipTop: true, allDay: true },
  risk: { minGapMs: 0, readHourly: 1000, readDaily: 1000, writeHourly: 100, writeDaily: 100, writeGapSec: 0, backoffOnBlock: [1] },
  ai: {},
  persona: {},
}

// 把 gather 与 chat 换成 stub：本地不联网
test('dry-run 扫到了帖，但不写日报文件', async () => {
  const before = fs.readdirSync(digestDir).length
  const r = await runDigest(cfg, { dryRun: true })
  assert.ok(r.scanned >= 2, '桩里至少两帖，实际 ' + r.scanned)
  assert.equal(fs.readdirSync(digestDir).length, before, 'dry-run 不该产出日报文件')
  assert.equal(r.file, '', 'dry-run 不该有落盘路径')
})

test('dry-run 不把候选写进已读（否则当天正式跑就选不到）', async () => {
  const before = Object.keys(loadSeen().replies || {}).filter((k) => k.startsWith('b:')).length
  await runDigest(cfg, { dryRun: true })
  const after = Object.keys(loadSeen().replies || {}).filter((k) => k.startsWith('b:')).length
  assert.equal(after, before, 'dry-run 毒化了候选池')
})

test('真跑才写文件、才标记已读', async () => {
  const r = await runDigest(cfg, { dryRun: false, now: new Date() })
  assert.ok(r.picked.length >= 1, '真跑应当选到帖')
  const files = fs.readdirSync(digestDir).filter((f) => f.startsWith('digest-'))
  assert.equal(files.length, 1, '真跑应当落一份日报，实际 ' + files.join(','))
  const seen = loadSeen()
  assert.ok(seenReply(seen, 'b:111') || seenReply(seen, 'b:222'), '真跑应当标记已读')
})

test.after(() => { globalThis.fetch = realFetch; fs.rmSync(home, { recursive: true, force: true }) })
