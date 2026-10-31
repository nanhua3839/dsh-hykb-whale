// 路径层：所有落盘位置集中在这里，别在业务代码里拼字符串。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

export const dshHome = () => DSH_HOME
export const dshPath = (...p) => path.join(DSH_HOME, ...p)
export const configPath = () => process.env.HYKB_WHALE_CONFIG || path.join(DSH_HOME, 'hykb-whale.config.json')
export const credDir = () => path.join(HOME, '.hykb-ai')
export const credentialsPath = () => path.join(credDir(), 'credentials.json')
export const ledgerPath = () => path.join(credDir(), 'traffic-ledger.json')
export const auditPath = () => path.join(credDir(), 'audit.jsonl')
export const seenPath = () => path.join(credDir(), 'seen.json')
export const postLogPath = () => path.join(credDir(), 'posts.json')
export const personaPath = () => path.join(credDir(), 'persona.md')
/** AI 密钥单独存一个文件：配置文件常被设置页整份回写、也常被拷来拷去，密钥不该跟着走。 */
export const aiKeyPath = () => path.join(credDir(), 'ai-key')
export const workDir = () => path.join(DSH_HOME, 'hykb-work')
/** 日报落盘：~/.dsh/hykb-work/digest-YYYY-MM-DD.md（同一天多次刷帖是追加，不覆盖） */
export const digestDir = () => path.join(DSH_HOME, 'hykb-work')
/** 缺省日期用本地日，跟 digest.mjs 的 today() 保持同一个口径（UTC 日会让东八区 0-8 点写成前一天的日报）。 */
export const digestPath = (date) => path.join(digestDir(), 'digest-' + (date || localDay()) + '.md')

/** 本地日期 YYYY-MM-DD。 */
export function localDay(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 把文件权限收到"只有本人能读"。
 * Windows 上 chmod 的 mode 参数直接被忽略（落盘实测永远是 666），
 * 所以走 icacls：先砍掉继承，再只授当前用户读写。失败不阻断业务（有些 FS 上 icacls 不可用）。
 * @returns {boolean} 是否真的收紧了
 */
export function harden(file) {
  if (!file) return false
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); return true } catch { return false }
  }
  // 取当前用户：process.env.USERNAME 在部分执行环境（服务、容器）里是空的，
  // 空用户名会让 icacls 收到 ":R,W" 直接报「无效参数」，所以用 os.userInfo() 兜底。
  let user = ''
  try { user = os.userInfo().username || '' } catch {}
  if (!user) user = process.env.USERNAME || process.env.USER || ''
  if (!user) return false
  try {
    // 权限串必须写成 user:(R,W)：写成 user:R,W 会被 icacls 当成无效参数（exit 87）静默失败。
    execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', user + ':(R,W)'], {
      stdio: 'ignore', timeout: 5000, windowsHide: true,
    })
    return true
  } catch { return false }
}
