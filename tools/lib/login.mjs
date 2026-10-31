// 扫码登录：网页扫码登录的状态机，不需要浏览器。
import { qrCreate, qrPoll, qrAuthCallback } from './hykb-api.mjs'
import { saveCred, deriveCred } from './cred.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {{onQr?: (content:string)=>any, onPhase?: (p:string)=>any, timeoutSec?: number}} opt
 * @returns {Promise<{uid:string,nickname:string,Pauth:string,Uauth:string,accesstoken:string}>}
 */
export async function login({ onQr, onPhase, timeoutSec = 300 } = {}) {
  const jar = new Map()
  const first = await qrCreate()
  if (first.data.code !== 100 || !first.data.result?.qrcode) {
    throw new Error('取二维码失败：' + JSON.stringify(first.data).slice(0, 200))
  }
  const qrcode = first.data.result.qrcode
  for (const [k, v] of Object.entries(first.cookies)) jar.set(k, v)
  try { onQr?.(qrcode) } catch (e) { /* 展示层出错不该中断登录 */ }

  const t0 = Date.now()
  let last = ''
  let authTries = 0
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(1200)
    const { data, cookies } = await qrPoll(qrcode, jar)
    for (const [k, v] of Object.entries(cookies)) jar.set(k, v)

    const r = data.result || {}
    let phase
    if (jar.has('Pauth')) phase = 'LOGIN'
    else if (data.code === 102) phase = 'EXPIRED'
    else if (typeof r.status === 'number') phase = ['WAIT', 'SCANNED', 'CONFIRMED', 'CANCELLED'][r.status] || ('STATUS_' + r.status)
    else if (r.uid) phase = 'AUTH'
    else phase = 'UNKNOWN'
    if (phase !== last) { onPhase?.(phase === 'AUTH' ? 'CONFIRMED' : phase); last = phase }

    // 轮询回 uid 只代表"手机端确认了"，Pauth 要再调一次 AuthCallBack 才下发。
    // 少这一步会落出一个 uid 有、Pauth 空的凭据，写操作全是 5001。
    if (phase === 'AUTH') {
      authTries += 1
      const back = await qrAuthCallback(r, jar)
      for (const [k, v] of Object.entries(back.cookies)) jar.set(k, v)
      const status = back.data?.status
      if (status === -2) throw new Error('账号需要先实名认证（服务端返回 status -2），去网页端登录一次补完再回来扫码')
      if (jar.has('Pauth')) phase = 'LOGIN'
      else if (authTries >= 3) {
        throw new Error('扫码已确认，但服务端三次都没下发 Pauth（回包：' + JSON.stringify(back.data).slice(0, 200) + '）')
      } else {
        continue
      }
    }

    if (phase === 'LOGIN') {
      const cred = {
        uid: String(r.uid || ''),
        Pauth: jar.get('Pauth') || '',
        Uauth: jar.get('Uauth') || '',
        nickname: jar.get('nickname') || '',
        accesstoken: jar.get('accesstoken') || '',
      }
      if (!cred.Pauth) {
        // 服务端偶尔先给 uid 后给 Pauth，再等一轮
        await sleep(1500)
        const again = await qrPoll(qrcode, jar)
        for (const [k, v] of Object.entries(again.cookies)) jar.set(k, v)
        cred.Pauth = jar.get('Pauth') || ''
        cred.Uauth = jar.get('Uauth') || cred.Uauth
        cred.accesstoken = jar.get('accesstoken') || cred.accesstoken
        cred.nickname = jar.get('nickname') || cred.nickname
        cred.uid = cred.uid || String(r.uid || '')
      }
      saveCred(deriveCred(cred))
      return cred
    }
    if (phase === 'EXPIRED' || phase === 'CANCELLED') {
      throw new Error(phase === 'EXPIRED' ? '二维码已过期（code 102），重新扫一次' : '扫码被取消')
    }
  }
  throw new Error('等待扫码超时（' + timeoutSec + ' 秒）')
}
