// H5 管理后台：与 adminPanel 相同的管理逻辑，在 dbOperations 进程内执行（避免云函数互调失败）
const { buildMarketCategoryWhere } = require('./marketCategories')
const createAnalyticsDashboard = require('./analyticsDashboard')
const createEmployeeReferralHandlers = require('./employeeReferralHandlers')
const activityZoneCore = require('./activityZoneCore')

module.exports = function createWebAdminDispatch(db, _, cloud, hooks = {}) {
  const analyticsApi = createAnalyticsDashboard(db, _)
  const employeeReferral = createEmployeeReferralHandlers(db, _, cloud)
  const DEFAULT_CAMPUS_ID = 'guit-hangtian'
  const triggerSubscribeNotify =
    typeof hooks.triggerSubscribeNotify === 'function' ? hooks.triggerSubscribeNotify : async () => {}

  function trimSnippet(text, max = 60) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim()
    if (!normalized) return ''
    return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
  }

  function campusWhereClause(campusId) {
    if (!campusId) return null
    if (campusId === DEFAULT_CAMPUS_ID) {
      return _.or([{ campusId: DEFAULT_CAMPUS_ID }, { campusId: _.exists(false) }])
    }
    return { campusId }
  }

  function mergeWhere(base, extra) {
    if (!extra) return base
    const keys = Object.keys(base)
    if (!keys.length) return extra
    return _.and([base, extra])
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** 昵称/学院/openid/角色关键词（数据库模糊匹配） */
  function userKeywordWhere(keyword) {
    const kw = String(keyword || '').trim()
    if (!kw) return null
    const lower = kw.toLowerCase()
    const parts = []
    try {
      const regex = db.RegExp({ regexp: escapeRegExp(kw), options: 'i' })
      parts.push({ nickName: regex }, { college: regex }, { _openid: regex }, { nickname: regex }, { campusName: regex })
    } catch (e) {
      return null
    }
    if (/管理员|admin/i.test(kw)) parts.push({ role: 'admin' })
    if (/普通用户|^user$/i.test(kw)) parts.push({ role: 'user' })
    return parts.length ? _.or(parts) : null
  }

  function userMatchesKeyword(u, keyword) {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return true
    const nick = String(u.nickName || u.nickname || '').toLowerCase()
    const college = String(u.college || '').toLowerCase()
    const campus = String(u.campusName || '').toLowerCase()
    const openid = String(u._openid || '')
    const role = String(u.role || '')
    if (nick.includes(kw) || college.includes(kw) || campus.includes(kw) || openid.includes(kw)) return true
    if (/管理员|admin/.test(kw) && role === 'admin') return true
    if (/普通|用户|^user$/.test(kw) && role === 'user') return true
    return false
  }

  function normalizeCampusIds(raw) {
    const list = Array.isArray(raw) ? raw : []
    const ids = Array.from(new Set(list.map((x) => String(x || '').trim()).filter(Boolean)))
    return ids.length ? ids : ['all']
  }

  function reportTargetCollection(targetType) {
    if (targetType === 'post') return 'posts'
    if (targetType === 'comment') return 'comments'
    if (targetType === 'goods') return 'market_goods'
    if (targetType === 'market_comment' || targetType === 'goods_comment') return 'market_comments'
    if (targetType === 'user') return 'users'
    return ''
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
    excludeDeleted,
    campusId
  }) {
    let condition = {}
    if (status) {
      condition.status = status
    } else if (excludeDeleted) {
      condition.status = _.neq('deleted')
    }
    if (category && category !== '全部') condition.category = category
    const cw = campusWhereClause(campusId)
    condition = mergeWhere(condition, cw)

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

  async function getMarketGoodsList({ status, category, campusId } = {}) {
    let cond = {}
    if (status) cond.status = status
    else cond.status = _.neq('deleted')
    if (category) cond = mergeWhere(cond, buildMarketCategoryWhere(_, category))
    const cw = campusWhereClause(campusId)
    cond = mergeWhere(cond, cw)
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

  async function getUserList({ page = 1, pageSize = 20, status, role, keyword, campusId }) {
    let condition = {}
    if (status) condition.status = status
    if (role) condition.role = role
    const cw = campusWhereClause(campusId)
    condition = mergeWhere(condition, cw)
    const kw = String(keyword || '').trim()
    const kwWhere = userKeywordWhere(kw)
    if (kwWhere) condition = mergeWhere(condition, kwWhere)

    const searching = !!kw
    const safePageSize = Math.max(1, Math.min(searching ? 200 : 80, Number(pageSize) || 50))
    const skip = searching ? 0 : (Math.max(1, Number(page) || 1) - 1) * safePageSize

    let res
    try {
      res = await db
        .collection('users')
        .where(condition)
        .orderBy('createTime', 'desc')
        .skip(skip)
        .limit(safePageSize)
        .get()
    } catch (err) {
      if (searching && kwWhere) {
        let fallbackCond = {}
        if (status) fallbackCond.status = status
        if (role) fallbackCond.role = role
        fallbackCond = mergeWhere(fallbackCond, cw)
        res = await db
          .collection('users')
          .where(fallbackCond)
          .orderBy('createTime', 'desc')
          .limit(500)
          .get()
        res.data = (res.data || []).filter((u) => userMatchesKeyword(u, kw))
      } else {
        throw err
      }
    }

    let users = res.data || []
    if (searching && users.length && !kwWhere) {
      users = users.filter((u) => userMatchesKeyword(u, kw))
    }

    for (const user of users) {
      const postCount = await db.collection('posts').where({ _openid: user._openid, status: 'active' }).count()
      user.postCount = postCount.total
    }

    const total = searching ? users.length : (await db.collection('users').where(condition).count()).total
    return { code: 0, data: users, total, page, pageSize: safePageSize }
  }

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
    await db.collection('posts').where({ _openid: targetOpenid, status: 'active' }).update({ data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() } })
    await db
      .collection('market_goods')
      .where({ _openid: targetOpenid, status: 'active' })
      .update({ data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() } })
      .catch((err) => {
        if (!(err && err.message && err.message.includes('not exist'))) throw err
      })
    await db.collection('comments').where({ _openid: targetOpenid, status: 'active' }).update({ data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() } })
    await db
      .collection('market_comments')
      .where({ _openid: targetOpenid, status: 'active' })
      .update({ data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() } })
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
    await db
      .collection('posts')
      .where({ _openid: targetOpenid, status: 'hidden', hiddenBy: 'banUser' })
      .update({ data: { status: 'active', hiddenBy: null, hiddenAt: null } })
    await db
      .collection('market_goods')
      .where({ _openid: targetOpenid, status: 'hidden', hiddenBy: 'banUser' })
      .update({ data: { status: 'active', hiddenBy: null, hiddenAt: null } })
      .catch((err) => {
        if (!(err && err.message && err.message.includes('not exist'))) throw err
      })
    await db
      .collection('comments')
      .where({ _openid: targetOpenid, status: 'hidden', hiddenBy: 'banUser' })
      .update({ data: { status: 'active', hiddenBy: null, hiddenAt: null } })
    await db
      .collection('market_comments')
      .where({ _openid: targetOpenid, status: 'hidden', hiddenBy: 'banUser' })
      .update({ data: { status: 'active', hiddenBy: null, hiddenAt: null } })
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

    // 举报对象为用户：仅标记举报已处理，账号封禁/拉黑请到「用户管理」操作
    if (ttype === 'user') {
      return { code: 0, msg: '举报已处理（用户账号请到用户管理操作）' }
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

  async function getAdminAnnouncementList({ page = 1, pageSize = 30 } = {}) {
    const safePage = Math.max(1, Number(page) || 1)
    const safeSize = Math.max(1, Math.min(50, Number(pageSize) || 30))
    try {
      const res = await db
        .collection('announcements')
        .orderBy('createTime', 'desc')
        .skip((safePage - 1) * safeSize)
        .limit(safeSize)
        .get()
      return { code: 0, data: res.data || [] }
    } catch (e) {
      if (e.message && e.message.includes('not exist')) return { code: 0, data: [] }
      throw e
    }
  }

  async function createAnnouncementWeb(data = {}) {
    const title = String(data.title || '').trim()
    const content = String(data.content || '').trim()
    if (!title) return { code: -1, msg: '公告标题不能为空' }
    if (!content) return { code: -1, msg: '公告内容不能为空' }
    const images = Array.isArray(data.images)
      ? data.images.filter((x) => typeof x === 'string' && x.trim())
      : []
    if (images.length > 10) return { code: -1, msg: '公告最多 10 张图片' }
    const doc = {
      _openid: 'web-admin',
      title,
      content,
      images,
      campusIds: normalizeCampusIds(data.campusIds),
      status: data.status === 'published' ? 'published' : 'draft',
      priority: ['normal', 'important', 'urgent'].includes(data.priority) ? data.priority : 'normal',
      pinTop: !!data.pinTop,
      publishAt: data.status === 'published' ? db.serverDate() : null,
      expireAt: data.expireAt ? new Date(data.expireAt) : null,
      createdByOpenid: 'web-admin',
      createdByName: 'Web管理后台',
      readCount: 0,
      targetCount: 0,
      notifySent: false,
      notifySentAt: null,
      createTime: db.serverDate(),
      updateTime: db.serverDate()
    }
    const res = await db.collection('announcements').add({ data: doc })
    return { code: 0, msg: '公告已创建', data: { _id: res._id } }
  }

  async function publishAnnouncementWeb(data = {}) {
    const id = String(data.announcementId || '').trim()
    if (!id) return { code: -1, msg: '缺少公告ID' }
    const aRes = await db.collection('announcements').doc(id).get().catch(() => ({ data: null }))
    const item = aRes.data
    if (!item) return { code: -1, msg: '公告不存在' }
    await db.collection('announcements').doc(id).update({
      data: { status: 'published', publishAt: db.serverDate(), updateTime: db.serverDate() }
    })
    if (data.sendNotify === true && item.campusIds) {
      const where =
        item.campusIds.indexOf('all') >= 0
          ? { status: 'active' }
          : { status: 'active', campusId: _.in(item.campusIds || [DEFAULT_CAMPUS_ID]) }
      const users = await db.collection('users').where(where).limit(500).get()
      const toOpenids = Array.from(
        new Set(
          (users.data || [])
            .map((u) => String(u._openid || '').trim())
            .filter(Boolean)
        )
      )
      if (toOpenids.length) {
        const title = trimSnippet(item.title || '社区公告', 20)
        const summary = trimSnippet(item.content || item.title || '社区公告', 20)
        let sent = 0
        for (const toOpenid of toOpenids) {
          try {
            await triggerSubscribeNotify({
              toOpenid,
              sceneType: 'announcement',
              itemTitle: title,
              summary,
              announcementType: '社区公告',
              page: '/pages/announcement/announcement'
            })
            sent += 1
          } catch (err) {
            console.warn('[webAdmin] 推送公告通知失败', toOpenid, err)
          }
        }
        await db.collection('announcements').doc(id).update({
          data: {
            targetCount: toOpenids.length,
            notifySent: true,
            notifySentAt: db.serverDate(),
            notifySentCount: sent
          }
        })
      }
    }
    return { code: 0, msg: '公告已发布' }
  }

  async function revokeAnnouncementWeb(data = {}) {
    const id = String(data.announcementId || '').trim()
    if (!id) return { code: -1, msg: '缺少公告ID' }
    await db.collection('announcements').doc(id).update({
      data: { status: 'revoked', updateTime: db.serverDate() }
    })
    return { code: 0, msg: '公告已撤回' }
  }

  async function fetchActivityZoneConfigDocWeb() {
    try {
      const res = await db.collection('activity_zone').doc('config').get()
      return (res && res.data) || null
    } catch (e) {
      if (e.message && e.message.includes('not exist')) return null
      throw e
    }
  }

  function sanitizeActivityZoneConfigForSet(doc) {
    const clean = {}
    Object.keys(doc || {}).forEach((key) => {
      const val = doc[key]
      if (val === undefined) return
      if (val && typeof val === 'object' && typeof val.operator === 'string') return
      clean[key] = val
    })
    return clean
  }

  async function persistActivityZoneConfigWeb(doc) {
    const clean = sanitizeActivityZoneConfigForSet(doc)
    try {
      await db.collection('activity_zone').doc('config').set({ data: clean })
    } catch (e) {
      if (e.message && e.message.includes('not exist')) {
        await db.collection('activity_zone').add({ data: { _id: 'config', ...clean } })
      } else throw e
    }
  }

  async function convertActivityPostsToNormalWeb(zoneDoc) {
    const roundId = String(zoneDoc.roundId || '')
    const campusIds = activityZoneCore.normalizeCampusIds(zoneDoc.campusIds)
    const whereCond = activityZoneCore.buildFinalizePostWhere(campusIds, roundId, _)
    const BATCH = 100
    let converted = 0
    let rounds = 0
    while (rounds < 200) {
      rounds += 1
      const res = await db.collection('posts').where(whereCond).limit(BATCH).get()
      const rows = res.data || []
      if (!rows.length) break
      await Promise.all(
        rows.map((row) =>
          db.collection('posts').doc(row._id).update({
            data: {
              category: '校园生活',
              inActivityZone: false,
              activityRoundId: _.remove(),
              activityEndedAt: db.serverDate()
            }
          })
        )
      )
      converted += rows.length
      if (rows.length < BATCH) break
    }
    return converted
  }

  async function finalizeActivityZoneRoundWeb(reason = 'manual') {
    const zoneDoc = await fetchActivityZoneConfigDocWeb()
    if (!zoneDoc || !zoneDoc.enabled) {
      return { code: -1, msg: '当前没有进行中的活动' }
    }
    const converted = await convertActivityPostsToNormalWeb(zoneDoc)
    const nextRoundId = String(Date.now())
    const nextDoc = {
      enabled: false,
      campusIds: Array.isArray(zoneDoc.campusIds) ? zoneDoc.campusIds : ['all'],
      slides: [],
      roundId: nextRoundId,
      lastEndedAt: db.serverDate(),
      lastEndedBy: 'web-admin',
      lastEndReason: reason,
      lastConvertedCount: converted,
      updateTime: db.serverDate(),
      updatedByOpenid: 'web-admin'
    }
    await persistActivityZoneConfigWeb(nextDoc)
    return {
      code: 0,
      msg: `本期活动已结束，${converted} 篇帖子已转为普通帖，专区已清空`,
      data: { converted, roundId: nextRoundId }
    }
  }

  async function maybeAutoFinalizeActivityZoneWeb(zoneDoc) {
    if (!zoneDoc || !zoneDoc.enabled) return null
    const endAt = activityZoneCore.parseActivityEndAt(zoneDoc.endAt)
    if (!endAt || endAt.getTime() > Date.now()) return null
    try {
      return await finalizeActivityZoneRoundWeb('auto_endAt')
    } catch (e) {
      console.error('[maybeAutoFinalizeActivityZoneWeb]', e)
      return { code: -1, msg: (e && e.message) || '自动结束活动失败' }
    }
  }

  async function getActivityZoneAdminWeb() {
    let doc = await fetchActivityZoneConfigDocWeb()
    await maybeAutoFinalizeActivityZoneWeb(doc)
    doc = await fetchActivityZoneConfigDocWeb()
    const base = activityZoneCore.adminDataFromDoc(doc)
    let activePostCount = 0
    if (base.activityRunning && base.roundId) {
      try {
        const whereCond = activityZoneCore.buildFinalizePostWhere(base.campusIds, base.roundId, _)
        const cnt = await db.collection('posts').where(whereCond).count()
        activePostCount = cnt.total || 0
      } catch (e) {
        console.warn('[getActivityZoneAdminWeb] count:', e && e.message)
      }
    }
    return { code: 0, data: { ...base, activePostCount } }
  }

  async function saveActivityZoneWeb(data = {}) {
    const prev = await fetchActivityZoneConfigDocWeb()
    const enabled = !!data.enabled
    const campusIds = normalizeCampusIds(data.campusIds)
    const slidesIn = Array.isArray(data.slides) ? data.slides : []
    if (slidesIn.length > 10) return { code: -1, msg: '轮播最多 10 张' }
    const slides = slidesIn
      .map((s) => ({
        image: String(s.image || '').trim(),
        title: String(s.title || '').trim().slice(0, 80),
        subtitle: String(s.subtitle || '').trim().slice(0, 120),
        content: String(s.content || '').trim().slice(0, 2000),
        activityTime: String(s.activityTime || '').trim().slice(0, 300),
        participation: String(s.participation || '').trim().slice(0, 800),
        rewards: String(s.rewards || '').trim().slice(0, 800),
        ctaText: String(s.ctaText || '').trim().slice(0, 16) || '了解详情'
      }))
      .filter((s) => s.image || s.title)

    const startNewRound = !!data.startNewRound
    const prevRunning = activityZoneCore.isActivityZoneRunning(prev)
    let roundId = prev && prev.roundId ? String(prev.roundId) : ''
    if (startNewRound || (enabled && !prevRunning)) {
      roundId = String(Date.now())
    } else if (enabled && !roundId) {
      roundId = String(Date.now())
    }

    let endAt = activityZoneCore.parseActivityEndAt(data.endAt)
    if (data.endAt === null || data.endAt === '') endAt = null

    const doc = {
      enabled,
      campusIds,
      slides,
      roundId,
      updateTime: db.serverDate(),
      updatedByOpenid: 'web-admin'
    }
    if (endAt) doc.endAt = endAt
    if (prev && prev.lastEndedAt) doc.lastEndedAt = prev.lastEndedAt

    await persistActivityZoneConfigWeb(doc)
    if (enabled && endAt && endAt.getTime() <= Date.now()) {
      return finalizeActivityZoneRoundWeb('save_past_endAt')
    }
    return { code: 0, msg: '已保存活动专区配置', data: { roundId, endAt: endAt ? endAt.toISOString() : null } }
  }

  async function endActivityZoneWeb() {
    return finalizeActivityZoneRoundWeb('manual')
  }

  return async function dispatch(action, data = {}) {
    try {
      switch (action) {
        case 'getStats':
          return await getStats()
        case 'getAnalyticsDashboard':
          return await analyticsApi.getAnalyticsDashboard(data)
        case 'getAnalyticsHistory':
          return await analyticsApi.getAnalyticsHistory(data)
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
          return await deleteCommentAdmin(data.commentId, 'post')
        case 'deleteCommentAdmin':
          return await deleteCommentAdmin(data.commentId, data.scope || 'post')

        case 'getAdminAnnouncementList':
          return await getAdminAnnouncementList(data)
        case 'createAnnouncement':
          return await createAnnouncementWeb(data)
        case 'publishAnnouncement':
          return await publishAnnouncementWeb(data)
        case 'revokeAnnouncement':
          return await revokeAnnouncementWeb(data)
        case 'getActivityZoneAdmin':
          return await getActivityZoneAdminWeb()
        case 'saveActivityZone':
          return await saveActivityZoneWeb(data)
        case 'endActivityZone':
          return await endActivityZoneWeb()

        case 'getEmployeeReferralStats':
          return await employeeReferral.getEmployeeReferralStats()
        case 'generateEmployeeQrcode':
          return await employeeReferral.generateEmployeeQrcode(data)
        case 'saveEmployee':
          return await employeeReferral.saveEmployee(data)

        default:
          return { code: -1, msg: '未知操作: ' + action }
      }
    } catch (err) {
      console.error(`[webAdmin] ${action}`, err)
      return { code: -1, msg: err.message || '操作失败' }
    }
  }
}
