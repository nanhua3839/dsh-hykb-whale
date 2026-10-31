import path from 'node:path'
import { createSessionDelivery } from './session-delivery.js'

const TICK_MS = 60_000

/**
 * 刷帖时钟 —— 插件宿主自己 tick，到点跑一轮日报，然后叫醒她的会话。
 *
 * 与 bili 版的差别：这里不做"随机作息"，只做固定间隔 + 时间窗。
 * 刷帖是阅读行为，不需要拟人化的随机；需要的是别在凌晨刷。
 *
 * 为什么叫醒会话而不是只写文件：
 * 日报落盘只是材料。让她读到、挑出要说的、再推给主人，才是"她真的刷过"。
 */
export function startBrowseClock(ctx, { dshHome, cwd, readConfig, loadTool, log = () => {} }) {
  const state = { running: false, lastRunAt: 0, lastError: null, lastResult: null, timer: null, waking: false }
  let stopped = false
  // 服务要么挂在 ctx 上、要么走 ctx.get()；两种都试，否则会误报"没有 sessionController"
  const controller = ctx?.sessionController
    || (typeof ctx?.get === 'function' ? ctx.get('sessionController') : null)
    || null

  const delivery = controller
    ? createSessionDelivery({
        controller,
        dshHome,
        cwd,
        sessionId: (readConfig().browse?.sessionId || 'hykb-whale'),
        persona: () => {
          const p = readConfig().persona || {}
          const bits = []
          if (p.name) bits.push('你是「' + p.name + '」')
          if (p.ownerTitle) bits.push('称用户「' + p.ownerTitle + '」')
          if (p.style) bits.push('风格：' + p.style)
          return bits.length ? '［身份］' + bits.join('，') + '。' : ''
        },
        log,
      })
    : null

  function inWindow(now = new Date()) {
    const B = readConfig().browse || {}
    if (B.allDay !== false) return true
    const wins = Array.isArray(B.windows) && B.windows.length ? B.windows : [{ start: '08:00', end: '24:00' }]
    const cur = now.getHours() * 60 + now.getMinutes()
    const toMin = (s) => {
      const [h, m] = String(s || '0:0').split(':').map(Number)
      return (Number(h) || 0) * 60 + (Number(m) || 0)
    }
    return wins.some((w) => {
      const a = toMin(w.start), b = toMin(w.end)
      return a <= b ? cur >= a && cur < b : cur >= a || cur < b
    })
  }

  /** 叫醒她：给她一段任务书，让她自己去读日报、挑话、推送。 */
  function wakeText(stats, file) {
    const cfg = readConfig()
    const B = cfg.browse || {}
    return [
      '【刷帖】你刚扫完一轮论坛，日报已经写好。',
      '',
      '扫了 ' + stats.scanned + ' 帖，选了 ' + stats.picked.length + ' 帖，文件：' + file,
      B.autoReply && stats.replied ? '已经自动回了 ' + stats.replied + ' 条高分帖。' : '',
      stats.post?.status === 'posted' ? '日报已经发成帖子：「' + stats.post.title + '」（板块 ' + (stats.post.section?.title || stats.post.section?.id) + '）。' : '',
      stats.post?.status === 'failed' ? '日报发帖失败：' + stats.post.reason : '',
      '',
      '接下来按顺序做（不要等我说话）：',
      '1) 读上面那份日报，确认里面有没有写错或编造的地方；有就改。',
      '2) 从里面挑 1-3 件你觉得「主人会想知道」的，写成一段话，直接说事，不要复述整份日报。',
      '3) 如果这一轮没什么可说的，就只写一句「今天没什么」，不要凑。',
      '4) 把第 2 步那段话发给我。',
    ].filter(Boolean).join('\n')
  }

  async function tick() {
    if (stopped || state.running) return
    const cfg = readConfig()
    const B = cfg.browse || {}
    if (!B.enabled) { state.lastError = null; return }
    if (!inWindow()) return
    const wait = Math.max(5, Number(B.intervalSec) || 3600) * 1000
    if (Date.now() - state.lastRunAt < wait) return

    state.running = true
    state.lastRunAt = Date.now()
    try {
      const digest = await loadTool('digest.mjs')
      const stats = await digest.runDigest(cfg, { dryRun: false, log })
      state.lastError = null
      state.lastResult = {
        at: new Date().toISOString(),
        scanned: stats.scanned,
        picked: stats.picked.length,
        replied: stats.replied,
        file: stats.file,
        post: stats.post ? { status: stats.post.status, title: stats.post.title || '', reason: stats.post.reason || '' } : null,
      }
      log('[browse] 本轮：扫 ' + stats.scanned + ' 帖，选 ' + stats.picked.length + ' 帖，回 ' + stats.replied + ' 条')

      if (B.wake && stats.picked.length && delivery && !state.waking) {
        state.waking = true
        try {
          await delivery.send({
            requestId: 'hykb-browse-' + Date.now(),
            mode: 'queue',
            content: [{ type: 'text', text: wakeText(stats, stats.file) }],
          })
          log('[browse] 已叫醒会话 ' + delivery.sessionId)
        } catch (e) {
          log('[browse] 叫醒失败：' + e.message)
        } finally { state.waking = false }
      }
    } catch (e) {
      state.lastError = String(e?.message ?? e)
      log('[browse] 本轮失败：' + state.lastError)
    } finally {
      state.running = false
    }
  }

  function schedule() {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => { tick().catch(() => {}).finally(() => { if (!stopped) schedule() }) }, TICK_MS)
    if (state.timer.unref) state.timer.unref()
  }

  schedule()

  return {
    status: () => ({
      enabled: !!readConfig().browse?.enabled,
      running: state.running,
      waking: state.waking,
      hasSession: !!delivery,
      sessionId: delivery ? delivery.sessionId : null,
      lastRunAt: state.lastRunAt || null,
      lastError: state.lastError,
      lastResult: state.lastResult,
    }),
    runNow: () => tick(),
    stop() { stopped = true; clearTimeout(state.timer) },
  }
}
