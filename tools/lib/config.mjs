// 配置层：一个文件承载所有"属于使用者"的东西，代码里不留个人化硬编码。
import fs from 'node:fs'
import path from 'node:path'
import { configPath, aiKeyPath, credDir, ensureDir, harden } from './paths.mjs'

export { configPath } from './paths.mjs'

// 白黑名单：三类监听源各有一份，互不干扰。
// 空数组 = 不限；判定顺序永远是「先黑后白」。
export const FILTER_KEYS = ['allowUsers', 'denyUsers', 'allowForums', 'denyForums', 'allowTopics', 'denyTopics']
const FILTER = () => Object.fromEntries(FILTER_KEYS.map((k) => [k, []]))

/** 唯一一份默认配置。宿主侧设置页（lib/index.js）也读这一份，别在别处再抄一份。 */
export const DEFAULTS = {
  owner: { uid: '', name: '' },        // 大号：发帖 @ 小号的那个
  self: { uid: '', name: '' },         // 小号：负责回复的那个
  ai: { baseUrl: '', model: '', apiKey: '', temperature: 0.7, maxTokens: 800 },
  persona: { name: '小号', ownerTitle: '主人', style: '简短、自然、不客套，一两句话说完' },
  // 提示词：模型每次写要发出去的话之前都要先看的规则 + 发出前在末尾固定追加的一句。
  //   rules  —— 自由文本，拼进系统提示，和下面的硬规则冲突时以它为准
  //   suffix —— 由代码追加（不靠模型自觉），回帖、楼中楼、日报帖都会带上；空 = 不加
  prompt: { rules: '', suffix: '' },
  listen: {
    enabled: false,
    intervalSec: 60,
    allDay: true,
    windows: [{ start: '08:00', end: '24:00' }],
    oncePerPerson: true,
    // @ 触发口径：'both' 全都认 / 'rich' 只认真 @（要互相关注）/ 'plain' 只认正文「@昵称」
    // 平台只有互相关注才发得出真 @，所以默认两条都认，谁 @ 都接得住。
    triggerMode: 'both',
    maxTopicsPerTick: 6,
    maxRepliesPerTick: 3,   // 一轮最多回几条：防止一次扫描把整帖的 @ 全回一遍

    // ① 监听论坛：填板块 id，扫这个板块里的新帖
    forum: {
      enabled: false,
      items: [],              // [{ id:'23064', title:'爆友生活区' }]
      ...FILTER(),
    },

    // ② 监听帖子：填帖子链接或 id，扫这帖的楼层和楼中楼
    topic: {
      enabled: false,
      items: [],              // [{ id:'1000001', title:'…' }]
      floors: true,           // 扫主楼层
      comments: true,         // 扫楼中楼
      ...FILTER(),
    },

    // ③ @ 我通知：消息中心的「@我的」列表。这是唯一不需要填任何 id 就能工作的源，
    //    所以默认开着 —— 别的都不配，只靠别人 @ 也能回。
    atme: {
      enabled: true,
      ...FILTER(),
    },

    // ④ 有人 @ 我：在上面三个源扫到的内容里找 @，也支持单独指定范围
    at: {
      enabled: true,
      items: [],              // 单独指定的帖子；空 = 复用上面两个源的扫描范围
      forums: [],             // 单独指定的板块；空 = 复用
      ...FILTER(),
    },
  },
  // ④ 刷帖：主动扫板块 → 打分排序 → 多帖综述日报 →（可选）对高分帖回帖
  browse: {
    enabled: false,
    intervalSec: 3600,
    allDay: true,
    windows: [{ start: '08:00', end: '24:00' }],
    // 空 = 用下面的默认「公共讨论区」（爆友生活区/综合讨论/找游戏/创作/最强爆友/组队交友）
    sections: [],
    defaultSections: ['23064', '3', '134', '31959', '41278', '58124'],
    muteTitles: ['开奖', '已结束', '中奖', '名单公布', '获奖公告'],   // 标题命中这些词的帖子不进日报
    skipTop: true,           // 置顶帖一般是版务公告，默认跳过
    pages: 1,                // 每个板块翻几页
    maxSections: 6,
    pick: 8,                 // 日报里最多写几帖
    deep: 3,                 // 前几帖深读：拿楼层压成速读再喂给日报
    minScore: 0,             // 低于这个分不进日报
    autoReply: false,        // 对高分帖自动回帖（写操作，仍受 risk 预算与写冷却约束）
    replyMinScore: 40,
    replyMax: 3,             // 每轮最多回几条
    wake: true,              // 刷完叫醒专属会话（宿主用 sessionController 塞任务书）
    sessionId: 'hykb-whale',
    score: { reply: 3, comment: 1, vote: 2, view: 0.01, fresh: 6, essence: 8, top: 2, ageHalfLifeHours: 24 },
    ...FILTER(),
  },
  risk: {
    minGapMs: 1500,
    readHourly: 600, readDaily: 3000,
    writeHourly: 12, writeDaily: 30,
    writeGapSec: 120,
    backoffOnBlock: [300, 600, 1200, 1800],
  },
  summary: { enabled: true, maxComments: 50, style: '要点式，带楼层引用' },
  // 发帖：把每轮刷出来的日报当成一篇新帖发到指定板块（文章帖）。写操作，默认关。
  post: {
    enabled: false,
    section: { id: '', title: '' },   // 发到哪个板块
    title: '快爆论坛日报 {date}',      // {date} 换成当天日期；平台限 48 字
    maxPerDay: 1,                      // 一天最多发几篇（日报每小时跑一轮，不卡就会刷屏）
    minPicks: 3,                       // 选到的帖子少于这个数不发
    links: true,                       // 文末附「原帖链接」清单
  },
  toolsPath: '',
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
/** 原型污染防线：JSON 里写 "__proto__" / "constructor" / "prototype" 的键一律跳过。 */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])
export const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    if (UNSAFE.has(k)) continue
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  }
  return out
}

export function readRaw() {
  const file = configPath()
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ''))
    return isObj(v) ? v : {}
  } catch { return {} }
}

/** 密钥单独存：配置文件里留空，真值放 ~/.hykb-ai/ai-key（收紧过权限）。 */
export function loadAiKey() {
  try { return fs.readFileSync(aiKeyPath(), 'utf8').trim() } catch { return '' }
}

export function saveAiKey(key) {
  ensureDir(credDir())
  const f = aiKeyPath()
  if (!key) { try { fs.rmSync(f, { force: true }) } catch {} ; return '' }
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, key.trim() + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
  return key.trim()
}

/**
 * 老装法把 apiKey 明文写在配置里；新装法单独放 ai-key 文件（权限收紧）。
 * 这里做一次性搬迁：读到明文就搬走并把它从配置里擦掉，之后无论谁调 config() 都不会再读到明文。
 */
function migrateKey(raw) {
  const k = raw?.ai?.apiKey
  if (typeof k !== 'string' || !k.trim()) return raw
  saveAiKey(k)
  writeConfig({ ai: { apiKey: '' } })
  return merge(raw, { ai: { apiKey: '' } })
}

export function config() {
  const raw = migrateKey(readRaw())
  const c = merge(DEFAULTS, raw)
  if (!c.ai) c.ai = { ...DEFAULTS.ai }
  // 配置里没有就走独立密钥文件；两边都认，配置里优先（迁移后会恒为空）。
  if (!c.ai.apiKey) c.ai.apiKey = loadAiKey()
  return c
}

/** 写配置：apiKey 一律搬去 ai-key 文件，落在磁盘上的配置永远不含明文密钥。 */
export function writeConfig(patch) {
  const file = configPath()
  const next = merge(readRaw(), patch)
  if (next.ai && typeof next.ai.apiKey === 'string' && next.ai.apiKey.trim()) {
    saveAiKey(next.ai.apiKey)
    next.ai.apiKey = ''
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
  return next
}
