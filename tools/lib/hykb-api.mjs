// 快爆接口层：所有路径集中在这里，改域名只改这个文件。
import { guardedFetch, withTimeout } from './traffic.mjs'
import { loadCred, cookieHeader } from './cred.mjs'

export const PC = 'https://bbs.3839.com'
export const MOBILE = 'https://m.bbs.3839.com'
export const WEB = 'https://www.3839.com'

// 消息中心接口需要带 referer / origin。
const WEB_HDR = { referer: WEB + '/zone/msg', origin: WEB }

const json = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, msg: 'non-json', raw: text.slice(0, 300) } }
}

/* ---------------- 只读 ---------------- */

/** 帖子正文 + 楼层（免登录）。topic_id 是 URL 里 thread-<id>.htm 的那个 id。 */
export async function topicDetail(topicId, { sort = 2, page = 1 } = {}) {
  const url = MOBILE + '/wap.php?m=topic&ac=detail&v=1.1&topic_id=' + encodeURIComponent(topicId)
    + '&only_owner=0&sort=' + sort + '&app_version=413&page=' + page
  const res = await guardedFetch(url, {}, 'read')
  return json(res)
}

/** 楼中楼详情（在某条回复下面展开）。 */
export async function replyDetail({ topicId, pid }) {
  const body = new URLSearchParams({ topic_id: String(topicId), pid: String(pid) })
  const res = await guardedFetch(PC + '/index.php?m=api&c=thread&a=getCommentList', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', cookie: cookieHeader() },
    body: body.toString(),
  }, 'read')
  return json(res)
}

/** PC 楼层列表（需要登录才不返回 403）。 */
export async function replyList({ tid, cursor = 0, lastId = 0, sort = 1 }) {
  const body = new URLSearchParams({ tid: String(tid), cursor: String(cursor), lastId: String(lastId), sort: String(sort) })
  const res = await guardedFetch(PC + '/index.php?m=api&c=thread&a=getReplyList', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', cookie: cookieHeader() },
    body: body.toString(),
  }, 'read')
  return json(res)
}

/** 未读消息数（免登录可用，是监听循环最便宜的探针）。 */
export async function msgInfo() {
  const res = await guardedFetch(PC + '/index.php?m=api&c=thread&a=getMsgInfo', {
    headers: { 'x-requested-with': 'XMLHttpRequest', cookie: cookieHeader() },
  }, 'read')
  return json(res)
}

/**
 * 「@ 我」通知列表（消息中心的 mode=3 频道）。
 *
 * mode：1 回复我的 / 2 系统通知（此时 ac 要换成 sys_message）/ 3 @我 / 4 赞 / 5 关注。
 * 响应：{code:100, result:{last_id, cursor, data:[…]}}，last_id 与 cursor 都是 -1 表示到底。
 *
 * data 里每条：type=202「在回帖中@了你」（带 tid+rid）/ 200「在帖子中@了你」（只有 tid），
 * del_status=1 表示原内容已删（to_info 会变成「该内容已删除」），这种既没正文也没法回。
 */
export async function atList({ mode = 3, lastId = '', cursor = '' } = {}) {
  const body = new URLSearchParams({
    ac: mode === 2 ? 'sys_message' : 'message',
    mode: String(mode), last_id: String(lastId), cursor: String(cursor),
  })
  const res = await guardedFetch(WEB + '/app/hykb_web/api/api_user.php', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      cookie: cookieHeader(),
      ...WEB_HDR,
    },
    body: body.toString(),
  }, 'read')
  return json(res)
}

/** PC 帖子页 HTML（拿 fid、tid 等页面内嵌变量）。 */
export async function topicPage(topicId) {
  const res = await guardedFetch(PC + '/thread-' + topicId + '.htm', { headers: { cookie: cookieHeader() } }, 'read')
  return res.text()
}

/* ---------------- 写入 ---------------- */

/**
 * 发主回复（回复楼主）。
 * 参数来自 lib_thread.js 的 submit 段：content / tid / replyId / type / state / mask
 */
export async function replyOperate({ tid, content, replyId = 0, type = 3, state = 1, mask = 0 }) {
  const cred = loadCred()
  const body = new URLSearchParams({
    tid: String(tid), content, replyId: String(replyId), type: String(type), state: String(state), mask: String(mask),
  })
  const res = await guardedFetch(PC + '/index.php?m=api&c=thread&a=replyOperate', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      cookie: cookieHeader(cred),
    },
    body: body.toString(),
  }, 'write')
  return json(res)
}

/**
 * 发楼中楼回复（回复某条评论）。
 * 参数来自 d_thread.js 的 sureExtra：replyId / commentId / content / type=2 / extra_comment=1 / mask=0 / fid
 */
export async function commentOperate({ fid, replyId, commentId, content, mask = 0 }) {
  const cred = loadCred()
  const body = new URLSearchParams({
    fid: String(fid), replyId: String(replyId), commentId: String(commentId),
    content, type: '2', extra_comment: '1', mask: String(mask),
  })
  const res = await guardedFetch(PC + '/index.php?m=api&c=thread&a=commentOperate', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      cookie: cookieHeader(cred),
    },
    body: body.toString(),
  }, 'write')
  return json(res)
}

/**
 * 发一篇新帖（文章帖）。
 * 参数：
 *   POST index.php?m=api&c=thread&a=setThread（form 编码）
 *   cate=1 发布 / 2 定时 / 3 草稿；type=1 文章帖（需要 cover 字段，空串即可）。
 * content 是编辑器 domToStr 的产物：段落是 <div>…</div>，空行 <div><br></div>，
 * 只认 h1/h2/b/i/blockquote 这类标签——平台没有 <a>，链接只能当纯文本。
 * 返回码：100 成功 / 8111 敏感词 / 99 活动关键词 / 8156 活动设置敏感词 / 5003 账号在别的设备登录。
 * 成功时不回帖子 id（前端是跳回板块页），所以调用方只能拿到 code + msg。
 */
export async function setThread({ fid, title, content, cate = 1 }) {
  const cred = loadCred()
  const body = new URLSearchParams({
    type: '1', fid: String(fid), tid: '0', sid: '0', did: '0',
    title: String(title || ''), content: String(content || ''),
    is_comment: '1', only_myself_status: '0', is_top: '0', top_tag: '0', top_topic_end_time: '',
    is_timing: '0', is_pgc_push: '0', is_talking_point: '0', pubtime: '',
    p_sub_id: '0', c_sub_id: '0', mask: '0', save_confirm: '0',
    is_huodong: '0', is_huodong_topic: '0', is_ignore_huodong_check: '0',
    kb_fast_news_status: '0', kb_fast_news_abstract: '', is_repost: '0', repost_desc: '',
    cover: '', cate: String(cate),
  })
  const res = await guardedFetch(PC + '/index.php?m=api&c=thread&a=setThread', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: PC + '/index.php?m=api&c=thread&a=sendThreadShow&fid=' + encodeURIComponent(String(fid)),
      origin: PC,
      cookie: cookieHeader(cred),
    },
    body: body.toString(),
  }, 'write')
  return json(res)
}

/* ---------------- 登录 ---------------- */

export const LOGIN = 'https://www.3839.com/user/index.php'
export const LOGIN_HDR = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  referer: 'https://www.3839.com/',
  origin: 'https://www.3839.com',
  'x-requested-with': 'XMLHttpRequest',
}

/** 取登录二维码内容（AUTH:xxx） */
export async function qrCreate() {
  const res = await fetch(LOGIN + '?ac=QRcodeCreate&appId=web', withTimeout({
    method: 'POST',
    headers: { ...LOGIN_HDR, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: 'r=' + Math.random(),
  }))
  return qrAbsorb(res)
}

/** 轮询扫码状态。返回 { json, cookies } */
export async function qrPoll(qrcode, jar) {
  const res = await fetch(LOGIN + '?ac=QRcodePolling&appId=web', withTimeout({
    method: 'POST',
    headers: { ...LOGIN_HDR, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', ...(jar.size ? { cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ') } : {}) },
    body: new URLSearchParams({ qrcode, r: String(Math.random()) }).toString(),
  }))
  return qrAbsorb(res, jar)
}

/**
 * 扫码第二步：拿票。
 * 轮询只会回 result.uid（表示"这个人在手机端确认了"），但 Pauth / Uauth 要再调一次
 * QRcodeAuthCallBack 才下发。
 * 少了这一步，轮询看起来"成功"，落盘的却是 uid 有、Pauth 空，写操作一律 5001。
 */
export async function qrAuthCallback(result, jar) {
  const cookie = jar && jar.size ? [...jar].map(([k, v]) => k + '=' + v).join('; ') : ''
  // jQuery 的 $.param 对嵌套对象展开成 result[uid]=..&result[..]=..，不是 JSON 串
  const p = new URLSearchParams()
  p.set('show_idcard', '1')
  for (const [k, v] of Object.entries(result || {})) {
    if (v == null || typeof v === 'object') continue
    p.set('result[' + k + ']', String(v))
  }
  p.set('r', String(Math.random()))
  const body = p
  const res = await fetch(LOGIN + '?ac=QRcodeAuthCallBack', withTimeout({
    method: 'POST',
    headers: { ...LOGIN_HDR, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', ...(cookie ? { cookie } : {}) },
    body: body.toString(),
  }))
  return qrAbsorb(res, jar)
}

async function qrAbsorb(res, jar) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const got = {}
  for (const line of raw) {
    const [pair] = line.split(';')
    const i = pair.indexOf('=')
    if (i > 0) { got[pair.slice(0, i).trim()] = pair.slice(i + 1).trim() }
  }
  if (jar) for (const [k, v] of Object.entries(got)) jar.set(k, v)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { code: -1, raw: text.slice(0, 200) } }
  return { data, cookies: got }
}
