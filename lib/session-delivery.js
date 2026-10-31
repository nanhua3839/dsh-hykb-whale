import fs from 'node:fs'
import path from 'node:path'

/**
 * 把一段任务书投递给「她自己的那个会话」。
 *
 * 为什么要单独一个模块：会话选择、串行队列、状态持久化三件事必须在一处，
 * 否则两处同时投递会开出两个会话，上下文就断了。
 *
 * 状态落在 ~/.dsh/hykb-session.json：{ id, startedAt, deliveredAt, personaHash }。
 * 文件坏了直接抛错 —— 宁可停在这里，也不要静默新建一个会话让她失忆。
 */
export function createSessionDelivery({ controller, dshHome, cwd, sessionId, persona = () => '', now = Date.now, log = () => {} }) {
  const file = path.join(dshHome, 'hykb-session.json')
  let state = { id: sessionId, startedAt: now() }
  let ready = false
  let tail = Promise.resolve()

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof saved.id !== 'string' || !saved.id) throw new Error('invalid state')
    state = saved
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('会话状态损坏，检查 ' + file + '（避免误建会话）：' + e.message)
  }

  function save(next) {
    fs.mkdirSync(dshHome, { recursive: true })
    const tmp = file + '.' + Math.random().toString(36).slice(2) + '.tmp'
    try { fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n'); fs.renameSync(tmp, file) }
    finally { try { fs.rmSync(tmp, { force: true }) } catch {} }
  }

  return {
    get sessionId() { return state.id },
    /** 串行投递：一次只投一条，失败不重投（由调用方下一轮重试）。 */
    send(request, signal) {
      const job = tail.then(async () => {
        signal?.throwIfAborted?.()
        if (!ready) {
          try { await controller.create({ sessionId: state.id, cwd }) }
          catch (e) { log('沿用现有会话；若投递失败将保留重试状态：' + e.message) }
        }
        ready = true
        signal?.throwIfAborted?.()
        const block = String(persona() || '').trim()
        const content = [...(request.content ?? [])]
        if (block) {
          if (content[0]?.type === 'text') content[0] = { ...content[0], text: block + '\n\n' + content[0].text }
          else content.unshift({ type: 'text', text: block })
        }
        try { await controller.prompt({ ...request, sessionId: state.id, content }, signal) }
        catch (e) { ready = false; throw e }
        state = { ...state, deliveredAt: now() }
        try { save(state) } catch (e) { log('已投递，但保存会话状态失败：' + e.message) }
      })
      tail = job.catch(() => {})
      return job
    },
  }
}
