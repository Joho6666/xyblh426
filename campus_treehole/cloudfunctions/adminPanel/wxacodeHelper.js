/**
 * 生成小程序无限码（太阳码）
 * 优先 cloud.openapi；H5/服务端调用失败时回退微信 HTTP API（需配置 WX_APPID、WX_APP_SECRET）
 */
const https = require('https')

let tokenCache = { token: '', expireAt: 0 }

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function parseJsonBuffer(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (e) {
    return null
  }
}

async function getClientCredentialToken(appId, appSecret) {
  if (!appId || !appSecret) {
    throw new Error(
      'H5 后台生成太阳码需在云函数环境变量配置 WX_APPID 与 WX_APP_SECRET（微信小程序后台 → 开发管理 → 开发设置）'
    )
  }
  if (tokenCache.token && Date.now() < tokenCache.expireAt) return tokenCache.token

  const path =
    `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`
  const { body } = await httpRequest({ hostname: 'api.weixin.qq.com', path, method: 'GET' })
  const json = parseJsonBuffer(body)
  if (!json || !json.access_token) {
    throw new Error((json && json.errmsg) || '获取微信 access_token 失败')
  }
  tokenCache = {
    token: json.access_token,
    expireAt: Date.now() + Math.max(60, (json.expires_in || 7200) - 300) * 1000
  }
  return tokenCache.token
}

function bufferFromOpenapiResult(wxacodeRes) {
  if (Buffer.isBuffer(wxacodeRes)) return wxacodeRes
  if (wxacodeRes && Buffer.isBuffer(wxacodeRes.buffer)) return wxacodeRes.buffer
  if (wxacodeRes && wxacodeRes.errCode) {
    const err = new Error(wxacodeRes.errMsg || '生成小程序码失败')
    err.errCode = wxacodeRes.errCode
    throw err
  }
  return null
}

function isInvalidWxTokenError(err) {
  const s = String((err && (err.errMsg || err.message)) || err || '')
  return /INVALID_WX_ACCESS_TOKEN|501001|access_token/i.test(s)
}

async function getUnlimitedViaHttp(appId, appSecret, { scene, page }) {
  const token = await getClientCredentialToken(appId, appSecret)
  const postBody = JSON.stringify({
    scene: String(scene),
    page: page || 'pages/index/index',
    check_path: false
  })
  const { body } = await httpRequest(
    {
      hostname: 'api.weixin.qq.com',
      path: `/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postBody)
      }
    },
    postBody
  )
  const json = parseJsonBuffer(body)
  if (json && json.errcode) {
    throw new Error(json.errmsg || `微信接口错误 ${json.errcode}`)
  }
  if (!body || !body.length) throw new Error('微信接口未返回图片数据')
  return body
}

/**
 * @param {object} cloud wx-server-sdk 实例
 * @param {{ scene: string, page?: string }} opts
 * @returns {Promise<Buffer>}
 */
async function getWxacodeUnlimitedBuffer(cloud, opts) {
  const scene = String(opts.scene || '').trim()
  const page = opts.page || 'pages/index/index'
  if (!scene) throw new Error('缺少 scene')

  let openapiErr = null
  try {
    const wxacodeRes = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page,
      checkPath: false
    })
    const buf = bufferFromOpenapiResult(wxacodeRes)
    if (buf) return buf
  } catch (e) {
    openapiErr = e
    if (!isInvalidWxTokenError(e)) throw e
  }

  const ctx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {}
  const appId = process.env.WX_APPID || process.env.TCB_APPID || ctx.APPID || ''
  const appSecret = process.env.WX_APP_SECRET || ''

  try {
    return await getUnlimitedViaHttp(appId, appSecret, { scene, page })
  } catch (httpErr) {
    if (openapiErr) {
      const hint = isInvalidWxTokenError(openapiErr)
        ? '（云 openapi 无有效 token，且 HTTP 回退未配置或失败）'
        : ''
      throw new Error(`${openapiErr.message || '生成失败'}${hint} ${httpErr.message || ''}`.trim())
    }
    throw httpErr
  }
}

module.exports = { getWxacodeUnlimitedBuffer }
