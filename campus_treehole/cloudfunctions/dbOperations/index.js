// 数据库操作云函数 - 统一处理所有 CRUD 操作
// 包含：帖子、评论、点赞、收藏、关注、私信、举报、用户管理
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const createWebAdminDispatch = require('./webAdminHandlers')
const webAdminDispatch = createWebAdminDispatch(db, _)

// ========== 工具函数 ==========

// 验证调用者身份
function getOpenid(context) {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) throw new Error('未授权访问')
  return OPENID
}

// 检查管理员权限
async function checkAdmin(openid) {
  const res = await db.collection('users').where({ _openid: openid, role: 'admin', status: 'active' }).get()
  return res.data.length > 0
}

// 频率限制检查
async function checkRateLimit(openid, collection, minutes, maxCount) {
  const timeAgo = new Date(Date.now() - minutes * 60 * 1000)
  try {
    const res = await db.collection(collection).where({
      _openid: openid,
      createTime: _.gte(timeAgo)
    }).count()
    return res.total < maxCount
  } catch (err) {
    console.warn('频率检查表异常，放行第一笔写入:', err)
    return true
  }
}

// 获取用户状态并校验封禁/禁言/点赞限制
async function getUserForAction(openid, { requireActive = true } = {}) {
  const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
  const user = res.data[0]
  if (!user) throw new Error('用户不存在')

  // 封禁到期自动解封
  if (user.status === 'banned' && user.banExpiry) {
    const now = Date.now()
    const expire = new Date(user.banExpiry).getTime()
    if (!Number.isNaN(expire) && now > expire) {
      await db.collection('users').doc(user._id).update({
        data: { status: 'active', banTime: null, banExpiry: null }
      })
      user.status = 'active'
      user.banTime = null
      user.banExpiry = null
    }
  }

  if (requireActive && user.status === 'banned') {
    throw new Error('账号已被封禁')
  }

  return user
}

// 违禁词检查（服务端）
function checkBannedWords(text) {
  if (!text || !text.trim()) return { pass: true, word: null }
  const bannedWords = [
    '颠覆政权', '分裂国家', '推翻政府', '反党', '反共',
    '独立运动', '藏独', '疆独', '台独', '港独',
    '法轮功', '邪教', '反华势力', '境外势力',
    '颜色革命', '暴动', '叛乱', '政变', '辱华', '卖国',
    '色情', '淫秽', '裸体', '性交易', '卖淫', '嫖娼',
    '援交', '约炮', '一夜情', '成人视频', '黄片',
    '情色', '性服务', '招嫖', '楼凤',
    '赌博', '网赌', '赌场', '赌球', '赌马',
    '博彩', '彩票代购', '赌资', '庄家', '下注',
    '百家乐', '老虎机', '赌钱', '押注', '赔率盘口',
    '毒品', '吸毒', '贩毒', '制毒', '冰毒',
    '海洛因', '大麻', '可卡因', '摇头丸', 'K粉',
    '麻古', '笑气', '迷幻药', '致幻剂',
    '杀人', '抢劫', '绑架', '爆炸', '恐怖袭击',
    '枪支买卖', '贩卖人口', '黑社会', '打砸抢', '非法集会',
    '诈骗', '传销', '洗钱', '非法集资', '高利贷',
    '枪手代考', '买卖答案', '作弊器',
    '假证', '办证', '刻章',
    '翻墙', 'VPN代理', '科学上网',
    '人肉搜索', '网络暴力', '网暴',
    '死亡威胁', '跳楼', '自杀方法',
    '种族歧视', '性别歧视', '地域歧视'
  ]
  const content = text.toLowerCase()
  for (const word of bannedWords) {
    if (content.includes(word.toLowerCase())) {
      return { pass: false, word }
    }
  }
  return { pass: true, word: null }
}

// 微信官方文本安全检测
async function wxTextCheck(openid, text) {
  try {
    const result = await cloud.openapi.security.msgSecCheck({
      openid: openid,
      scene: 2,
      version: 2,
      content: text
    })
    if (result.result && result.result.suggest === 'risky') {
      return { pass: false, word: '(微信安全检测不通过)' }
    }
    return { pass: true, word: null }
  } catch (err) {
    console.warn('微信文本安全检测异常，降级使用本地检测:', err)
    return checkBannedWords(text)
  }
}

// ========== 主入口 ==========
exports.main = async (event, context) => {
  const { action, data = {} } = event

  if (action === 'getTempFileUrls') {
    const fileList = Array.isArray(data.fileList) ? data.fileList : []
    const safeList = fileList.filter(f => typeof f === 'string' && f.startsWith('cloud://'))
    if (!safeList.length) return { code: 0, data: [] }
    const res = await cloud.getTempFileURL({ fileList: safeList })
    return { code: 0, data: res.fileList }
  }

  // H5 管理后台：Web 匿名用户常无法 invoke adminPanel（PERMISSION_DENIED）；云函数互调也可能失败。
  // 在校验 ADMIN_WEB_SECRET 后，于本进程内执行与 adminPanel 相同的数据库逻辑（webAdminHandlers）。
  if (action === 'callAdminPanel') {
    const envSecret = process.env.ADMIN_WEB_SECRET
    const ws = data && data.webSecret
    if (!envSecret || !ws || String(ws) !== String(envSecret)) {
      return { code: -403, msg: '无效的 Web 管理密钥（请在云函数 dbOperations 配置环境变量 ADMIN_WEB_SECRET，与 admin.html 一致）' }
    }
    const adminAction = data.adminAction
    const adminData = data.adminData || {}
    if (!adminAction || typeof adminAction !== 'string') {
      return { code: -1, msg: '缺少 adminAction' }
    }
    return await webAdminDispatch(adminAction, adminData)
  }

  if (action === 'getMarketGoods') {
    return await getMarketGoods(data)
  }

  try {
    const openid = getOpenid(context)
    switch (action) {
      // ===== 帖子相关 =====
      case 'getPosts':
        return await getPosts(openid, data)
      case 'getPostById':
        return await getPostById(data.postId, openid)
      case 'addPost':
        return await addPost(openid, data)
      case 'updatePost':
        return await updatePost(openid, data)
      case 'deletePost':
        return await deletePost(openid, data.postId)
      case 'toggleTopPost':
        return await toggleTopPost(openid, data.postId)

      // ===== 评论相关 =====
      case 'getComments':
        return await getComments(data.postId, data.sortBy)
      case 'addComment':
        return await addComment(openid, data)

      // ===== 点赞相关 =====
      case 'toggleLikePost':
        return await toggleLikePost(openid, data.postId)
      case 'toggleLikeComment':
        return await toggleLikeComment(openid, data.commentId)

      // ===== 收藏相关 =====
      case 'toggleFavorPost':
        return await toggleFavorPost(openid, data.postId)
      case 'getFavoredPosts':
        return await getFavoredPosts(openid, data)
      case 'getLikedPosts':
        return await getLikedPosts(openid, data)

      // ===== 关注相关 =====
      case 'toggleFollow':
        return await toggleFollow(openid, data.targetOpenid)
      case 'getFollowingList':
        return await getFollowingList(openid, data)
      case 'getFollowerList':
        return await getFollowerList(openid, data)

      // ===== 用户相关 =====
      case 'getUserInfo':
        return await getUserInfo(openid, data.targetOpenid || openid)
      case 'updateProfile':
        return await updateProfile(openid, data)
      case 'searchUsers':
        return await searchUsers(openid, data.keyword)
      case 'getMyPosts':
        return await getMyPosts(openid, data)
      case 'getUserPosts':
        return await getUserPosts(openid, data.targetOpenid, data)
      case 'getUserMarketGoods':
        return await getUserMarketGoods(data.targetOpenid, data)
      case 'agreePrivacy':
        return await agreePrivacy(openid)
      case 'deleteAccount':
        return await deleteAccount(openid)

      // ===== 私信相关 =====
      case 'getConversations':
        return await getConversations(openid)
      case 'getUnreadMessageCount':
        return await getUnreadMessageCount(openid)
      case 'getMessages':
        return await getMessages(openid, data.targetOpenid, data.sinceTime)
      case 'sendMessage':
        return await sendMessage(openid, data)
      case 'getInteractionNotifications':
        return await getInteractionNotifications(openid, data)
      case 'markInteractionNotificationsRead':
        return await markInteractionNotificationsRead(openid, data)
      case 'getUnreadInteractionCount':
        return await getUnreadInteractionCount(openid)

      // ===== 举报相关 =====
      case 'reportContent':
        return await reportContent(openid, data)

      // ===== 集市相关 =====
      case 'getMarketGoodsById':
        return await getMarketGoodsById(data.goodsId, openid)
      case 'addMarketGoods':
        return await addMarketGoods(openid, data)
      case 'toggleFavorGoods':
        return await toggleFavorGoods(openid, data.goodsId)
      case 'wantMarketGoods':
        return await wantMarketGoods(openid, data.goodsId)
      case 'deleteMarketGoods':
        return await deleteMarketGoods(openid, data.goodsId)
      case 'getMarketComments':
        return await getMarketComments(data.goodsId)
      case 'addMarketComment':
        return await addMarketComment(openid, data)

      // ===== 管理员操作 =====
      case 'getAdminMarketGoods':
        if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
        return await getAdminMarketGoods(data)
      case 'banUser':
        return await banUser(openid, data.targetOpenid)

      default:
        return { code: -1, msg: '未知操作: ' + action }
    }
  } catch (err) {
    console.error(`操作[${action}]失败:`, err)
    return { code: -1, msg: err.message || '操作失败' }
  }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimSnippet(text, max = 32) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

async function getUsersByOpenids(openids, extraWhere = {}) {
  const normalizedIds = Array.from(new Set((openids || []).filter(Boolean)))
  if (normalizedIds.length === 0) return []

  const users = []
  for (let i = 0; i < normalizedIds.length; i += 20) {
    const chunk = normalizedIds.slice(i, i + 20)
    const where = { ...extraWhere, _openid: _.in(chunk) }
    const res = await db.collection('users').where(where).get()
    users.push(...(res.data || []))
  }
  const orderMap = new Map(normalizedIds.map((id, index) => [id, index]))
  return users.sort((a, b) => (orderMap.get(a._openid) || 0) - (orderMap.get(b._openid) || 0))
}

async function getPostsByIds(postIds, extraWhere = {}) {
  const normalizedIds = Array.from(new Set((postIds || []).filter(Boolean)))
  if (normalizedIds.length === 0) return []

  const posts = []
  for (let i = 0; i < normalizedIds.length; i += 20) {
    const chunk = normalizedIds.slice(i, i + 20)
    const where = { ...extraWhere, _id: _.in(chunk) }
    const res = await db.collection('posts').where(where).get()
    posts.push(...(res.data || []))
  }

  const orderMap = new Map(normalizedIds.map((id, index) => [id, index]))
  return posts.sort((a, b) => (orderMap.get(a._id) || 0) - (orderMap.get(b._id) || 0))
}

async function getUserSnapshot(openid) {
  if (!openid) return {}
  const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
  const user = res.data[0] || {}
  return {
    openid,
    nickName: user.nickName || '用户',
    avatarUrl: user.avatarUrl || '/images/avatar_default.png',
    numericId: user.numericId || ''
  }
}

async function addNotification(notification) {
  const toOpenid = notification.toOpenid
  const fromOpenid = notification.fromOpenid
  if (!toOpenid || !fromOpenid || toOpenid === fromOpenid) {
    return null
  }

  const actor = await getUserSnapshot(fromOpenid)
  const doc = {
    _openid: fromOpenid,
    fromOpenid,
    toOpenid,
    actorNickname: actor.nickName,
    actorAvatar: actor.avatarUrl,
    actorNumericId: actor.numericId,
    type: notification.type || 'interaction',
    targetType: notification.targetType || '',
    targetId: notification.targetId || '',
    postId: notification.postId || '',
    goodsId: notification.goodsId || '',
    commentId: notification.commentId || '',
    content: notification.content || '',
    itemTitle: notification.itemTitle || '',
    itemImage: notification.itemImage || '',
    itemPrice: notification.itemPrice !== undefined ? notification.itemPrice : '',
    isRead: false,
    status: 'active',
    createTime: db.serverDate()
  }

  try {
    const addRes = await db.collection('notifications').add({ data: doc })
    doc._id = addRes._id
    return doc
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      await db.createCollection('notifications').catch(() => {})
      const addRes = await db.collection('notifications').add({ data: doc })
      doc._id = addRes._id
      return doc
    }
    throw err
  }
}

async function attachPostEngagement(openid, posts) {
  if (!posts.length || !openid) return posts
  const ids = posts.map((p) => p._id).filter(Boolean)
  const likedSet = new Set()
  const favorSet = new Set()
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20)
    const [likesRes, favorsRes] = await Promise.all([
      db.collection('likes').where({
        _openid: openid,
        targetType: 'post',
        targetId: _.in(chunk)
      }).get(),
      db.collection('favors').where({
        _openid: openid,
        postId: _.in(chunk)
      }).get()
    ])
    likesRes.data.forEach((l) => likedSet.add(l.targetId))
    favorsRes.data.forEach((f) => favorSet.add(f.postId))
  }
  return posts.map((p) => ({
    ...p,
    isLiked: likedSet.has(p._id),
    isFavored: favorSet.has(p._id)
  }))
}

// ========== 帖子操作 ==========

/** 匿名帖对外展示：非管理员一律不返回真实昵称/头像/学院（避免历史脏数据或 cloud 头像泄露） */
const ANONYMOUS_DISPLAY = {
  nickname: '匿名',
  avatar: '/images/avatar_default.png',
  college: '匿名'
}

/** 匿名帖：非管理员统一匿名展示；仅作者本人保留 _openid（任何人点头像都进不了匿名发帖人主页） */
function sanitizePostForClient(post, viewerOpenid, isAdmin) {
  if (!post || typeof post !== 'object') return post
  const authorOpenid = post._openid
  const isOwner = !!(authorOpenid && viewerOpenid && authorOpenid === viewerOpenid)

  let next = { ...post }

  if (post.isAnonymous === true && !isAdmin) {
    next = {
      ...next,
      nickname: ANONYMOUS_DISPLAY.nickname,
      avatar: ANONYMOUS_DISPLAY.avatar,
      college: ANONYMOUS_DISPLAY.college
    }
  }

  if (post.isAnonymous === true && !isOwner) {
    next = { ...next, _openid: '', userId: '' }
  }

  return next
}

async function sanitizePostsForClient(posts, viewerOpenid) {
  if (!posts || !posts.length) return posts
  const isAdmin = viewerOpenid ? await checkAdmin(viewerOpenid) : false
  return posts.map((p) => sanitizePostForClient(p, viewerOpenid, isAdmin))
}

function sortPostsByTimeDesc(arr) {
  return arr.sort((a, b) => {
    const ta = a.createTime ? new Date(a.createTime).getTime() : 0
    const tb = b.createTime ? new Date(b.createTime).getTime() : 0
    return tb - ta
  })
}

/** 关注数 >20 时 _.in 需分批查询再合并（微信端单次 in 最多 20 条） */
async function getPostsFollowMultiChunk(targetIds, { category, keyword, page, pageSize }) {
  const parts = [{ status: 'active' }]
  if (category && category !== '全部') parts.push({ category })
  if (keyword && keyword.trim()) {
    const regex = db.RegExp({ regexp: escapeRegExp(keyword.trim()), options: 'i' })
    parts.push(_.or([
      { content: regex },
      { title: regex },
      { nickname: regex }
    ]))
  }
  const base = parts.length === 1 ? parts[0] : _.and(parts)

  const chunks = []
  for (let i = 0; i < targetIds.length; i += 20) {
    chunks.push(targetIds.slice(i, i + 20))
  }

  const perChunkLimit = 100
  const collected = []
  for (const chunk of chunks) {
    const cond = _.and([base, { _openid: _.in(chunk) }])
    const r = await db.collection('posts').where(cond).orderBy('createTime', 'desc').limit(perChunkLimit).get()
    collected.push(...r.data)
  }
  const seen = new Set()
  const uniq = []
  for (const p of collected) {
    if (seen.has(p._id)) continue
    seen.add(p._id)
    uniq.push(p)
  }
  sortPostsByTimeDesc(uniq)
  const tops = uniq.filter((p) => p.isTop === true)
  const normals = uniq.filter((p) => p.isTop !== true)
  if (page === 1) {
    return [...tops, ...normals.slice(0, pageSize)]
  }
  const skip = (page - 1) * pageSize
  return normals.slice(skip, skip + pageSize)
}

async function getFollowTargetOpenids(openid, maxFollowCount = 2000) {
  const pageSize = 100
  const targetIds = []
  const seen = new Set()
  for (let skip = 0; skip < maxFollowCount; skip += pageSize) {
    const res = await db.collection('follows').where({ _openid: openid })
      .skip(skip)
      .limit(pageSize)
      .get()
    const rows = res.data || []
    if (rows.length === 0) break

    for (const row of rows) {
      const target = row && row.targetOpenid
      if (!target || seen.has(target)) continue
      seen.add(target)
      targetIds.push(target)
    }
    if (rows.length < pageSize) break
  }
  return targetIds
}

async function getPosts(openid, { category, keyword, page = 1, pageSize = 20, feedType = 'discover' }) {
  let followTargetIds = null
  if (feedType === 'follow') {
    followTargetIds = await getFollowTargetOpenids(openid)
    if (followTargetIds.length === 0) {
      return { code: 0, data: [] }
    }
    if (followTargetIds.length > 20) {
      const merged = await getPostsFollowMultiChunk(followTargetIds, { category, keyword, page, pageSize })
      const withEng = await attachPostEngagement(openid, merged)
      const data = await sanitizePostsForClient(withEng, openid)
      return { code: 0, data }
    }
  }

  const parts = [{ status: 'active' }]

  if (category && category !== '全部') {
    parts.push({ category })
  }

  if (feedType === 'follow') {
    parts.push({ _openid: _.in(followTargetIds) })
  }

  if (feedType === 'campus') {
    const userRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const user = userRes.data[0] || {}
    if (!user.college) {
      return { code: 0, data: [] }
    }
    parts.push({ college: user.college })
  }

  if (keyword && keyword.trim()) {
    const regex = db.RegExp({
      regexp: escapeRegExp(keyword.trim()),
      options: 'i'
    })
    parts.push(_.or([
      { content: regex },
      { title: regex },
      { nickname: regex }
    ]))
  }

  const baseCondition = parts.length === 1 ? parts[0] : _.and(parts)

  const topPosts = page === 1
    ? await db.collection('posts').where(_.and([baseCondition, { isTop: true }])).orderBy('createTime', 'desc').get()
    : { data: [] }

  const normalPosts = await db.collection('posts').where(_.and([baseCondition, { isTop: _.neq(true) }]))
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  let allPosts = [...topPosts.data, ...normalPosts.data]
  allPosts = await attachPostEngagement(openid, allPosts)
  allPosts = await sanitizePostsForClient(allPosts, openid)

  return { code: 0, data: allPosts }
}

async function getPostById(postId, openid) {
  let postRes
  try {
    postRes = await db.collection('posts').doc(postId).get()
  } catch (err) {
    return { code: -1, msg: '帖子不存在或已删除' }
  }
  const post = postRes && postRes.data
  if (!post || !post._id || post.status !== 'active') {
    return { code: -1, msg: '帖子不存在或已删除' }
  }

  // 查询当前用户是否点赞和收藏
  const [likeRes, favorRes, isAdmin] = await Promise.all([
    db.collection('likes').where({ _openid: openid, targetId: postId, targetType: 'post' }).count(),
    db.collection('favors').where({ _openid: openid, postId: postId }).count(),
    checkAdmin(openid)
  ])

  const data = sanitizePostForClient(
    {
      ...post,
      isLiked: likeRes.total > 0,
      isFavored: favorRes.total > 0
    },
    openid,
    isAdmin
  )

  return { code: 0, data }
}

async function addPost(openid, data) {
  const user = await getUserForAction(openid, { requireActive: true })
  const isAdmin = await checkAdmin(openid)
  // 频率限制：5分钟内最多3篇
  const canPost = await checkRateLimit(openid, 'posts', 5, 3)
  if (!canPost) return { code: -1, msg: '发布太频繁，请稍后再试' }

  // 服务端内容审核
  const textToCheck = (data.title || '') + ' ' + (data.content || '')
  const localCheck = checkBannedWords(textToCheck)
  if (!localCheck.pass) return { code: -2, msg: `内容包含违规词"${localCheck.word}"`, word: localCheck.word }

  // 微信官方文本安全检测
  const wxCheck = await wxTextCheck(openid, textToCheck)
  if (!wxCheck.pass) return { code: -2, msg: '内容未通过安全审核' }

  const videos = Array.isArray(data.videos) ? data.videos : []
  const thumbImages = Array.isArray(data.thumbImages) ? data.thumbImages : []
  if (videos.length > 0 && !isAdmin) {
    return { code: -1, msg: '仅管理员可发布视频' }
  }

  const newPost = {
    _openid: openid,
    nickname: user.nickName || '未知用户',
    avatar: user.avatarUrl || '/images/avatar_default.png',
    college: user.college || '未设置',
    userId: openid,
    category: data.category || '校园生活',
    title: data.title || '',
    content: data.content,
    images: data.images || [],
    thumbImages,
    videos,
    image: data.images && data.images.length > 0 ? data.images[0] : '',
    likes: 0,
    comments: 0,
    isAnonymous: false,
    location: data.location || '',
    isTop: false,
    status: videos.length > 0 ? 'pending' : 'active',
    createTime: db.serverDate()
  }

  const addRes = await db.collection('posts').add({ data: newPost })

  // 更新用户发帖数
  await db.collection('users').where({ _openid: openid }).update({
    data: { postCount: _.inc(1) }
  })

  return { code: 0, msg: '发布成功', data: { _id: addRes._id } }
}

async function updatePost(openid, data) {
  const user = await getUserForAction(openid, { requireActive: true })
  const postId = data.postId
  const postRes = await db.collection('posts').doc(postId).get()
  const post = postRes.data

  if (!post || !post._id || post.status === 'deleted') {
    return { code: -1, msg: '帖子不存在或已删除' }
  }

  const isAdmin = await checkAdmin(openid)
  if (!isAdmin && post._openid !== openid) {
    return { code: -1, msg: '无权编辑该帖子' }
  }

  const title = String(data.title || '').trim()
  const content = String(data.content || '').trim()
  if (!content) {
    return { code: -1, msg: '正文不能为空' }
  }

  const textToCheck = `${title} ${content}`.trim()
  const localCheck = checkBannedWords(textToCheck)
  if (!localCheck.pass) return { code: -2, msg: `内容包含违规词"${localCheck.word}"`, word: localCheck.word }

  const wxCheck = await wxTextCheck(openid, textToCheck)
  if (!wxCheck.pass) return { code: -2, msg: '内容未通过安全审核' }

  const images = Array.isArray(data.images) ? data.images : []
  const thumbImages = Array.isArray(data.thumbImages) ? data.thumbImages : []
  const videos = Array.isArray(data.videos) ? data.videos : []
  if (videos.length > 0 && !isAdmin) {
    return { code: -1, msg: '仅管理员可发布视频' }
  }
  const previousVideos = Array.isArray(post.videos) ? post.videos : []
  const videosChanged = JSON.stringify(previousVideos) !== JSON.stringify(videos)

  const updateData = {
    title,
    content,
    category: data.category || post.category || '校园生活',
    images,
    thumbImages,
    videos,
    image: images.length > 0 ? images[0] : '',
    isAnonymous: false,
    location: data.location || '',
    nickname: user.nickName || post.nickname || '未知用户',
    avatar: user.avatarUrl || post.avatar || '/images/avatar_default.png',
    college: user.college || post.college || '未设置',
    updateTime: db.serverDate()
  }

  if (videosChanged) {
    updateData.status = videos.length > 0 ? 'pending' : 'active'
  }

  await db.collection('posts').doc(postId).update({ data: updateData })
  return { code: 0, msg: '更新成功' }
}

async function deletePost(openid, postId) {
  await getUserForAction(openid, { requireActive: true })
  // 检查是否是管理员或帖子作者
  const isAdmin = await checkAdmin(openid)
  let postRes
  try {
    postRes = await db.collection('posts').doc(postId).get()
  } catch (err) {
    return { code: -1, msg: '帖子不存在' }
  }
  const post = postRes && postRes.data
  if (!post || !post._id) {
    return { code: -1, msg: '帖子不存在' }
  }

  if (!isAdmin && post._openid !== openid) {
    return { code: -1, msg: '无权删除该帖子' }
  }

  await db.collection('posts').doc(postId).update({
    data: { status: 'deleted' }
  })

  return { code: 0, msg: '删除成功' }
}

async function toggleTopPost(openid, postId) {
  await getUserForAction(openid, { requireActive: true })
  const isAdmin = await checkAdmin(openid)
  if (!isAdmin) return { code: -1, msg: '无管理员权限' }

  let postRes
  try {
    postRes = await db.collection('posts').doc(postId).get()
  } catch (err) {
    return { code: -1, msg: '帖子不存在' }
  }
  const post = postRes && postRes.data
  if (!post || !post._id) {
    return { code: -1, msg: '帖子不存在' }
  }
  const newIsTop = !post.isTop

  await db.collection('posts').doc(postId).update({
    data: { isTop: newIsTop }
  })

  return { code: 0, data: { isTop: newIsTop } }
}

// ========== 评论操作 ==========

async function getComments(postId, sortBy = 'hot') {
  let query = db.collection('comments').where({ postId, status: 'active' })

  if (sortBy === 'hot') {
    query = query.orderBy('likes', 'desc')
  } else {
    query = query.orderBy('createTime', 'desc')
  }

  const res = await query.limit(100).get()
  return { code: 0, data: res.data }
}

async function addComment(openid, data) {
  const actor = await getUserForAction(openid, { requireActive: true })
  if (actor.isMuted) return { code: -1, msg: '您已被禁言，无法评论' }

  // 频率限制：1分钟内最多5条评论
  const canComment = await checkRateLimit(openid, 'comments', 1, 5)
  if (!canComment) return { code: -1, msg: '评论太频繁，请稍后再试' }

  // 内容审核
  const localCheck = checkBannedWords(data.content)
  if (!localCheck.pass) return { code: -2, msg: `评论包含违规词"${localCheck.word}"`, word: localCheck.word }

  const wxCheck = await wxTextCheck(openid, data.content)
  if (!wxCheck.pass) return { code: -2, msg: '评论未通过安全审核' }

  const userRes = await db.collection('users').where({ _openid: openid }).get()
  const user = userRes.data[0] || {}

  const newComment = {
    _openid: openid,
    postId: data.postId,
    nickname: user.nickName || '未知用户',
    avatar: user.avatarUrl || '/images/avatar_default.png',
    content: data.content,
    likes: 0,
    replyTo: data.replyTo || null,
    status: 'active',
    createTime: db.serverDate()
  }

  const addRes = await db.collection('comments').add({ data: newComment })

  // 更新帖子评论数
  await db.collection('posts').doc(data.postId).update({
    data: { comments: _.inc(1) }
  })

  const postRes = await db.collection('posts').doc(data.postId).get().catch(() => ({ data: null }))
  const post = postRes.data || {}

  await addNotification({
    toOpenid: post._openid,
    fromOpenid: openid,
    type: 'post_comment',
    targetType: 'post',
    targetId: data.postId,
    postId: data.postId,
    commentId: addRes._id,
    content: trimSnippet(data.content),
    itemTitle: trimSnippet(post.title || post.content || '帖子')
  })

  if (data.replyTo && data.replyTo.commentId) {
    const parentCommentRes = await db.collection('comments').doc(data.replyTo.commentId).get().catch(() => ({ data: null }))
    const parentComment = parentCommentRes.data || {}
    await addNotification({
      toOpenid: parentComment._openid,
      fromOpenid: openid,
      type: 'comment_reply',
      targetType: 'post',
      targetId: data.postId,
      postId: data.postId,
      commentId: addRes._id,
      content: trimSnippet(data.content),
      itemTitle: trimSnippet(post.title || post.content || '帖子')
    })
  }

  newComment._id = addRes._id
  return { code: 0, msg: '评论成功', data: newComment }
}

// ========== 点赞操作 ==========

async function toggleLikePost(openid, postId) {
  const user = await getUserForAction(openid, { requireActive: true })
  if (user.isLikeBanned) return { code: -1, msg: '您已被限制点赞' }

  const existing = await db.collection('likes').where({
    _openid: openid, targetId: postId, targetType: 'post'
  }).get()

  if (existing.data.length > 0) {
    // 取消点赞
    await db.collection('likes').doc(existing.data[0]._id).remove()
    await db.collection('posts').doc(postId).update({ data: { likes: _.inc(-1) } })
    return { code: 0, data: { isLiked: false } }
  } else {
    // 点赞
    await db.collection('likes').add({
      data: { _openid: openid, targetId: postId, targetType: 'post', createTime: db.serverDate() }
    })
    await db.collection('posts').doc(postId).update({ data: { likes: _.inc(1) } })
    const postRes = await db.collection('posts').doc(postId).get().catch(() => ({ data: null }))
    const post = postRes.data || {}
    await addNotification({
      toOpenid: post._openid,
      fromOpenid: openid,
      type: 'post_like',
      targetType: 'post',
      targetId: postId,
      postId,
      itemTitle: trimSnippet(post.title || post.content || '帖子'),
      content: '赞了你的帖子'
    })
    return { code: 0, data: { isLiked: true } }
  }
}

async function toggleLikeComment(openid, commentId) {
  const user = await getUserForAction(openid, { requireActive: true })
  if (user.isLikeBanned) return { code: -1, msg: '您已被限制点赞' }

  const existing = await db.collection('likes').where({
    _openid: openid, targetId: commentId, targetType: 'comment'
  }).get()

  if (existing.data.length > 0) {
    await db.collection('likes').doc(existing.data[0]._id).remove()
    await db.collection('comments').doc(commentId).update({ data: { likes: _.inc(-1) } })
    return { code: 0, data: { isLiked: false } }
  } else {
    await db.collection('likes').add({
      data: { _openid: openid, targetId: commentId, targetType: 'comment', createTime: db.serverDate() }
    })
    await db.collection('comments').doc(commentId).update({ data: { likes: _.inc(1) } })
    const commentRes = await db.collection('comments').doc(commentId).get().catch(() => ({ data: null }))
    const comment = commentRes.data || {}
    await addNotification({
      toOpenid: comment._openid,
      fromOpenid: openid,
      type: 'comment_like',
      targetType: 'comment',
      targetId: commentId,
      postId: comment.postId || '',
      commentId,
      itemTitle: trimSnippet(comment.content || '评论'),
      content: '赞了你的评论'
    })
    return { code: 0, data: { isLiked: true } }
  }
}

// ========== 收藏操作 ==========

async function toggleFavorPost(openid, postId) {
  await getUserForAction(openid, { requireActive: true })
  const existing = await db.collection('favors').where({
    _openid: openid, postId
  }).get()

  if (existing.data.length > 0) {
    await db.collection('favors').doc(existing.data[0]._id).remove()
    return { code: 0, data: { isFavored: false } }
  } else {
    await db.collection('favors').add({
      data: { _openid: openid, postId, createTime: db.serverDate() }
    })
    const postRes = await db.collection('posts').doc(postId).get().catch(() => ({ data: null }))
    const post = postRes.data || {}
    await addNotification({
      toOpenid: post._openid,
      fromOpenid: openid,
      type: 'post_favorite',
      targetType: 'post',
      targetId: postId,
      postId,
      itemTitle: trimSnippet(post.title || post.content || '帖子'),
      content: '收藏了你的帖子'
    })
    return { code: 0, data: { isFavored: true } }
  }
}

async function getFavoredPosts(openid, { page = 1, pageSize = 20 }) {
  const favors = await db.collection('favors').where({ _openid: openid })
    .orderBy('createTime', 'desc').skip((page - 1) * pageSize).limit(pageSize).get()

  const postIds = favors.data.map(f => f.postId)
  if (postIds.length === 0) return { code: 0, data: [] }

  const posts = await getPostsByIds(postIds, { status: 'active' })
  const data = await sanitizePostsForClient(posts, openid)

  return { code: 0, data }
}

async function getLikedPosts(openid, { page = 1, pageSize = 20 }) {
  const likes = await db.collection('likes').where({ _openid: openid, targetType: 'post' })
    .orderBy('createTime', 'desc').skip((page - 1) * pageSize).limit(pageSize).get()

  const postIds = likes.data.map(item => item.targetId)
  if (postIds.length === 0) return { code: 0, data: [] }

  const posts = await getPostsByIds(postIds, { status: 'active' })
  const data = await sanitizePostsForClient(posts, openid)

  return { code: 0, data }
}

// ========== 关注操作 ==========

async function toggleFollow(openid, targetOpenid) {
  await getUserForAction(openid, { requireActive: true })
  const normalizedTarget = typeof targetOpenid === 'string' ? targetOpenid.trim() : ''
  if (!normalizedTarget) return { code: -1, msg: '目标用户参数缺失' }
  if (openid === normalizedTarget) return { code: -1, msg: '不能关注自己' }

  const targetRes = await db.collection('users').where({
    _openid: normalizedTarget,
    status: 'active'
  }).limit(1).get()
  if (targetRes.data.length === 0) {
    return { code: -1, msg: '目标用户不存在或已停用' }
  }

  const existing = await db.collection('follows').where({
    _openid: openid, targetOpenid: normalizedTarget
  }).get()

  if (existing.data.length > 0) {
    for (const row of existing.data) {
      await db.collection('follows').doc(row._id).remove()
    }
    return { code: 0, data: { isFollowing: false } }
  } else {
    await db.collection('follows').add({
      data: { _openid: openid, targetOpenid: normalizedTarget, createTime: db.serverDate() }
    })
    await addNotification({
      toOpenid: normalizedTarget,
      fromOpenid: openid,
      type: 'user_follow',
      targetType: 'user',
      targetId: normalizedTarget,
      content: '关注了你'
    })
    return { code: 0, data: { isFollowing: true } }
  }
}

async function getFollowingList(openid, { page = 1, pageSize = 50 }) {
  const follows = await db.collection('follows').where({ _openid: openid })
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize).get()

  const targetIds = follows.data.map(f => f.targetOpenid)
  if (targetIds.length === 0) return { code: 0, data: [], total: 0 }

  const users = await getUsersByOpenids(targetIds, { status: 'active' })

  return { code: 0, data: users, total: targetIds.length }
}

async function getFollowerList(openid, { page = 1, pageSize = 50 }) {
  const followers = await db.collection('follows').where({ targetOpenid: openid })
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize).get()

  const followerIds = followers.data.map(f => f._openid)
  if (followerIds.length === 0) return { code: 0, data: [], total: 0 }

  const users = await getUsersByOpenids(followerIds, { status: 'active' })

  return { code: 0, data: users, total: followerIds.length }
}

// ========== 用户操作 ==========

async function getUserInfo(openid, targetOpenid) {
  const res = await db.collection('users').where({ _openid: targetOpenid }).get()
  if (res.data.length === 0) return { code: -1, msg: '用户不存在' }

  const user = res.data[0]
  const [followingRes, followerRes] = await Promise.all([
    db.collection('follows').where({ _openid: targetOpenid }).count(),
    db.collection('follows').where({ targetOpenid }).count()
  ])

  let isFollowing = false
  if (openid && targetOpenid && openid !== targetOpenid) {
    const followRes = await db.collection('follows').where({ _openid: openid, targetOpenid }).count()
    isFollowing = followRes.total > 0
  }

  return {
    code: 0,
    data: {
      ...user,
      followingCount: followingRes.total,
      followerCount: followerRes.total,
      isFollowing
    }
  }
}

async function updateProfile(openid, data) {
  // 只允许更新指定字段
  const allowedFields = ['nickName', 'avatarUrl', 'college', 'bio', 'tags', 'coverImage', 'profileCompleted']
  const updateData = {}
  for (const key of allowedFields) {
    if (data[key] !== undefined) {
      updateData[key] = data[key]
    }
  }

  // 昵称违禁词检查
  if (updateData.nickName) {
    const check = checkBannedWords(updateData.nickName)
    if (!check.pass) return { code: -2, msg: `昵称包含违规词"${check.word}"` }
  }
  if (updateData.bio) {
    const check = checkBannedWords(updateData.bio)
    if (!check.pass) return { code: -2, msg: `简介包含违规词"${check.word}"` }
  }

  await db.collection('users').where({ _openid: openid }).update({ data: updateData })
  return { code: 0, msg: '资料更新成功' }
}

async function searchUsers(openid, keyword) {
  const baseFilters = [{ status: 'active' }]
  if (openid) {
    baseFilters.push({ _openid: _.neq(openid) })
  }

  if (!keyword || !keyword.trim()) {
    // 返回推荐用户
    const cond = baseFilters.length > 1 ? _.and(baseFilters) : baseFilters[0]
    const res = await db.collection('users').where(cond)
      .limit(20).get()
    return { code: 0, data: res.data }
  }

  // 搜索昵称或学院 (云数据库不支持模糊搜索，使用正则)
  const normalizedKeyword = keyword.trim()
  const regex = db.RegExp({ regexp: escapeRegExp(normalizedKeyword), options: 'i' })
  const cond = _.and([
    ...baseFilters,
    _.or([
      { nickName: regex },
      { college: regex },
      { numericId: regex }
    ])
  ])
  const res = await db.collection('users').where(cond).limit(20).get()

  return { code: 0, data: res.data }
}

async function getMyPosts(openid, { page = 1, pageSize = 20 }) {
  const res = await db.collection('posts').where({ _openid: openid, status: 'active' })
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize).get()
  const rows = await sanitizePostsForClient(res.data || [], openid)
  return { code: 0, data: rows }
}

async function getUserPosts(viewerOpenid, targetOpenid, { page = 1, pageSize = 20 }) {
  if (!targetOpenid) {
    return { code: -1, msg: '缺少用户标识' }
  }
  const viewingOther = !!(viewerOpenid && targetOpenid && viewerOpenid !== targetOpenid)
  const base = viewingOther
    ? _.and([
      { _openid: targetOpenid, status: 'active' },
      { isAnonymous: _.neq(true) }
    ])
    : { _openid: targetOpenid, status: 'active' }

  const res = await db.collection('posts').where(base)
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize).get()

  const rows = await sanitizePostsForClient(res.data || [], viewerOpenid)
  return { code: 0, data: rows }
}

/** 用户主页：TA 上架中的闲置商品 */
async function getUserMarketGoods(targetOpenid, { page = 1, pageSize = 15 }) {
  if (!targetOpenid) {
    return { code: -1, msg: '缺少用户标识' }
  }
  const where = { _openid: targetOpenid, status: 'active' }
  let total = 0
  try {
    const c = await db.collection('market_goods').where(where).count()
    total = c.total
  } catch (e) {
    console.warn('getUserMarketGoods count:', e)
  }
  const res = await db.collection('market_goods').where(where)
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()
  return { code: 0, data: res.data, total }
}

async function agreePrivacy(openid) {
  await db.collection('users').where({ _openid: openid }).update({
    data: { agreedPrivacy: true, agreeTime: db.serverDate() }
  })
  return { code: 0, msg: '已同意隐私协议' }
}

async function removeDocsByQuery(collectionName, condition) {
  let hasMore = true
  while (hasMore) {
    const res = await db.collection(collectionName).where(condition).limit(20).get()
    if (res.data.length === 0) {
      hasMore = false
      break
    }
    for (const doc of res.data) {
      await db.collection(collectionName).doc(doc._id).remove()
    }
  }
}

async function deleteAccount(openid) {
  await db.collection('users').where({ _openid: openid }).update({
    data: { status: 'deleted', deleteTime: db.serverDate() }
  })

  await db.collection('posts').where({ _openid: openid }).update({
    data: { status: 'deleted' }
  })
  await db.collection('comments').where({ _openid: openid }).update({
    data: { status: 'deleted' }
  })
  await db.collection('market_comments').where({ _openid: openid }).update({
    data: { status: 'deleted' }
  }).catch((err) => {
    if (!(err && err.message && err.message.includes('not exist'))) throw err
  })
  await db.collection('market_goods').where({ _openid: openid }).update({
    data: { status: 'deleted' }
  })

  const ownCollections = ['likes', 'favors', 'market_favors', 'market_wants', 'reports']
  for (const col of ownCollections) {
    await removeDocsByQuery(col, { _openid: openid })
  }

  await removeDocsByQuery('follows', _.or([
    { _openid: openid },
    { targetOpenid: openid }
  ]))

  await removeDocsByQuery('messages', _.or([
    { fromOpenid: openid },
    { toOpenid: openid }
  ]))

  await removeDocsByQuery('notifications', _.or([
    { fromOpenid: openid },
    { toOpenid: openid }
  ]))

  return { code: 0, msg: '账号已注销' }
}

// ========== 私信操作 ==========

async function getConversations(openid) {
  const allRes = await db.collection('messages')
    .where(_.or([
      { fromOpenid: openid },
      { toOpenid: openid }
    ]))
    .orderBy('createTime', 'desc')
    .limit(200)
    .get()
  const allMessages = allRes.data || []
  const convMap = {}
  const unreadMap = {}

  for (const msg of allMessages) {
    const otherOpenid = msg.fromOpenid === openid ? msg.toOpenid : msg.fromOpenid
    if (!convMap[otherOpenid] || msg.createTime > convMap[otherOpenid].createTime) {
      convMap[otherOpenid] = msg
    }
    if (msg.toOpenid === openid && !msg.isRead) {
      unreadMap[otherOpenid] = (unreadMap[otherOpenid] || 0) + 1
    }
  }

  const otherIds = Object.keys(convMap)
  if (otherIds.length === 0) return { code: 0, data: [] }

  const userMap = {}
  const users = await getUsersByOpenids(otherIds)
  for (const u of users) {
    userMap[u._openid] = u
  }

  const conversations = otherIds.map(otherId => {
    const msg = convMap[otherId]
    const user = userMap[otherId] || {}
    return {
      targetOpenid: otherId,
      targetNickName: user.nickName || '未知用户',
      targetAvatar: user.avatarUrl || '/images/avatar_default.png',
      lastMessage: formatConversationMessage(msg),
      lastTime: msg.createTime,
      unreadCount: unreadMap[otherId] || 0
    }
  }).sort((a, b) => {
    const timeA = a.lastTime instanceof Date ? a.lastTime.getTime() : (a.lastTime || 0)
    const timeB = b.lastTime instanceof Date ? b.lastTime.getTime() : (b.lastTime || 0)
    return timeB - timeA
  })

  return { code: 0, data: conversations }
}

async function getUnreadMessageCount(openid) {
  const res = await db.collection('messages')
    .where({ toOpenid: openid, isRead: false })
    .count()
  return {
    code: 0,
    data: {
      unreadCount: res.total || 0
    }
  }
}

async function getMessages(openid, targetOpenid, sinceTime) {
  const normalizedTarget = typeof targetOpenid === 'string' ? targetOpenid.trim() : ''
  if (!normalizedTarget) return { code: -1, msg: '缺少会话对象' }
  if (normalizedTarget === openid) return { code: -1, msg: '无效会话对象' }

  const sinceTs = Number(sinceTime)
  const hasSinceTime = Number.isFinite(sinceTs) && sinceTs > 0
  const sinceDate = hasSinceTime ? new Date(sinceTs) : null
  const buildSideCond = (fromOpenid, toOpenid) => {
    const side = { fromOpenid, toOpenid }
    if (!hasSinceTime) return side
    return _.and([side, { createTime: _.gt(sinceDate) }])
  }

  const latestRes = await db.collection('messages').where(_.or([
    buildSideCond(openid, normalizedTarget),
    buildSideCond(normalizedTarget, openid)
  ]))
    .orderBy('createTime', hasSinceTime ? 'asc' : 'desc')
    .limit(hasSinceTime ? 100 : 200)
    .get()
  const messages = hasSinceTime
    ? (latestRes.data || [])
    : (latestRes.data || []).slice().reverse()

  // 标记未读为已读
  const unread = messages.filter(m => m.toOpenid === openid && !m.isRead)
  if (unread.length > 0) {
    const readWhere = hasSinceTime
      ? { toOpenid: openid, fromOpenid: normalizedTarget, isRead: false, createTime: _.gt(sinceDate) }
      : { toOpenid: openid, fromOpenid: normalizedTarget, isRead: false }
    await db.collection('messages')
      .where(readWhere)
      .update({ data: { isRead: true } })
  }

  return { code: 0, data: messages }
}

async function sendMessage(openid, data = {}) {
  const user = await getUserForAction(openid, { requireActive: true })
  if (user.isMuted) return { code: -1, msg: '您已被禁言，无法发送消息' }

  const targetOpenid = typeof data.targetOpenid === 'string' ? data.targetOpenid.trim() : ''
  if (!targetOpenid) return { code: -1, msg: '接收方参数缺失' }
  if (targetOpenid === openid) return { code: -1, msg: '不能给自己发消息' }

  const targetRes = await db.collection('users').where({
    _openid: targetOpenid,
    status: 'active'
  }).limit(1).get()
  if (targetRes.data.length === 0) return { code: -1, msg: '对方账号不可用' }

  const type = typeof data.type === 'string' ? data.type : 'text'
  const allowedTypes = ['text', 'emoji', 'image', 'voice', 'post_share', 'goods_share']
  if (!allowedTypes.includes(type)) return { code: -1, msg: '不支持的消息类型' }

  const rawContent = typeof data.content === 'string' ? data.content : ''
  const trimmedContent = rawContent.trim()
  const normalizedFileId = typeof data.fileId === 'string' ? data.fileId.trim() : ''

  if ((type === 'text' || type === 'emoji') && !trimmedContent) {
    return { code: -1, msg: '消息内容不能为空' }
  }
  if ((type === 'image' || type === 'voice') && !normalizedFileId && !trimmedContent) {
    return { code: -1, msg: '消息文件缺失' }
  }

  let normalizedShareData = null
  if (type === 'post_share' || type === 'goods_share') {
    const shareData = data.shareData || {}
    const shareId = typeof shareData.id === 'string'
      ? shareData.id.trim()
      : String(shareData.id || '').trim()
    if (!shareId) return { code: -1, msg: '分享内容无效' }
    normalizedShareData = {
      id: shareId,
      title: typeof shareData.title === 'string' ? shareData.title : '',
      summary: typeof shareData.summary === 'string' ? shareData.summary : '',
      image: typeof shareData.image === 'string' ? shareData.image : '',
      category: typeof shareData.category === 'string' ? shareData.category : '',
      price: shareData.price
    }
  }

  // 频率限制：1分钟内最多10条消息
  const canSend = await checkRateLimit(openid, 'messages', 1, 10)
  if (!canSend) return { code: -1, msg: '发送太频繁，请稍后再试' }

  // 文本审核
  if (type === 'text' || type === 'emoji') {
    const check = checkBannedWords(trimmedContent)
    if (!check.pass) return { code: -2, msg: `消息包含违规词"${check.word}"` }
  }

  const msg = {
    _openid: openid,
    fromOpenid: openid,
    toOpenid: targetOpenid,
    content: (type === 'image' || type === 'voice') ? rawContent : trimmedContent,
    type,
    duration: type === 'voice' ? (Number(data.duration) || 0) : 0,
    fileId: (type === 'image' || type === 'voice') ? (normalizedFileId || trimmedContent || '') : '',
    width: type === 'image' ? (Number(data.width) || 0) : 0,
    height: type === 'image' ? (Number(data.height) || 0) : 0,
    shareData: normalizedShareData,
    isRead: false,
    createTime: db.serverDate()
  }

  const addRes = await db.collection('messages').add({ data: msg })
  msg._id = addRes._id
  return { code: 0, data: msg }
}

async function getInteractionNotifications(openid, { page = 1, pageSize = 30 } = {}) {
  try {
    const res = await db.collection('notifications')
      .where({ toOpenid: openid, status: 'active' })
      .orderBy('createTime', 'desc')
      .skip((Math.max(1, page) - 1) * pageSize)
      .limit(pageSize)
      .get()
    return { code: 0, data: res.data || [] }
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      return { code: 0, data: [] }
    }
    throw err
  }
}

async function markInteractionNotificationsRead(openid, data = {}) {
  const ids = Array.isArray(data.ids) ? data.ids.filter(Boolean) : []
  try {
    if (ids.length > 0) {
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20)
        const res = await db.collection('notifications')
          .where({ toOpenid: openid, _id: _.in(chunk), isRead: false })
          .limit(100)
          .get()
        for (const item of res.data || []) {
          await db.collection('notifications').doc(item._id).update({ data: { isRead: true } })
        }
      }
      return { code: 0, msg: '已标记已读' }
    }

    const unread = await db.collection('notifications')
      .where({ toOpenid: openid, isRead: false, status: 'active' })
      .limit(100)
      .get()
    for (const item of unread.data || []) {
      await db.collection('notifications').doc(item._id).update({ data: { isRead: true } })
    }
    return { code: 0, msg: '已全部标记已读' }
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      return { code: 0, msg: '暂无未读互动' }
    }
    throw err
  }
}

async function getUnreadInteractionCount(openid) {
  try {
    const res = await db.collection('notifications')
      .where({ toOpenid: openid, isRead: false, status: 'active' })
      .count()
    return { code: 0, data: { unreadCount: res.total || 0 } }
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      return { code: 0, data: { unreadCount: 0 } }
    }
    throw err
  }
}

// ========== 举报操作 ==========

async function reportContent(openid, data) {
  await getUserForAction(openid, { requireActive: true })
  // 检查是否重复举报
  const existing = await db.collection('reports').where({
    _openid: openid,
    targetId: data.targetId,
    targetType: data.targetType
  }).count()

  if (existing.total > 0) return { code: -1, msg: '您已举报过该内容' }

  await db.collection('reports').add({
    data: {
      _openid: openid,
      targetId: data.targetId,
      targetType: data.targetType,
      reason: data.reason,
      status: 'pending',
      createTime: db.serverDate()
    }
  })

  return { code: 0, msg: '举报已提交，我们会尽快处理' }
}

// ========== 管理员操作 ==========

async function banUser(openid, targetOpenid) {
  const isAdmin = await checkAdmin(openid)
  if (!isAdmin) return { code: -1, msg: '无管理员权限' }

  // 封禁用户
  await db.collection('users').where({ _openid: targetOpenid }).update({
    data: { status: 'banned', banTime: db.serverDate() }
  })

  // 隐藏该用户主要内容（帖子、闲置、评论）
  await db.collection('posts').where({ _openid: targetOpenid }).update({
    data: { status: 'hidden' }
  })
  await db.collection('market_goods').where({ _openid: targetOpenid }).update({
    data: { status: 'hidden' }
  }).catch((err) => {
    if (!(err && err.message && err.message.includes('not exist'))) throw err
  })
  await db.collection('comments').where({ _openid: targetOpenid, status: 'active' }).update({
    data: { status: 'hidden' }
  })
  await db.collection('market_comments').where({ _openid: targetOpenid, status: 'active' }).update({
    data: { status: 'hidden' }
  }).catch((err) => {
    if (!(err && err.message && err.message.includes('not exist'))) throw err
  })

  return { code: 0, msg: '用户已封禁' }
}

// ========== 集市操作 ==========

async function getMarketGoods({ category, keyword, page = 1, pageSize = 20 }) {
  const parts = [{ status: 'active' }]
  if (category) parts.push({ category })

  if (keyword && keyword.trim()) {
    const regex = db.RegExp({
      regexp: escapeRegExp(keyword.trim()),
      options: 'i'
    })
    parts.push(_.or([
      { title: regex },
      { description: regex }
    ]))
  }

  const cond = parts.length === 1 ? parts[0] : _.and(parts)

  const res = await db.collection('market_goods').where(cond)
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  return { code: 0, data: res.data }
}

async function getMarketGoodsById(goodsId, openid) {
  const res = await db.collection('market_goods').doc(goodsId).get()
  let goods = res.data
  if (!goods || !goods._id || goods.status !== 'active') {
    return { code: -1, msg: '商品不存在或已下架' }
  }

  const userRes = await db.collection('users').where({ _openid: goods._openid }).limit(1).get()
  const seller = userRes.data[0] || {}
  goods = {
    ...goods,
    numericId: goods.numericId || seller.numericId || ''
  }

  let isFavored = false
  try {
    // 查询是否收藏
    const favorRes = await db.collection('market_favors').where({
      _openid: openid, goodsId
    }).count()
    isFavored = favorRes.total > 0
  } catch(e) {
    // 如果 market_favors 表还没有被生成，忽略即可
  }

  return { code: 0, data: goods, isFavored }
}

async function getMarketComments(goodsId) {
  try {
    const res = await db.collection('market_comments').where({
      goodsId,
      status: 'active'
    }).orderBy('createTime', 'desc').limit(100).get()

    return { code: 0, data: res.data }
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      return { code: 0, data: [] }
    }
    throw err
  }
}

async function getAdminMarketGoods(data) {
  let cond = {}
  if (data.status) cond.status = data.status; else cond.status = _.neq('deleted');
  if (data.category) cond.category = data.category;
  
  try {
    const res = await db.collection('market_goods').where(cond).orderBy('createTime', 'desc').limit(50).get()
    return { code: 0, data: res.data }
  } catch (e) {
    if (e.message && e.message.includes('not exist')) {
      return { code: 0, data: [] } // 无表也就是空数据
    }
    return { code: -1, msg: e.message }
  }
}

function formatConversationMessage(msg) {
  if (!msg) return ''
  if (msg.type === 'voice') return '[语音消息]'
  if (msg.type === 'image') return '[图片]'
  if (msg.type === 'post_share') return `[分享帖子] ${((msg.shareData && msg.shareData.title) || msg.content || '').trim()}`
  if (msg.type === 'goods_share') return `[分享商品] ${((msg.shareData && msg.shareData.title) || msg.content || '').trim()}`
  return msg.content || ''
}

async function addMarketGoods(openid, data) {
  const user = await getUserForAction(openid, { requireActive: true })
  // 频率限制：5分钟内最多3个
  const canPost = await checkRateLimit(openid, 'market_goods', 5, 3)
  if (!canPost) return { code: -1, msg: '发布太频繁，请稍后再试' }

  const price = Number(data.price)
  const originalPrice =
    data.originalPrice === null ||
    data.originalPrice === undefined ||
    data.originalPrice === ''
      ? null
      : Number(data.originalPrice)

  if (!data.title || !String(data.title).trim()) {
    return { code: -1, msg: '标题不能为空' }
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { code: -1, msg: '价格必须大于 0' }
  }
  if (originalPrice !== null) {
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
      return { code: -1, msg: '原价必须大于 0' }
    }
    if (originalPrice < price) {
      return { code: -1, msg: '原价不能低于现价' }
    }
  }
  if (!Array.isArray(data.images) || data.images.length === 0) {
    return { code: -1, msg: '请至少上传一张图片' }
  }

  // 内容审核
  const textToCheck = (data.title || '') + ' ' + (data.description || '')
  const localCheck = checkBannedWords(textToCheck)
  if (!localCheck.pass) return { code: -2, msg: `内容包含违规词"${localCheck.word}"` }

  const wxCheck = await wxTextCheck(openid, textToCheck)
  if (!wxCheck.pass) return { code: -2, msg: '内容未通过安全审核' }

  // 获取用户信息
  const newGoods = {
    _openid: openid,
    numericId: user.numericId || '',
    nickname: user.nickName || '未知卖家',
    avatar: user.avatarUrl || '/images/avatar_default.png',
    title: data.title,
    description: data.description || '',
    price,
    originalPrice,
    images: data.images || [],
    category: data.category || '其他',
    condition: data.condition || '未说明',
    tradeMethod: data.tradeMethod || '均可',
    bargain: data.bargain !== undefined ? data.bargain : true,
    wantCount: 0,
    commentCount: 0,
    status: 'active',
    createTime: db.serverDate()
  }

  let addRes
  try {
    addRes = await db.collection('market_goods').add({ data: newGoods })
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      // 捕获到 -502005 报错：由于云数据库中用户没有建立该表，我们在此自动帮其建表
      await db.createCollection('market_goods').catch(e => console.error('建图库失败', e))
      addRes = await db.collection('market_goods').add({ data: newGoods })
    } else {
      throw err
    }
  }
  return { code: 0, msg: '发布成功', data: { _id: addRes._id } }
}

async function toggleFavorGoods(openid, goodsId) {
  await getUserForAction(openid, { requireActive: true })
  const existing = await db.collection('market_favors').where({
    _openid: openid, goodsId
  }).get()

  if (existing.data.length > 0) {
    await db.collection('market_favors').doc(existing.data[0]._id).remove()
    return { code: 0, data: { isFavored: false } }
  } else {
    await db.collection('market_favors').add({
      data: { _openid: openid, goodsId, createTime: db.serverDate() }
    })
    const goodsRes = await db.collection('market_goods').doc(goodsId).get().catch(() => ({ data: null }))
    const goods = goodsRes.data || {}
    await addNotification({
      toOpenid: goods._openid,
      fromOpenid: openid,
      type: 'goods_favorite',
      targetType: 'goods',
      targetId: goodsId,
      goodsId,
      itemTitle: trimSnippet(goods.title || '商品'),
      itemImage: Array.isArray(goods.images) && goods.images.length ? goods.images[0] : '',
      itemPrice: goods.price,
      content: '收藏了你的商品'
    })
    return { code: 0, data: { isFavored: true } }
  }
}

async function wantMarketGoods(openid, goodsId) {
  await getUserForAction(openid, { requireActive: true })
  // 检查是否已标记
  const existing = await db.collection('market_wants').where({
    _openid: openid, goodsId
  }).count()
  if (existing.total > 0) return { code: 0, msg: '已标记' }

  await db.collection('market_wants').add({
    data: { _openid: openid, goodsId, createTime: db.serverDate() }
  })
  // 更新想要数
  await db.collection('market_goods').doc(goodsId).update({
    data: { wantCount: _.inc(1) }
  })
  const goodsRes = await db.collection('market_goods').doc(goodsId).get().catch(() => ({ data: null }))
  const goods = goodsRes.data || {}
  // 仅当商品信息有效且不是给自己发通知时才创建通知
  if (goods._openid && goods._openid !== openid) {
    await addNotification({
      toOpenid: goods._openid,
      fromOpenid: openid,
      type: 'goods_want',
      targetType: 'goods',
      targetId: goodsId,
      goodsId,
      itemTitle: trimSnippet(goods.title || '商品'),
      itemImage: Array.isArray(goods.images) && goods.images.length ? goods.images[0] : '',
      itemPrice: goods.price,
      content: '对你的商品标记了想要'
    })
  }
  return { code: 0, msg: '标记成功' }
}

async function deleteMarketGoods(openid, goodsId) {
  await getUserForAction(openid, { requireActive: true })
  const goodsRes = await db.collection('market_goods').doc(goodsId).get()
  const goods = goodsRes.data

  if (!goods || !goods._id || goods.status !== 'active') {
    return { code: -1, msg: '商品不存在或已下架' }
  }

  const isAdmin = await checkAdmin(openid)
  if (!isAdmin && goods._openid !== openid) {
    return { code: -1, msg: '无权下架该商品' }
  }

  await db.collection('market_goods').doc(goodsId).update({
    data: {
      status: 'deleted',
      deleteTime: db.serverDate()
    }
  })

  return { code: 0, msg: '商品已下架' }
}

async function addMarketComment(openid, data) {
  const user = await getUserForAction(openid, { requireActive: true })
  if (user.isMuted) return { code: -1, msg: '您已被禁言，无法评论' }

  const goodsId = data.goodsId
  const content = String(data.content || '').trim()

  if (!goodsId) return { code: -1, msg: '商品参数缺失' }
  if (!content) return { code: -1, msg: '评论内容不能为空' }

  const goodsRes = await db.collection('market_goods').doc(goodsId).get()
  const goods = goodsRes.data
  if (!goods || !goods._id || goods.status !== 'active') {
    return { code: -1, msg: '商品不存在或已下架' }
  }

  const canComment = await checkRateLimit(openid, 'market_comments', 1, 5)
  if (!canComment) return { code: -1, msg: '评论太频繁，请稍后再试' }

  const localCheck = checkBannedWords(content)
  if (!localCheck.pass) return { code: -2, msg: `评论包含违规词"${localCheck.word}"`, word: localCheck.word }

  const wxCheck = await wxTextCheck(openid, content)
  if (!wxCheck.pass) return { code: -2, msg: '评论未通过安全审核' }

  const replyTo = data.replyTo && data.replyTo.commentId
    ? {
        commentId: data.replyTo.commentId,
        nickname: data.replyTo.nickname || ''
      }
    : null

  const newComment = {
    _openid: openid,
    goodsId,
    nickname: user.nickName || '未知用户',
    avatar: user.avatarUrl || '/images/avatar_default.png',
    numericId: user.numericId || '',
    content,
    replyTo,
    status: 'active',
    createTime: db.serverDate()
  }

  let addRes
  try {
    addRes = await db.collection('market_comments').add({ data: newComment })
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      await db.createCollection('market_comments').catch(() => {})
      addRes = await db.collection('market_comments').add({ data: newComment })
    } else {
      throw err
    }
  }
  await db.collection('market_goods').doc(goodsId).update({
    data: { commentCount: _.inc(1) }
  })

  await addNotification({
    toOpenid: goods._openid,
    fromOpenid: openid,
    type: 'goods_comment',
    targetType: 'goods',
    targetId: goodsId,
    goodsId,
    commentId: addRes._id,
    content: trimSnippet(content),
    itemTitle: trimSnippet(goods.title || '商品'),
    itemImage: Array.isArray(goods.images) && goods.images.length ? goods.images[0] : '',
    itemPrice: goods.price
  })

  if (replyTo && replyTo.commentId) {
    const parentCommentRes = await db.collection('market_comments').doc(replyTo.commentId).get().catch(() => ({ data: null }))
    const parentComment = parentCommentRes.data || {}
    await addNotification({
      toOpenid: parentComment._openid,
      fromOpenid: openid,
      type: 'goods_reply',
      targetType: 'goods',
      targetId: goodsId,
      goodsId,
      commentId: addRes._id,
      content: trimSnippet(content),
      itemTitle: trimSnippet(goods.title || '商品'),
      itemImage: Array.isArray(goods.images) && goods.images.length ? goods.images[0] : '',
      itemPrice: goods.price
    })
  }

  newComment._id = addRes._id
  return { code: 0, msg: '评论成功', data: newComment }
}
