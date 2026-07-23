// 根据扫码 scene（与 employees.empId 一致）绑定推广关系
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const scene = typeof event.scene === 'string' ? event.scene.trim() : String(event.scene || '').trim()

  const ok = (payload) => ({ success: true, clearScene: true, ...payload })
  const fail = (message, extra = {}) => ({ success: false, clearScene: true, message, ...extra })

  if (!OPENID) {
    return fail('未授权', { clearScene: false })
  }
  if (!scene) {
    return fail('无推广参数', { clearScene: true })
  }

  // 用户互推使用 u_<numericId>，由 userReferral 处理，勿走员工表
  if (/^u_[0-9]+$/.test(scene)) {
    return fail('此为好友邀请码', { clearScene: true, empId: null, isFirstBind: false })
  }

  try {
    const empRes = await db.collection('employees').where({ empId: scene }).limit(1).get()
    const employee = empRes.data[0]
    if (!employee) {
      return fail('无效推广码', { empId: null, isFirstBind: false })
    }

    const userRes = await db.collection('users').where({ _openid: OPENID }).limit(1).get()
    const user = userRes.data[0]
    if (!user) {
      return fail('用户不存在，请稍后重试', { clearScene: false })
    }

    const now = db.serverDate()
    const userCreate = user.createTime || now
    const baseReferral = {
      openid: OPENID,
      empId: employee.empId,
      inviteCode: employee.inviteCode || '',
      scene,
      scanTime: now,
      registerTime: userCreate,
      isFirstBind: false
    }

    if (employee.status !== 'enabled') {
      await db.collection('referrals').add({ data: { ...baseReferral, isFirstBind: false } })
      return fail('该推广员已停用', { empId: employee.empId, isFirstBind: false })
    }

    const hadInvite = !!(user.inviteEmpId && String(user.inviteEmpId).trim())
    let boundEmpId = user.inviteEmpId || ''
    let boundInviteCode = user.inviteCode || ''

    if (!hadInvite) {
      boundEmpId = employee.empId
      boundInviteCode = employee.inviteCode || ''
      // 条件更新：只在 inviteEmpId 仍为空时写入，并发场景下只有一次成功
      const updRes = await db.collection('users')
        .where({
          _id: user._id,
          inviteEmpId: _.or([_.exists(false), _.eq(''), _.eq(null)])
        })
        .update({
          data: {
            inviteEmpId: employee.empId,
            inviteCode: boundInviteCode,
            firstScene: scene,
            inviteBindTime: now
          }
        })
      const isFirst = !!(updRes && updRes.stats && updRes.stats.updated > 0)
      await db.collection('referrals').add({ data: { ...baseReferral, isFirstBind: isFirst } })
      if (isFirst) {
        return ok({
          message: '绑定成功',
          empId: employee.empId,
          inviteCode: boundInviteCode,
          firstScene: scene,
          isFirstBind: true
        })
      }
      // 并发兜底：另一并发请求已绑定，回查实际值
      const fresh = await db.collection('users').doc(user._id).get().catch(() => ({ data: null }))
      const freshUser = (fresh && fresh.data) || {}
      return ok({
        message: '已记录扫码（推广来源以首次绑定为准，未修改）',
        empId: freshUser.inviteEmpId || boundEmpId,
        inviteCode: freshUser.inviteCode || boundInviteCode,
        isFirstBind: false
      })
    }

    await db.collection('referrals').add({ data: { ...baseReferral, isFirstBind: false } })
    return ok({
      message: '已记录扫码（推广来源以首次绑定为准，未修改）',
      empId: boundEmpId,
      inviteCode: boundInviteCode,
      isFirstBind: false
    })
  } catch (err) {
    console.error('[bindInviteEmployee]', err)
    return fail(err.message || '服务异常', { clearScene: false })
  }
}
