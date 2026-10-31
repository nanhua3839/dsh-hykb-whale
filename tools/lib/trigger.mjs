/**
 * @ 触发识别。两层判据，CLI 与宿主插件共用同一份，避免两边漂移。
 *
 * a) 富文本：正文里的 <kb-contact data-id="<uid>"> 标签。
 *    服务端会解析这个标签并校验好友关系，非好友整条发送被拒。
 *    所以这条路径只在双方已互为好友时可用。
 * b) 纯文本：正文里出现「@昵称」。不走好友校验，任何号都能发得出去。
 */

/** kb-contact 的 data-id 属性有三种引号写法，都要覆盖。 */
function hasRichTag(content, uid) {
  const id = String(uid)
  return content.includes('data-id="' + id + '"')
    || content.includes("data-id='" + id + "'")
    || content.includes('data-id=' + id + ' ')
    || content.includes('data-id=' + id + '>')
    || content.includes('data-id=' + id + '/')
}

/** @昵称 需要防止被更长昵称前缀命中：@tester2 不该算 @tester。 */
function hasPlainTag(content, nickname) {
  if (!nickname) return false
  const tag = '@' + nickname
  let at = content.indexOf(tag)
  while (at !== -1) {
    const next = content.charAt(at + tag.length)
    // 只有紧跟 ASCII 字母/数字/下划线才算同一个人名字的延续（@tester2 ≠ @tester）。
    // 中文一律视为分隔符：@tester在吗 是叫我；中文昵称「小明」也不会被「@小明明」误判，
    // 因为中文昵称本身没有可靠的词边界，宁可多回一条也不漏回。
    if (!/[0-9A-Za-z_]/.test(next)) return true
    at = content.indexOf(tag, at + 1)
  }
  return false
}

/** 三种触发口径。配置里存这一个值，CLI 与宿主都读它。 */
export const TRIGGER_MODES = ['both', 'rich', 'plain']

/** 把任意输入收敛成合法 mode，非法值一律回 'both'（最宽松，不会让人"以为开着却不回"）。 */
export function normalizeTriggerMode(v) {
  const s = String(v || '').toLowerCase()
  return TRIGGER_MODES.includes(s) ? s : 'both'
}

/**
 * 判断一条楼层是不是在叫我。
 *
 * mode 决定认哪几种 @：
 *   'rich'  —— 只认真 @（<kb-contact>）。平台会校验好友关系，只有互相关注才发得出去，
 *              所以这个口径最干净，但要求对方是好友。
 *   'plain' —— 只认正文里的「@昵称」。任何号都能发，不要求好友。
 *   'both'  —— 两种都认（默认）。真 @ 优先，扫不到再看文字。
 *
 * @param {string} content 楼层 HTML 正文
 * @param {{uid: string|number, nickname?: string}} me 我的身份
 * @param {'both'|'rich'|'plain'} [mode='both'] 触发口径
 * @returns {{hit: boolean, via: 'rich'|'plain'|null}}
 */
export function matchTrigger(content, me, mode) {
  const c = String(content || '')
  const m = normalizeTriggerMode(mode)
  if (m !== 'plain' && hasRichTag(c, me.uid)) return { hit: true, via: 'rich' }
  if (m !== 'rich' && hasPlainTag(c, me.nickname)) return { hit: true, via: 'plain' }
  return { hit: false, via: null }
}
