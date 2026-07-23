/**
 * 员工推广（H5 admin / adminPanel 共用）
 */
const { getWxacodeUnlimitedBuffer } = require('./wxacodeHelper')

module.exports = function createEmployeeReferralHandlers(db, _, cloud) {
  async function getEmployeeReferralStats() {
    let employees = []
    try {
      const empRes = await db.collection('employees').get()
      employees = empRes.data || []
    } catch (e) {
      console.warn('[getEmployeeReferralStats] employees', e)
      return { code: 0, data: [] }
    }

    const rows = await Promise.all(
      employees.map(async (e) => {
        const empId = e.empId
        const [inviteRes, scanRes] = await Promise.all([
          db.collection('users').where({ inviteEmpId: empId }).count(),
          db
            .collection('referrals')
            .where({ empId })
            .count()
            .catch(() => ({ total: 0 }))
        ])
        return {
          ...e,
          inviteCount: inviteRes.total,
          referralScanCount: scanRes.total || 0
        }
      })
    )
    return { code: 0, data: rows }
  }

  async function generateEmployeeQrcode(data = {}) {
    const empId = String(data.empId || '').trim()
    if (!empId) return { code: -1, msg: '缺少 empId' }
    if (empId.length > 32) return { code: -1, msg: 'scene 最长 32 字符（与微信接口一致）' }

    const empRes = await db.collection('employees').where({ empId }).limit(1).get()
    if (!empRes.data.length) return { code: -1, msg: '员工不存在' }
    const doc = empRes.data[0]

    let buffer
    try {
      buffer = await getWxacodeUnlimitedBuffer(cloud, {
        scene: empId,
        page: 'pages/index/index'
      })
    } catch (e) {
      return { code: -1, msg: e.message || '生成小程序码失败' }
    }

    const cloudPath = `employee_qrcode/${empId}_${Date.now()}.png`
    const upload = await cloud.uploadFile({
      cloudPath,
      fileContent: buffer
    })

    await db.collection('employees').doc(doc._id).update({
      data: { qrcodeUrl: upload.fileID }
    })
    return { code: 0, msg: '已生成并上传', data: { fileID: upload.fileID, qrcodeUrl: upload.fileID } }
  }

  async function saveEmployee(data = {}) {
    const isNew = !!data.isNew
    const empId = String(data.empId || '').trim()
    const name = String(data.name || '').trim()
    const inviteCode = String(data.inviteCode || '').trim()
    const status = data.status === 'disabled' ? 'disabled' : 'enabled'

    if (!empId) return { code: -1, msg: '员工编号不能为空' }
    if (empId.length > 32) return { code: -1, msg: '员工编号最长 32 字符（与太阳码 scene 一致）' }
    if (!/^[a-zA-Z0-9_-]+$/.test(empId)) {
      return { code: -1, msg: '员工编号仅允许字母、数字、下划线、短横线' }
    }
    if (!name) return { code: -1, msg: '姓名不能为空' }
    if (name.length > 40) return { code: -1, msg: '姓名最多 40 字' }
    if (inviteCode.length > 32) return { code: -1, msg: '邀请码过长' }

    const existing = await db.collection('employees').where({ empId }).limit(1).get()
    const doc = existing.data[0]

    if (isNew) {
      if (doc) return { code: -1, msg: '该员工编号已存在，请换一个或改为编辑' }
      await db.collection('employees').add({
        data: {
          empId,
          name,
          inviteCode,
          qrcodeUrl: '',
          status,
          createTime: db.serverDate()
        }
      })
      return { code: 0, msg: '已添加员工' }
    }

    if (!doc) return { code: -1, msg: '员工不存在' }
    await db.collection('employees').doc(doc._id).update({
      data: {
        name,
        inviteCode,
        status,
        updateTime: db.serverDate()
      }
    })
    return { code: 0, msg: '已保存' }
  }

  return {
    getEmployeeReferralStats,
    saveEmployee,
    generateEmployeeQrcode
  }
}
