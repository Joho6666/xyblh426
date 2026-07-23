// 用户互推：scene/ref 形如 u_<numericId>，与员工推广 emp_* 区分；奖励逻辑后续再接
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function parseNumericIdFromRef(ref) {
  const s = String(ref || '').trim()
  const m = /^u_([0-9]+)$/.exec(s)
  return m ? m[1] : ''
}

/** 绑定：被邀请人 OPENID 首次写入 inviterOpenid，不覆盖 */
async function bindPeer(event) {
  const { OPENID } = cloud.getWXContext()
  const ref = String(event.ref || '').trim()
  const numericIdStr = parseNumericIdFromRef(ref)

  const ok = (payload) => ({ success: true, clearScene: true, code: 0, ...payload })
  const fail = (message, extra = {}) => ({ success: false, clearScene: true, code: -1, message, ...extra })

  if (!OPENID) return fail('未授权', { clearScene: false })
  if (!numericIdStr) return fail('无效邀请参数', { clearScene: true })

  try {
    const invRes = await db.collection('users').where({ numericId: numericIdStr }).limit(1).get()
    const inviter = invRes.data[0]
    if (!inviter) return fail('邀请人不存在或编号已失效', { clearScene: true })
    if (inviter._openid === OPENID) return fail('不能邀请自己', { clearScene: true })
    if (inviter.status && inviter.status !== 'active') {
      return fail('邀请人账号不可用', { clearScene: true })
    }

    const userRes = await db.collection('users').where({ _openid: OPENID }).limit(1).get()
    const user = userRes.data[0]
    if (!user) return fail('用户不存在，请稍后重试', { clearScene: false })

    const now = db.serverDate()
    const userCreate = user.createTime || now
    const baseRow = {
      inviteeOpenid: OPENID,
      inviterOpenid: inviter._openid,
      inviterNumericId: numericIdStr,
      refScene: ref,
      scanTime: now,
      registerTime: userCreate,
      isFirstBind: false
    }

    const hadPeer = !!(user.inviterOpenid && String(user.inviterOpenid).trim())

    if (!hadPeer) {
      // 使用条件更新（仅当 inviterOpenid 不存在或为空时才写入），并发场景下只有一次成功
      const updateRes = await db.collection('users')
        .where({
          _id: user._id,
          inviterOpenid: _.or([_.exists(false), _.eq(''), _.eq(null)])
        })
        .update({
          data: {
            inviterOpenid: inviter._openid,
            peerInviteRef: ref,
            peerInviteBindTime: now
          }
        })
      const isFirst = !!(updateRes && updateRes.stats && updateRes.stats.updated > 0)
      await db.collection('peer_referrals').add({
        data: { ...baseRow, isFirstBind: isFirst }
      })
      if (isFirst) {
        return ok({
          message: '已绑定邀请人',
          inviterOpenid: inviter._openid,
          peerInviteRef: ref,
          isFirstBind: true
        })
      }
      // 并发兜底：另一并发请求已绑定，回查实际值
      const fresh = await db.collection('users').doc(user._id).get().catch(() => ({ data: null }))
      return ok({
        message: '已记录扫码（邀请关系以首次绑定为准）',
        inviterOpenid: (fresh && fresh.data && fresh.data.inviterOpenid) || inviter._openid,
        isFirstBind: false
      })
    }

    await db.collection('peer_referrals').add({ data: { ...baseRow, isFirstBind: false } })
    return ok({
      message: '已记录扫码（邀请关系以首次绑定为准）',
      inviterOpenid: user.inviterOpenid,
      isFirstBind: false
    })
  } catch (e) {
    console.error('[userReferral bind]', e)
    return fail(e.message || '服务异常', { clearScene: false })
  }
}

async function getStats() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: -1, msg: '未授权' }
  try {
    const [inviteCount, scanCount, uRes] = await Promise.all([
      db.collection('users').where({ inviterOpenid: OPENID }).count(),
      db
        .collection('peer_referrals')
        .where({ inviterOpenid: OPENID })
        .count()
        .catch(() => ({ total: 0 })),
      db.collection('users').where({ _openid: OPENID }).limit(1).get()
    ])
    const me = uRes.data[0] || {}
    return {
      code: 0,
      data: {
        inviteCount: inviteCount.total,
        referralScanCount: scanCount.total || 0,
        numericId: me.numericId != null && me.numericId !== '' ? String(me.numericId) : '',
        peerReferralQrcodeUrl: me.peerReferralQrcodeUrl || ''
      }
    }
  } catch (e) {
    return { code: -1, msg: e.message || '查询失败' }
  }
}

async function generateQrcode() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: -1, msg: '未授权' }

  const uRes = await db.collection('users').where({ _openid: OPENID }).limit(1).get()
  const me = uRes.data[0]
  if (!me) return { code: -1, msg: '用户不存在' }
  const nid = String(me.numericId || '').trim()
  if (!nid) return { code: -1, msg: '暂无用户编号，请稍后重试' }
  const scene = `u_${nid}`
  if (scene.length > 32) return { code: -1, msg: '编号过长，无法生成太阳码' }

  const wxacodeRes = await cloud.openapi.wxacode.getUnlimited({
    scene,
    page: 'pages/index/index',
    checkPath: false
  })

  let buffer = null
  if (Buffer.isBuffer(wxacodeRes)) {
    buffer = wxacodeRes
  } else if (wxacodeRes && Buffer.isBuffer(wxacodeRes.buffer)) {
    buffer = wxacodeRes.buffer
  } else if (wxacodeRes && wxacodeRes.errCode) {
    return { code: -1, msg: wxacodeRes.errMsg || '生成失败', errCode: wxacodeRes.errCode }
  }
  if (!buffer) {
    return { code: -1, msg: '未获取到二维码，请为 userReferral 配置 openapi：wxacode.getUnlimited' }
  }

  const cloudPath = `user_peer_qr/${OPENID}_${Date.now()}.png`
  const upload = await cloud.uploadFile({
    cloudPath,
    fileContent: buffer
  })

  await db.collection('users').doc(me._id).update({
    data: { peerReferralQrcodeUrl: upload.fileID }
  })
  return { code: 0, msg: '已生成', data: { fileID: upload.fileID, peerReferralQrcodeUrl: upload.fileID } }
}

exports.main = async (event) => {
  const action = String(event.action || 'bind').trim()
  if (action === 'getStats') return await getStats()
  if (action === 'generateQrcode') return await generateQrcode()
  return await bindPeer(event)
}
