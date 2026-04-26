// 根据扫码 scene（与 employees.empId 一致）绑定推广关系
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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
      await db.collection('users').doc(user._id).update({
        data: {
          inviteEmpId: employee.empId,
          inviteCode: boundInviteCode,
          firstScene: scene,
          inviteBindTime: now
        }
      })
      await db.collection('referrals').add({ data: { ...baseReferral, isFirstBind: true } })
      return ok({
        message: '绑定成功',
        empId: employee.empId,
        inviteCode: boundInviteCode,
        firstScene: scene,
        isFirstBind: true
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
