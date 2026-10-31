// AI 层：OpenAI 兼容 /v1/chat/completions。没有 baseUrl/model/key 就直接抛错，不假装跑通。
import fs from 'node:fs'
import { config } from './config.mjs'
import { withTimeout, TIMEOUT_MS } from './traffic.mjs'
import { personaPath } from './paths.mjs'

/**
 * baseUrl 只允许 http(s)：它会被拼成 `baseUrl + '/chat/completions'` 再带上 Bearer 密钥发出去，
 * 填成 file:// 或别的协议时密钥会跟着请求跑到不该去的地方。
 * @returns {string} 归一化后的地址（去掉尾部斜杠）
 * @throws 协议或形态不合法
 */
export function aiEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim()
  if (!raw) throw new Error('AI 未配置：去设置页填 baseUrl / model / apiKey')
  let u
  try { u = new URL(raw) } catch { throw new Error('AI baseUrl 不是合法地址：' + raw) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('AI baseUrl 只支持 http/https，当前是 ' + u.protocol)
  }
  if (!u.hostname) throw new Error('AI baseUrl 缺少域名：' + raw)
  return raw.replace(/\/+$/, '')
}

export function aiReady() {
  const { ai } = config()
  if (!(ai.baseUrl && ai.model && ai.apiKey)) return false
  try { aiEndpoint(ai.baseUrl); return true } catch { return false }
}

export async function chat(messages, { temperature, maxTokens } = {}) {
  const { ai } = config()
  if (!ai.baseUrl || !ai.model || !ai.apiKey) {
    throw new Error('AI 未配置：去设置页填 baseUrl / model / apiKey')
  }
  const url = aiEndpoint(ai.baseUrl) + '/chat/completions'
  const res = await fetch(url, withTimeout({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ai.apiKey },
    body: JSON.stringify({
      model: ai.model,
      messages,
      temperature: temperature ?? ai.temperature ?? 0.7,
      max_tokens: maxTokens ?? ai.maxTokens ?? 800,
    }),
  }))
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error('AI 返回非 JSON：' + text.slice(0, 200)) }
  if (!res.ok) throw new Error('AI HTTP ' + res.status + '：' + (data.error?.message || text.slice(0, 200)))
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 返回空内容：' + JSON.stringify(data).slice(0, 300))
  return content.trim()
}

/**
 * 清洗一段论坛文本：去 HTML、压空白、折叠重复 emoji / 重复短语、限长。
 * 论坛楼层里常有「恭喜🎉🎉🎉…」这种重复串，直接喂给模型会让它跟着退化成乱码。
 */
export function tidy(s, max = 140) {
  let t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  // 单字符重复（🎉🎉🎉、哈哈哈哈、！！！！）先折成一次，再折多字短语的重复（「恭喜恭喜恭喜」）
  for (let i = 0; i < 3; i += 1) {
    const before = t
    t = t.replace(/(.)\1{2,}/gu, '$1')
    t = t.replace(/(.{2,8}?)\1{2,}/gu, '$1')
    if (t === before) break
  }
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > max) t = t.slice(0, max) + '…'
  return t
}

/** 楼层去重：同一句话刷很多遍只留一条，纯 emoji / 过短的丢掉。 */
export function tidyFloors(floors, { max = 8, len = 90 } = {}) {
  const out = []
  const seen = new Set()
  for (const f of floors || []) {
    const text = tidy(f.content, len)
    const key = text.replace(/\s/g, '').replace(/[…。！!？?~～]+$/g, '').slice(0, 8)
    if (!key || key.length < 3) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ nickname: tidy(f.nickname, 20) || '匿名', content: text })
    if (out.length >= max) break
  }
  return out
}

/** 把一整个帖子压成要点。maxFloors 来自配置里的 summary.maxComments（默认 60 层）。 */
export function summarizePrompt(topic, replies, { maxFloors = 60 } = {}) {
  const floors = replies.slice(0, Math.max(1, Number(maxFloors) || 60)).map((r, i) =>
    '#' + (r.position || i + 1) + ' ' + (r.user?.nickname || '匿名') + '：' + String(r.content || '').replace(/\s+/g, ' ').slice(0, 300)
  ).join('\n')
  return [
    { role: 'system', content: '你是一个论坛内容的总结助手。只输出要点，不评论、不寒暄、不加免责声明。' },
    {
      role: 'user',
      content: [
        '标题：' + (topic.title || ''),
        '正文：' + String(topic.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500),
        '',
        '楼层：',
        floors || '（无回复）',
        '',
        '请用中文输出：',
        '1) 三到五条核心要点（每条一行，以 - 开头）',
        '2) 一句话结论',
        '3) 争议点或未解决的问题（没有就写"无"）',
      ].join('\n'),
    },
  ]
}

/** 帖子的 PC 地址。日报里的「原帖链接」都用这个。 */
export const threadUrl = (id) => 'https://bbs.3839.com/thread-' + encodeURIComponent(String(id)) + '.htm'

/* ───────────── 提示词：发出去之前先过一遍的规则 ───────────── */

/** 设置页「人设补充」落在 ~/.hykb-ai/persona.md。读不到就当没写。 */
export function personaNotes() {
  try { return fs.readFileSync(personaPath(), 'utf8').trim().slice(0, 20000) } catch { return '' }
}

/**
 * 用户自己写的规则：人设补充 + 提示词规则。
 * 拼在系统提示最后，并明确告诉模型冲突时以这里为准——
 * 否则「不说自己是 AI」这类内置硬规则会把用户要的「注明 AI 生成」压掉。
 */
export function extraRules(cfg = config()) {
  const persona = personaNotes()
  const rules = String(cfg?.prompt?.rules || '').trim()
  const parts = []
  if (persona) parts.push('人设补充：\n' + persona)
  if (rules) parts.push('写之前先按这些要求想一遍，写出来的话必须满足它们：\n' + rules)
  if (!parts.length) return ''
  return '\n\n【用户规则——和上面任何一条冲突时，以这里为准】\n' + parts.join('\n\n')
}

/** 把用户规则接到第一条 system 消息后面。只用于「要发出去的话」，不用于内部速读。 */
export function withRules(messages, cfg) {
  const extra = extraRules(cfg)
  if (!extra) return messages
  return messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: m.content + extra } : m))
}

/**
 * 在要发出去的文字末尾追加固定后缀（比如「内容由AI生成」）。
 * 不靠模型自觉：模型可能漏写、改写、写在开头，所以由代码兜底。
 * 模型已经自己写了同一句就先去掉，避免重复；总长超过 max 时截正文、保后缀。
 */
export function applySuffix(text, { suffix = config()?.prompt?.suffix, max = Infinity, sep = ' ' } = {}) {
  const body0 = String(text || '').trim()
  const tail = String(suffix || '').trim()
  if (!tail || !body0) return body0
  const esc = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 去掉模型自己加的同一句（允许包着括号、前面有标点）
  const re = new RegExp('[\\s（(【\\[—-]*' + esc + '[\\s）)】\\]。.！!]*$')
  let body = body0.replace(re, '').trim()
  if (!body) return body0.slice(0, max)
  const room = max - tail.length - sep.length
  if (Number.isFinite(max) && room <= 0) return tail.slice(0, max)
  if (body.length > room) body = body.slice(0, room)
  return body + sep + tail
}

/**
 * 「帮我总结这帖」的回复版：要能直接当楼中楼发出去。
 * 和 summarizePrompt 的区别：那个是给自己看的报告（要点 + 结论 + 争议点），
 * 这个是发在论坛里的一段人话，不能带「结论：」「争议点：无」这类格式。
 */
export function replySummaryPrompt(topic, replies, persona) {
  const floors = tidyFloors(
    (replies || []).map((r) => ({ nickname: r.user?.nickname, content: r.content })),
    { max: 14, len: 110 },
  )
  const title = tidy(topic?.title, 120)
  const body = tidy(topic?.content, 400)
  return withRules([
    {
      role: 'system',
      content: [
        '你要在一个游戏论坛的楼中楼里，替人把这帖讲清楚。',
        '像真人说话，不要报告腔：不要出现「结论」「争议点」「核心要点」这类小标题。',
        '不加客套开场，不说自己是AI，不提「根据楼层」这种措辞。',
        '3 到 5 句，总长不超过 200 字。',
        persona?.style ? '说话风格：' + persona.style : '',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: [
        '帖子标题：' + (title || '（无）'),
        '帖子正文：' + (body || '（无）'),
        '',
        '楼层：',
        floors.length ? floors.map((f) => f.nickname + '：' + f.content).join('\n') : '（还没人回复）',
        '',
        '用中文说清楚：这帖在讲什么、大家在聊什么、有没有结论。直接给能发出去的那段话。',
      ].join('\n'),
    },
  ])
}

/** 生成一条回复。触发者是被回复的人。 */
export function replyPrompt({ topic, floors, trigger, persona, triggerText }) {
  return withRules([
    {
      role: 'system',
      content: [
        '你在一个游戏社区论坛里以「' + persona.name + '」的身份回帖。',
        '称呼对方为「' + persona.ownerTitle + '」。',
        '风格：' + persona.style,
        '硬规则：不超过 100 字；不承诺任何事情；不问隐私；不吵架；不用「作为一个AI」这类措辞；不输出解释，只输出要发的那段话。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '帖子标题：' + (topic.title || ''),
        '帖子正文（截断）：' + String(topic.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1200),
        '',
        '最近的楼层：',
        floors.slice(-10).map((r) => (r.user?.nickname || '匿名') + '：' + String(r.content || '').replace(/\s+/g, ' ').slice(0, 200)).join('\n') || '（无）',
        '',
        '现在 ' + (trigger.nickname || '对方') + ' 对你说：' + triggerText,
        '',
        '写一条回复。只输出正文。',
      ].join('\n'),
    },
  ])
}

/** 多帖综述：把一轮刷到的帖子压成一份日报。picks 里每项含 title/content/replyCount/score/摘录楼层。 */
export function digestPrompt({ picks, persona, date, style }) {
  const blocks = picks.map((p, i) => {
    const head = '【' + (i + 1) + '】' + (p.title || '(无标题)') + '　（' + (p.sectionTitle || p.sectionId) + '　' + p.score + ' 分　回复 ' + p.replyCount + '　赞 ' + p.upVote + '）'
      + (p.topicId ? '\n链接：' + threadUrl(p.topicId) : '')
    if (p.gist) return [head, '速读：' + tidy(p.gist, 300)].join('\n')
    const fl = tidyFloors(p.floors, { max: 6, len: 70 })
    return [
      head,
      '正文：' + tidy(p.content, 400),
      fl.length ? '楼层摘录：\n' + fl.map((f) => '  ' + f.nickname + '：' + f.content).join('\n') : '楼层摘录：（无）',
    ].join('\n')
  }).join('\n\n')
  return withRules([
    {
      role: 'system',
      content: [
        '你在给「' + persona.name + '」写一份游戏社区论坛的日报，读者是「' + persona.ownerTitle + '」。',
        '风格：' + (style || '要点式，口语，不客套，不加免责声明'),
        '硬规则：只写看到的内容；不编造楼层、数字、结论、链接；不输出"作为一个AI"；不寒暄。',
        '提到某一帖时，在那一段末尾照抄它的链接（只用材料里给的链接）。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '日期：' + date,
        '下面是今天扫到并打分排序后的帖子（分数越高越值得看）：',
        '',
        blocks,
        '',
        '请用中文输出，严格按这个结构：',
        '## 今天论坛在聊什么',
        '（三到五条，每条一行，以 - 开头，概括这批帖子共同在讨论什么）',
        '',
        '## 值得看的',
        '（挑 3 帖以内，每帖一段：标题 + 一句为什么值得看 + 一句你自己的判断）',
        '',
        '## 一句话',
        '（整份日报收尾一句，别煽情）',
      ].join('\n'),
    },
  ])
}

/** 单帖速读：给一帖写「这帖在说什么」，用于日报里补细节。 */
export function topicGistPrompt(topic, floors) {
  return [
    { role: 'system', content: '你是一个论坛速读助手。只输出要点，不评论、不寒暄。' },
    {
      role: 'user',
      content: [
        '标题：' + (topic.title || ''),
        '正文：' + tidy(topic.content, 800),
        '楼层：',
        tidyFloors(floors, { max: 10, len: 90 }).map((f) => f.nickname + '：' + f.content).join('\n') || '（无）',
        '',
        '用两句中文说清：1) 楼主在问什么/说什么 2) 楼下给出的关键信息或分歧。只输出这两句。',
      ].join('\n'),
    },
  ]
}

/** 主动回帖：不是回某个人，是对一个帖子本身留一句话。 */
export function browseReplyPrompt({ topic, floors, persona, gist }) {
  return withRules([
    {
      role: 'system',
      content: [
        '你在游戏社区论坛里以「' + persona.name + '」的身份回帖。',
        '称呼别人为「' + persona.ownerTitle + '」。',
        '风格：' + persona.style,
        '硬规则：不超过 80 字；不承诺任何事；不问隐私；不引战；不复制楼主原话；不出现"作为一个AI"；不输出解释，只输出要发的那一段话。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '帖子标题：' + (topic.title || ''),
        '正文（截断）：' + tidy(topic.content, 800),
        gist ? '这帖在说什么：' + tidy(gist, 200) : '',
        '',
        '最近的楼层：',
        tidyFloors(floors, { max: 6, len: 70 }).map((f) => f.nickname + '：' + f.content).join('\n') || '（无）',
        '',
        '写一条自然的回帖。只输出正文。',
      ].filter(Boolean).join('\n'),
    },
  ])
}
