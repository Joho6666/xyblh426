// 管理后台云函数 - 供 H5 admin.html 与小程序管理员能力使用
// 若调整管理接口逻辑，请同步维护 dbOperations/webAdminHandlers.js（H5 经 callAdminPanel 内联执行）
// 鉴权：① users 表中 role=admin 的小程序用户 OPENID；② 环境变量 ADMIN_WEB_SECRET 与请求 webSecret 一致（Web 匿名登录）

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function checkAdmin(openid) {
  if (!openid) return false
  const res = await db.collection('users').where({ _openid: openid, role: 'admin', status: 'active' }).get()
  return res.data.length > 0
}

function reportTargetCollection(targetType) {
  if (targetType === 'post') return 'posts'
  if (targetType === 'comment') return 'comments'
  if (targetType === 'goods') return 'market_goods'
  if (targetType === 'market_comment' || targetType === 'goods_comment') return 'market_comments'
  if (targetType === 'user') return 'users'
  return ''
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action, data = {}, webSecret } = event

  const envSecret = process.env.ADMIN_WEB_SECRET
  const secretOk = !!(envSecret && webSecret && String(webSecret) === String(envSecret))

  let isAdmin = false
  if (secretOk) {
    isAdmin = true
  } else {
    isAdmin = await checkAdmin(OPENID)
  }

  if (!isAdmin) {
    return {
      code: -403,
      msg:
        '无管理员权限：请在云开发控制台为云函数 adminPanel 配置环境变量 ADMIN_WEB_SECRET，并在 admin.html 的 CONFIG.ADMIN_WEB_SECRET 填写相同密钥（建议 16 位以上随机字符串）'
    }
  }

  try {
    switch (action) {
      case 'getStats':
        return await getStats()
      case 'getPosts':
        return await getPostList(data)
      case 'setPostStatus':
        return await updatePostStatus(data.postId, data.status)
      case 'approvePost':
        return await updatePostStatus(data.postId, 'active')
      case 'rejectPost':
        return await updatePostStatus(data.postId, 'rejected')
      case 'deletePost':
        return await updatePostStatus(data.postId, 'deleted')
      case 'toggleTopPost':
        return await toggleTopPost(data.postId)
      case 'lockPost':
        return await lockPost(data.postId)

      case 'getMarketGoodsList':
        return await getMarketGoodsList(data)
      case 'setGoodsStatus':
        return await setGoodsStatus(data.goodsId, data.status)

      case 'getUsers':
        return await getUserList(data)
      case 'getUserAdminDetail':
        return await getUserAdminDetail(data)
      case 'banUser':
        return await banUser(data.targetOpenid)
      case 'banUserDays':
        return await banUserWithDays(data.targetOpenid, data.days)
      case 'unbanUser':
        return await unbanUser(data.targetOpenid)
      case 'setAdmin':
        return await setUserRole(data.targetOpenid, 'admin')
      case 'removeAdmin':
        return await setUserRole(data.targetOpenid, 'user')
      case 'muteUser':
        return await setUserMute(data.targetOpenid, true)
      case 'unmuteUser':
        return await setUserMute(data.targetOpenid, false)
      case 'banLikeUser':
        return await setUserLikeBan(data.targetOpenid, true)
      case 'unbanLikeUser':
        return await setUserLikeBan(data.targetOpenid, false)

      case 'getReports':
        return await getReportList(data)
      case 'handleReport':
        return await handleReport(data.reportId, data.result)

      case 'getComments':
        return await getCommentList(data)
      case 'getCommentsAdmin':
        return await getCommentsAdmin(data)
      case 'deleteComment':
        return await deleteComment(data.commentId)
      case 'deleteCommentAdmin':
        return await deleteCommentAdmin(data.commentId, data.scope || 'post')

      case 'getEmployeeReferralStats':
        return await getEmployeeReferralStats()
      case 'generateEmployeeQrcode':
        return await generateEmployeeQrcode(data)

      default:
        return { code: -1, msg: '未知操作: ' + action }
    }
  } catch (err) {
    console.error(`管理操作[${action}]失败:`, err)
    return { code: -1, msg: err.message || '操作失败' }
  }
}

async function getStats() {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const [
    totalPosts,
    todayPosts,
    pendingPosts,
    totalUsers,
    todayUsers,
    pendingReports,
    totalComments,
    marketComments
  ] = await Promise.all([
    db.collection('posts').where({ status: 'active' }).count(),
    db.collection('posts').where({ status: 'active', createTime: _.gte(todayStart) }).count(),
    db.collection('posts').where({ status: 'pending' }).count(),
    db.collection('users').where({ status: 'active' }).count(),
    db.collection('users').where({ createTime: _.gte(todayStart) }).count(),
    db.collection('reports').where({ status: 'pending' }).count(),
    db.collection('comments').where({ status: 'active' }).count(),
    db.collection('market_comments')
      .where({ status: 'active' })
      .count()
      .catch(() => ({ total: 0 }))
  ])

  return {
    code: 0,
    data: {
      totalPosts: totalPosts.total,
      todayPosts: todayPosts.total,
      pendingPosts: pendingPosts.total,
      totalUsers: totalUsers.total,
      todayUsers: todayUsers.total,
      pendingReports: pendingReports.total,
      totalComments: totalComments.total + (marketComments.total || 0),
      postComments: totalComments.total,
      marketComments: marketComments.total || 0
    }
  }
}

async function getPostList({
  page = 1,
  pageSize = 20,
  status,
  category,
  keyword,
  excludeDeleted
}) {
  let condition = {}
  if (status) {
    condition.status = status
  } else if (excludeDeleted) {
    condition.status = _.neq('deleted')
  }
  if (category && category !== '全部') condition.category = category

  const res = await db
    .collection('posts')
    .where(condition)
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  let posts = res.data
  if (keyword && keyword.trim()) {
    const kw = keyword.trim().toLowerCase()
    posts = posts.filter(
      (p) =>
        (p.content && p.content.toLowerCase().includes(kw)) ||
        (p.nickname && p.nickname.toLowerCase().includes(kw)) ||
        (p.title && p.title.toLowerCase().includes(kw)) ||
        (p._openid && p._openid.includes(kw))
    )
  }

  const total = await db.collection('posts').where(condition).count()
  return { code: 0, data: posts, total: total.total, page, pageSize }
}

async function updatePostStatus(postId, status) {
  await db.collection('posts').doc(postId).update({
    data: { status, updateTime: db.serverDate() }
  })
  const labels = {
    active: '已恢复/通过',
    hidden: '已下架',
    deleted: '已删除',
    pending: '已设为待审核',
    rejected: '已拒绝'
  }
  return { code: 0, msg: labels[status] || '帖子状态已更新' }
}

async function toggleTopPost(postId) {
  const postRes = await db.collection('posts').doc(postId).get()
  const doc = postRes.data
  if (!doc || !doc._id) return { code: -1, msg: '帖子不存在' }
  const newIsTop = !doc.isTop
  await db.collection('posts').doc(postId).update({
    data: { isTop: newIsTop }
  })
  return { code: 0, data: { isTop: newIsTop } }
}

async function lockPost(postId) {
  await db.collection('posts').doc(postId).update({
    data: { isLocked: true, updateTime: db.serverDate() }
  })
  return { code: 0, msg: '帖子已锁定' }
}

async function getMarketGoodsList({ status, category } = {}) {
  let cond = {}
  if (status) cond.status = status
  else cond.status = _.neq('deleted')
  if (category) cond.category = category
  try {
    const res = await db.collection('market_goods').where(cond).orderBy('createTime', 'desc').limit(50).get()
    return { code: 0, data: res.data }
  } catch (e) {
    if (e.message && e.message.includes('not exist')) return { code: 0, data: [] }
    return { code: -1, msg: e.message }
  }
}

async function setGoodsStatus(goodsId, status) {
  const patch = { status, updateTime: db.serverDate() }
  if (status === 'deleted') patch.deleteTime = db.serverDate()
  await db.collection('market_goods').doc(goodsId).update({ data: patch })
  return { code: 0, msg: '商品状态已更新' }
}

async function getUserList({ page = 1, pageSize = 20, status, role, keyword }) {
  let condition = {}
  if (status) condition.status = status
  if (role) condition.role = role

  const res = await db
    .collection('users')
    .where(condition)
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  let users = res.data
  if (keyword && keyword.trim()) {
    const kw = keyword.trim().toLowerCase()
    users = users.filter(
      (u) =>
        (u.nickName && u.nickName.toLowerCase().includes(kw)) ||
        (u.college && u.college.toLowerCase().includes(kw)) ||
        (u._openid && u._openid.includes(kw))
    )
  }

  for (const user of users) {
    const postCount = await db.collection('posts').where({ _openid: user._openid, status: 'active' }).count()
    user.postCount = postCount.total
  }

  const total = await db.collection('users').where(condition).count()
  return { code: 0, data: users, total: total.total, page, pageSize }
}

/** Web 管理端用户详情：避免浏览器直连 users/posts/follows 触发安全规则 */
async function getUserAdminDetail({ targetOpenid } = {}) {
  if (!targetOpenid) return { code: -1, msg: '缺少 targetOpenid' }
  const userRes = await db.collection('users').where({ _openid: targetOpenid }).limit(1).get()
  if (!userRes.data.length) return { code: -1, msg: '用户不存在' }
  const u = userRes.data[0]
  const [pc, fic, foc, rp] = await Promise.all([
    db.collection('posts').where({ _openid: targetOpenid, status: 'active' }).count(),
    db.collection('follows').where({ _openid: targetOpenid }).count(),
    db.collection('follows').where({ targetOpenid: targetOpenid }).count(),
    db.collection('posts').where({ _openid: targetOpenid }).orderBy('createTime', 'desc').limit(3).get()
  ])
  return {
    code: 0,
    data: {
      user: u,
      postCount: pc.total,
      followingCount: fic.total,
      followerCount: foc.total,
      recentPosts: rp.data || []
    }
  }
}

async function hideUserContent(targetOpenid) {
  await db.collection('posts').where({ _openid: targetOpenid }).update({ data: { status: 'hidden' } })
  await db
    .collection('market_goods')
    .where({ _openid: targetOpenid })
    .update({ data: { status: 'hidden' } })
    .catch((err) => {
      if (!(err && err.message && err.message.includes('not exist'))) throw err
    })
  await db.collection('comments').where({ _openid: targetOpenid, status: 'active' }).update({ data: { status: 'hidden' } })
  await db
    .collection('market_comments')
    .where({ _openid: targetOpenid, status: 'active' })
    .update({ data: { status: 'hidden' } })
    .catch((err) => {
      if (!(err && err.message && err.message.includes('not exist'))) throw err
    })
}

async function banUser(targetOpenid) {
  await db
    .collection('users')
    .where({ _openid: targetOpenid })
    .update({ data: { status: 'banned', banTime: db.serverDate(), banExpiry: null } })
  await hideUserContent(targetOpenid)
  return { code: 0, msg: '用户已封禁' }
}

async function banUserWithDays(targetOpenid, days) {
  const update = { status: 'banned', banTime: db.serverDate() }
  if (days && Number(days) > 0) {
    const expiry = new Date()
    expiry.setDate(expiry.getDate() + Number(days))
    update.banExpiry = expiry
  } else {
    update.banExpiry = null
  }
  await db.collection('users').where({ _openid: targetOpenid }).update({ data: update })
  await hideUserContent(targetOpenid)
  return { code: 0, msg: days > 0 ? `已封禁 ${days} 天` : '已永久封禁' }
}

async function unbanUser(targetOpenid) {
  await db
    .collection('users')
    .where({ _openid: targetOpenid })
    .update({ data: { status: 'active', banTime: null, banExpiry: null } })
  await db.collection('posts').where({ _openid: targetOpenid, status: 'hidden' }).update({ data: { status: 'active' } })
  await db
    .collection('market_goods')
    .where({ _openid: targetOpenid, status: 'hidden' })
    .update({ data: { status: 'active' } })
    .catch((err) => {
      if (!(err && err.message && err.message.includes('not exist'))) throw err
    })
  await db.collection('comments').where({ _openid: targetOpenid, status: 'hidden' }).update({ data: { status: 'active' } })
  await db
    .collection('market_comments')
    .where({ _openid: targetOpenid, status: 'hidden' })
    .update({ data: { status: 'active' } })
    .catch((err) => {
      if (!(err && err.message && err.message.includes('not exist'))) throw err
    })
  return { code: 0, msg: '用户已解封' }
}

async function setUserRole(targetOpenid, role) {
  if (!targetOpenid || typeof targetOpenid !== 'string') {
    return { code: -1, msg: '缺少有效的 targetOpenid' }
  }
  const userRes = await db.collection('users').where({ _openid: targetOpenid }).limit(1).get()
  if (!userRes.data || !userRes.data.length) {
    return { code: -1, msg: '未找到该用户，请确认 openid 是否正确' }
  }
  const docId = userRes.data[0]._id
  const patch = { role }
  // checkAdmin 要求 role=admin 且 status=active；被封禁用户仅改 role 会导致「仍是管理员但无任何管理员能力」
  if (role === 'admin') {
    patch.status = 'active'
    patch.banTime = null
    patch.banExpiry = null
  }
  await db.collection('users').doc(docId).update({ data: patch })
  return { code: 0, msg: `用户角色已设为${role === 'admin' ? '管理员' : '普通用户'}` }
}

async function setUserMute(targetOpenid, muted) {
  await db.collection('users').where({ _openid: targetOpenid }).update({ data: { isMuted: muted } })
  return { code: 0, msg: muted ? '已禁言' : '已解除禁言' }
}

async function setUserLikeBan(targetOpenid, banned) {
  await db.collection('users').where({ _openid: targetOpenid }).update({ data: { isLikeBanned: banned } })
  return { code: 0, msg: banned ? '已禁止点赞' : '已恢复点赞' }
}

async function getReportList({ page = 1, pageSize = 20, status }) {
  let condition = {}
  if (status) condition.status = status

  const res = await db
    .collection('reports')
    .where(condition)
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  for (const report of res.data) {
    if (report.targetType === 'post') {
      try {
        const postRes = await db.collection('posts').doc(report.targetId).get()
        const d = postRes.data
        report.targetContent = d ? d.content : '(帖子已删除)'
        report.targetNickname = d ? d.nickname : ''
      } catch (e) {
        report.targetContent = '(帖子已删除)'
      }
    } else if (report.targetType === 'comment') {
      try {
        const commentRes = await db.collection('comments').doc(report.targetId).get()
        const d = commentRes.data
        report.targetContent = d ? d.content : '(评论已删除)'
        report.targetNickname = d ? d.nickname : ''
      } catch (e) {
        report.targetContent = '(评论已删除)'
      }
    }
    try {
      const userRes = await db.collection('users').where({ _openid: report._openid }).get()
      report.reporterName = userRes.data[0] ? userRes.data[0].nickName : '未知用户'
    } catch (e) {
      report.reporterName = '未知用户'
    }
  }

  const total = await db.collection('reports').where(condition).count()
  return { code: 0, data: res.data, total: total.total, page, pageSize }
}

async function handleReport(reportId, result) {
  const reportRes = await db.collection('reports').doc(reportId).get()
  const report = reportRes.data
  if (!report) return { code: -1, msg: '举报不存在' }

  await db.collection('reports').doc(reportId).update({
    data: { status: result, handleTime: db.serverDate() }
  })

  if (result !== 'resolved') {
    return { code: 0, msg: '举报已驳回' }
  }

  const tid = report.targetId
  const ttype = report.targetType
  const collection = reportTargetCollection(ttype)
  if (!collection || !tid) {
    return { code: 0, msg: '举报已处理' }
  }

  let targetDoc = null
  try {
    const tr = await db.collection(collection).doc(tid).get()
    targetDoc = tr.data || null
  } catch (e) {}

  const wasActive = !!(targetDoc && targetDoc.status === 'active')
  const deleteData =
    collection === 'market_goods'
      ? { status: 'deleted', deleteTime: db.serverDate() }
      : { status: 'deleted' }

  if (targetDoc && targetDoc.status !== 'deleted') {
    await db.collection(collection).doc(tid).update({ data: deleteData })
  }

  if (wasActive && collection === 'comments' && targetDoc && targetDoc.postId) {
    try {
      await db.collection('posts').doc(targetDoc.postId).update({ data: { comments: _.inc(-1) } })
    } catch (e) {}
  }
  if (wasActive && collection === 'market_comments' && targetDoc && targetDoc.goodsId) {
    try {
      await db.collection('market_goods').doc(targetDoc.goodsId).update({ data: { commentCount: _.inc(-1) } })
    } catch (e) {}
  }

  return { code: 0, msg: '举报已处理，内容已删除' }
}

async function getCommentList({ page = 1, pageSize = 20, postId, status }) {
  let condition = {}
  if (status) condition.status = status
  else condition.status = 'active'
  if (postId) condition.postId = postId

  const res = await db
    .collection('comments')
    .where(condition)
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  const total = await db.collection('comments').where(condition).count()
  return { code: 0, data: res.data, total: total.total }
}

async function getCommentsAdmin({ type = 'all', status, limit = 80 } = {}) {
  const cond = {}
  if (status != null && String(status) !== '') cond.status = status

  let list = []
  if (type === 'post') {
    const postRes = await db.collection('comments').where(cond).orderBy('createTime', 'desc').limit(limit).get()
    list = (postRes.data || []).map((item) => ({ ...item, _commentType: 'post' }))
  } else if (type === 'market') {
    const marketRes = await db
      .collection('market_comments')
      .where(cond)
      .orderBy('createTime', 'desc')
      .limit(limit)
      .get()
      .catch(() => ({ data: [] }))
    list = (marketRes.data || []).map((item) => ({ ...item, _commentType: 'market' }))
  } else {
    const [postRes, marketRes] = await Promise.all([
      db.collection('comments').where(cond).orderBy('createTime', 'desc').limit(60).get(),
      db
        .collection('market_comments')
        .where(cond)
        .orderBy('createTime', 'desc')
        .limit(60)
        .get()
        .catch(() => ({ data: [] }))
    ])
    list = [
      ...(postRes.data || []).map((item) => ({ ...item, _commentType: 'post' })),
      ...((marketRes.data || []).map((item) => ({ ...item, _commentType: 'market' })))
    ]
    list.sort((a, b) => new Date(b.createTime || 0) - new Date(a.createTime || 0))
    list = list.slice(0, 100)
  }

  return { code: 0, data: list }
}

async function deleteComment(commentId) {
  return deleteCommentAdmin(commentId, 'post')
}

async function deleteCommentAdmin(commentId, scope) {
  if (scope === 'market') {
    let current = null
    try {
      const res = await db.collection('market_comments').doc(commentId).get()
      current = res.data || null
    } catch (e) {}
    await db.collection('market_comments').doc(commentId).update({ data: { status: 'deleted' } })
    const goodsId = current && current.goodsId
    if (goodsId && current && current.status === 'active') {
      try {
        await db.collection('market_goods').doc(goodsId).update({ data: { commentCount: _.inc(-1) } })
      } catch (e) {}
    }
    return { code: 0, msg: '评论已删除' }
  }

  let current = null
  try {
    const res = await db.collection('comments').doc(commentId).get()
    current = res.data || null
  } catch (e) {}
  await db.collection('comments').doc(commentId).update({ data: { status: 'deleted' } })
  const postId = current && current.postId
  if (postId && current && current.status === 'active') {
    try {
      await db.collection('posts').doc(postId).update({ data: { comments: _.inc(-1) } })
    } catch (e) {}
  }
  return { code: 0, msg: '评论已删除' }
}

/** 员工推广统计：成功邀请人数 + 扫码次数 */
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

/** 生成员工专属小程序码并写入 employees.qrcodeUrl（fileID） */
async function generateEmployeeQrcode(data = {}) {
  const empId = String(data.empId || '').trim()
  if (!empId) return { code: -1, msg: '缺少 empId' }
  if (empId.length > 32) return { code: -1, msg: 'scene 最长 32 字符（与微信接口一致）' }

  const empRes = await db.collection('employees').where({ empId }).limit(1).get()
  if (!empRes.data.length) return { code: -1, msg: '员工不存在' }
  const doc = empRes.data[0]

  const wxacodeRes = await cloud.openapi.wxacode.getUnlimited({
    scene: empId,
    page: 'pages/index/index',
    checkPath: false
  })

  let buffer = null
  if (Buffer.isBuffer(wxacodeRes)) {
    buffer = wxacodeRes
  } else if (wxacodeRes && Buffer.isBuffer(wxacodeRes.buffer)) {
    buffer = wxacodeRes.buffer
  } else if (wxacodeRes && wxacodeRes.errCode) {
    return {
      code: -1,
      msg: wxacodeRes.errMsg || '生成小程序码失败',
      errCode: wxacodeRes.errCode
    }
  }

  if (!buffer) {
    return { code: -1, msg: '未获取到二维码图片，请为 adminPanel 配置 openapi：wxacode.getUnlimited' }
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

