// 白黑名单：三类监听源共用同一套语义，避免每个地方各写一份。
//
// 规则（每条都按这个顺序判）：
//   1. 命中黑名单 → 拒
//   2. 白名单非空且未命中 → 拒
//   3. 否则 → 放
// 空名单 = 不限。用户填 uid、昵称、板块 id、板块名、帖子 id、帖子链接都认。
import { parseSectionId, parseTopicId } from './forum.mjs'

const norm = (v) => String(v ?? '').trim().toLowerCase()

/** 把用户填的一行行文本切成数组；逗号、空格、换行、中文逗号都算分隔。 */
export function splitList(input) {
  if (Array.isArray(input)) return input.map((x) => String(x).trim()).filter(Boolean)
  return String(input || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function hit(list, keys) {
  if (!list.length) return false
  const set = new Set(list.map(norm).filter(Boolean))
  return keys.some((k) => {
    const v = norm(k)
    return v && set.has(v)
  })
}

/**
 * @param {{allowUsers:string[], denyUsers:string[], allowForums:string[], denyForums:string[], allowTopics:string[], denyTopics:string[]}} f
 */
export function makeFilter(f = {}) {
  const allowUsers = splitList(f.allowUsers)
  const denyUsers = splitList(f.denyUsers)
  const allowForums = splitList(f.allowForums)
  const denyForums = splitList(f.denyForums)
  const allowTopics = splitList(f.allowTopics)
  const denyTopics = splitList(f.denyTopics)

  return {
    /** 这个人能不能回。uid 与昵称都参与匹配。 */
    user(uid, nickname) {
      const keys = [uid, nickname].filter(Boolean)
      if (hit(denyUsers, keys)) return { ok: false, why: 'user-deny' }
      if (allowUsers.length && !hit(allowUsers, keys)) return { ok: false, why: 'user-not-allowed' }
      return { ok: true }
    },
    /** 这个板块要不要看。id 与板块名都参与匹配。 */
    forum(sectionId, title) {
      const keys = [sectionId, parseSectionId(sectionId), title].filter(Boolean)
      if (hit(denyForums, keys)) return { ok: false, why: 'forum-deny' }
      if (allowForums.length && !hit(allowForums, keys)) return { ok: false, why: 'forum-not-allowed' }
      return { ok: true }
    },
    /** 这个帖子要不要看。id 与链接都参与匹配。 */
    topic(topicId) {
      const keys = [topicId, parseTopicId(topicId)].filter(Boolean)
      if (hit(denyTopics, keys)) return { ok: false, why: 'topic-deny' }
      if (allowTopics.length && !hit(allowTopics, keys)) return { ok: false, why: 'topic-not-allowed' }
      return { ok: true }
    },
  }
}
