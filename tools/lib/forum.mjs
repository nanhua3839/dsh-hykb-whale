// 板块层：把「论坛」变成可以轮询的帖子流。
//
// 板块帖子列表走移动版接口；翻页靠 last_id + cursor 成对回传。
import { guardedFetch } from './traffic.mjs'

const MOBILE = 'https://m.bbs.3839.com'
const APP = 'https://bbs3839.5054399.com/app/wap.php'

const json = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, msg: 'non-json', raw: text.slice(0, 300) } }
}

/**
 * 板块里的帖子列表（按最后回复时间倒序）。
 * @returns {{code:number, result?:{data:Array, last_id:string, cursor:number}}}
 */
export async function sectionTopics(sectionId, { lastId = 0, cursor = 0 } = {}) {
  const qs = new URLSearchParams({
    m: 'topic', ac: 'section_topic', v: '1.0',
    section_id: String(sectionId),
    last_id: String(lastId), cursor: String(cursor),
    sort: 'reply_time', screen_id: '0', topic_list_type: 'all', app_version: '413',
  })
  const res = await guardedFetch(MOBILE + '/wap.php?' + qs, {}, 'read')
  return json(res)
}

/** 板块目录（含 id / 标题 / 讨论数），用来把用户填的 id 显示成人能看懂的名字。 */
export async function sectionCatalog() {
  const res = await guardedFetch(APP + '?m=section&ac=index&v=1.1&app_version=413', {}, 'read')
  const j = await json(res)
  if (j.code !== 100 || !j.result?.data) return { code: j.code, msg: j.msg, sections: [] }
  const seen = new Set()
  const sections = []
  for (const group of j.result.data) {
    for (const s of group.list || []) {
      if (seen.has(String(s.id))) continue
      seen.add(String(s.id))
      sections.push({ id: String(s.id), title: s.title, group: group.type_name, discuss: s.discuss_num, today: s.today_discuss_num })
    }
  }
  return { code: 100, sections }
}

/** 从用户粘贴的东西里认出板块 id：纯数字、板块页链接、带 section_id 的链接都吃。 */
export function parseSectionId(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  if (/^\d+$/.test(s)) return s
  const m = s.match(/section[_-](\d+)/i) || s.match(/section_id=(\d+)/i) || s.match(/fid=(\d+)/i)
  return m ? m[1] : ''
}

/** 同理认帖子 id：纯数字、post-<id>.htm、thread-<id>.htm、topic_id= 都吃。 */
export function parseTopicId(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  if (/^\d+$/.test(s)) return s
  const m = s.match(/(?:post|thread|topic)[-_](\d+)/i) || s.match(/topic_id=(\d+)/i) || s.match(/tid=(\d+)/i)
  return m ? m[1] : ''
}
