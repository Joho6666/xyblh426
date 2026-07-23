// 数据库操作云函数 - 统一处理所有 CRUD 操作
// 包含：帖子、评论、点赞、收藏、关注、私信、举报、用户管理
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 生成确定性 _id，配合 doc().get/set 实现幂等写入，防止并发重复
function makeDeterministicId(scope, ...parts) {
  const raw = [scope, ...parts.map((p) => String(p == null ? '' : p))].join('|')
  return `${scope}_${crypto.createHash('md5').update(raw).digest('hex')}`
}
const createWebAdminDispatch = require('./webAdminHandlers')
// triggerSubscribeNotify 在文件靠后定义，使用 lazy wrapper 避免循环引用
const webAdminDispatch = createWebAdminDispatch(db, _, cloud, {
  triggerSubscribeNotify: (payload) => triggerSubscribeNotify(payload)
})
const { buildMarketCategoryWhere, normalizePublishCategory } = require('./marketCategories')
const activityZoneCore = require('./activityZoneCore')

/** 与小程序 utils/campuses.js 中桂林航天工业学院 id 一致 */
const DEFAULT_CAMPUS_ID = 'guit-hangtian'

function resolveCampusIdForRead(data) {
  const raw = data && data.campusId
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return null
}

function campusWhereClause(campusId) {
  if (!campusId) return null
  if (campusId === DEFAULT_CAMPUS_ID) {
    return _.or([
      { campusId: DEFAULT_CAMPUS_ID },
      { campusId: _.exists(false) }
    ])
  }
  return { campusId }
}

// ========== 工具函数 ==========

// 验证调用者身份
function getOpenidFromContext() {
  try {
    const { OPENID } = cloud.getWXContext()
    return OPENID || ''
  } catch (e) {
    return ''
  }
}

function getOpenid(context) {
  const openid = getOpenidFromContext()
  if (!openid) throw new Error('未授权访问')
  return openid
}

/** 朋友圈单页/未登录也可读的接口（仍会在有 OPENID 时返回点赞收藏状态） */
const PUBLIC_READ_ACTIONS = new Set([
  'getPostById',
  'getComments',
  'getMarketGoodsById',
  'getMarketComments'
])

// 检查管理员权限
async function checkAdmin(openid) {
  const res = await db.collection('users').where({ _openid: openid, role: 'admin', status: 'active' }).get()
  return res.data.length > 0
}

// 频率限制检查
// 仅当目标集合不存在时才放行（首次创建场景）；其他错误均视为达到上限，避免被绕过
async function checkRateLimit(openid, collection, minutes, maxCount) {
  const timeAgo = new Date(Date.now() - minutes * 60 * 1000)
  try {
    const res = await db.collection(collection).where({
      _openid: openid,
      createTime: _.gte(timeAgo)
    }).count()
    return res.total < maxCount
  } catch (err) {
    if (typeof isCollectionNotExistError === 'function' && isCollectionNotExistError(err)) {
      console.warn('[checkRateLimit] 集合不存在，放行首笔写入:', collection)
      return true
    }
    const raw = (err && (err.errMsg || err.message || '')) + ''
    if (/not exist|DATABASE_COLLECTION_NOT_EXIST|not exists/i.test(raw)) {
      console.warn('[checkRateLimit] 集合不存在，放行首笔写入:', collection)
      return true
    }
    console.error('[checkRateLimit] 频率检查异常，按已达上限处理:', err)
    return false
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

function isCollectionNotExistError(err) {
  if (!err) return false
  const msg = String(err.message || err.errMsg || '').toLowerCase()
  const code = String(err.errCode || '')
  if (code === '-502005') return true
  if (code === '-501001' && (msg.includes('createcollection') || msg.includes('resource'))) return true
  return msg.includes('not exist') || msg.includes('collection not')
}

/** 集合不存在或云函数无权建表（-501001）时，引导管理员在控制台建 user_blocks */
function isUserBlocksUnavailableError(err) {
  if (!err) return false
  if (isCollectionNotExistError(err)) return true
  const msg = String(err.message || err.errMsg || '').toLowerCase()
  const code = String(err.errCode || '')
  return code === '-501001' || msg.includes('createcollection')
}

async function ensureCollection(collectionName) {
  if (!collectionName) return
  try {
    await db.createCollection(collectionName)
  } catch (err) {
    // 并发创建或已有集合时忽略，其他错误继续抛出
    if (!isCollectionNotExistError(err) && !String(err.message || '').includes('already')) {
      throw err
    }
  }
}

/** 拉黑关系：blocker 主动拉黑 blocked */
const USER_BLOCKS = 'user_blocks'

async function safeUserBlocksQuery(run) {
  try {
    return await run()
  } catch (err) {
    if (isCollectionNotExistError(err)) return null
    throw err
  }
}

async function conversationBlocked(openidA, openidB) {
  if (!openidA || !openidB || openidA === openidB) return false
  const res = await safeUserBlocksQuery(() =>
    db.collection(USER_BLOCKS).where(_.or([
      { blockerOpenid: openidA, blockedOpenid: openidB },
      { blockerOpenid: openidB, blockedOpenid: openidA }
    ])).limit(1).get()
  )
  return !!(res && (res.data || []).length > 0)
}

/** 主页/帖子列表：对方拉黑了我 → 我不能看对方主页与其帖子 */
async function viewerBlockedByAuthor(viewerOpenid, authorOpenid) {
  if (!viewerOpenid || !authorOpenid || viewerOpenid === authorOpenid) return false
  const res = await safeUserBlocksQuery(() =>
    db.collection(USER_BLOCKS).where({
      blockerOpenid: authorOpenid,
      blockedOpenid: viewerOpenid
    }).limit(1).get()
  )
  return !!(res && (res.data || []).length > 0)
}

/** 信息流：双向任一拉黑则不在双方时间线展示对方内容 */
async function findAuthorsHiddenByBlockRelation(viewerOpenid, authorOpenids) {
  const ids = Array.from(new Set((authorOpenids || []).filter(Boolean)))
  const hide = new Set()
  if (!viewerOpenid || ids.length === 0) return hide

  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20)
    const theyBlockedMe = await safeUserBlocksQuery(() =>
      db.collection(USER_BLOCKS).where({
        blockerOpenid: _.in(chunk),
        blockedOpenid: viewerOpenid
      }).get()
    )
    const iBlockedThem = await safeUserBlocksQuery(() =>
      db.collection(USER_BLOCKS).where({
        blockerOpenid: viewerOpenid,
        blockedOpenid: _.in(chunk)
      }).get()
    )
    if (!theyBlockedMe || !iBlockedThem) continue
    ;(theyBlockedMe.data || []).forEach((row) => hide.add(row.blockerOpenid))
    ;(iBlockedThem.data || []).forEach((row) => hide.add(row.blockedOpenid))
  }
  return hide
}

/** 帖子/商品详情：任一方拉黑另一方则不可查看 */
async function contentDetailBlocked(viewerOpenid, ownerOpenid) {
  return conversationBlocked(viewerOpenid, ownerOpenid)
}

async function removeFollowBetween(a, b) {
  if (!a || !b || a === b) return
  const [r1, r2] = await Promise.all([
    db.collection('follows').where({ _openid: a, targetOpenid: b }).get(),
    db.collection('follows').where({ _openid: b, targetOpenid: a }).get()
  ])
  const rows = [...(r1.data || []), ...(r2.data || [])]
  for (const row of rows) {
    if (row && row._id) {
      await db.collection('follows').doc(row._id).remove()
    }
  }
}

async function toggleUserBlock(openid, targetOpenid) {
  await getUserForAction(openid, { requireActive: true })
  const normalizedTarget = typeof targetOpenid === 'string' ? targetOpenid.trim() : ''
  if (!normalizedTarget) return { code: -1, msg: '目标用户参数缺失' }
  if (openid === normalizedTarget) return { code: -1, msg: '不能拉黑自己' }

  const targetRes = await db.collection('users').where({
    _openid: normalizedTarget,
    status: 'active'
  }).limit(1).get()
  if (targetRes.data.length === 0) {
    return { code: -1, msg: '目标用户不存在或已停用' }
  }

  // 勿在云函数内 db.createCollection：小程序云开发常返回 -501001，须在控制台或 CLI 预先建表 user_blocks
  const BLOCKS_SETUP_MSG =
    '拉黑数据表未就绪：请在云开发控制台「数据库」新建集合 user_blocks，或在项目 campus_treehole 目录执行 npm run db:create-user-blocks-collection'

  try {
    const existing = await safeUserBlocksQuery(() =>
      db.collection(USER_BLOCKS).where({
        blockerOpenid: openid,
        blockedOpenid: normalizedTarget
      }).get()
    )
    const existingRows = (existing && existing.data) || []

    if (existingRows.length > 0) {
      for (const row of existingRows) {
        await db.collection(USER_BLOCKS).doc(row._id).remove()
      }
      return { code: 0, data: { blocked: false } }
    }

    await db.collection(USER_BLOCKS).add({
      data: {
        blockerOpenid: openid,
        blockedOpenid: normalizedTarget,
        createTime: db.serverDate()
      }
    })
    await removeFollowBetween(openid, normalizedTarget)
    return { code: 0, data: { blocked: true } }
  } catch (err) {
    console.error('toggleUserBlock:', err)
    if (isUserBlocksUnavailableError(err)) {
      return { code: -1, msg: BLOCKS_SETUP_MSG }
    }
    throw err
  }
}

async function getBlockRelation(openid, targetOpenid) {
  const normalizedTarget = typeof targetOpenid === 'string' ? targetOpenid.trim() : ''
  if (!normalizedTarget || normalizedTarget === openid) {
    return {
      code: 0,
      data: { either: false, theyBlockedMe: false, iBlockedThem: false }
    }
  }
  const [theyBlockedMe, either, ibRow] = await Promise.all([
    viewerBlockedByAuthor(openid, normalizedTarget),
    conversationBlocked(openid, normalizedTarget),
    safeUserBlocksQuery(() =>
      db.collection(USER_BLOCKS).where({ blockerOpenid: openid, blockedOpenid: normalizedTarget }).limit(1).get()
    )
  ])
  const iBlockedThem = !!(ibRow && (ibRow.data || []).length > 0)
  return {
    code: 0,
    data: { either, theyBlockedMe, iBlockedThem }
  }
}

/** 我拉黑的用户列表（用于「黑名单」页解除拉黑） */
async function getBlockedUsersList(openid, { page = 1, pageSize = 50 } = {}) {
  await getUserForAction(openid, { requireActive: true })
  const safePage = Math.max(1, Number(page) || 1)
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 50))
  let blockRows = []
  try {
    const res = await db.collection(USER_BLOCKS)
      .where({ blockerOpenid: openid })
      .orderBy('createTime', 'desc')
      .skip((safePage - 1) * safeSize)
      .limit(safeSize)
      .get()
    blockRows = res.data || []
  } catch (e) {
    const all = await db.collection(USER_BLOCKS).where({ blockerOpenid: openid }).limit(200).get()
    const sorted = (all.data || []).slice().sort((a, b) => {
      const ta = a.createTime instanceof Date ? a.createTime.getTime() : new Date(a.createTime || 0).getTime()
      const tb = b.createTime instanceof Date ? b.createTime.getTime() : new Date(b.createTime || 0).getTime()
      return tb - ta
    })
    const start = (safePage - 1) * safeSize
    blockRows = sorted.slice(start, start + safeSize)
  }

  const ids = blockRows.map((r) => r.blockedOpenid).filter(Boolean)
  if (!ids.length) return { code: 0, data: [] }

  const users = await getUsersByOpenids(ids, { status: 'active' })
  const userMap = new Map(users.map((u) => [u._openid, u]))
  const data = ids.map((id) => {
    const u = userMap.get(id)
    if (u) {
      return {
        _openid: id,
        nickName: u.nickName || '同学',
        avatarUrl: u.avatarUrl || '/images/avatar_default.png',
        college: u.college || u.campusName || ''
      }
    }
    return {
      _openid: id,
      nickName: '用户',
      avatarUrl: '/images/avatar_default.png',
      college: ''
    }
  })
  return { code: 0, data }
}

/** imgSecCheck 的 contentType 须与文件头一致，勿固定为 png（易误判「展示异常」） */
function guessImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'image/jpeg'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'image/jpeg'
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
    console.error('微信文本安全检测异常（按强制策略拦截）:', err)
    return { pass: false, word: '(文本安全服务异常)' }
  }
}

// 微信官方图片安全检测（同步）
async function wxImageCheck(openid, fileID) {
  if (!fileID || typeof fileID !== 'string') {
    return { pass: false, word: '(图片文件参数缺失)' }
  }
  try {
    const res = await cloud.downloadFile({ fileID })
    const fileBuffer = res && res.fileContent
    if (!fileBuffer) {
      return { pass: false, word: '(图片文件读取失败)' }
    }
    const contentType = guessImageContentType(fileBuffer)
    const result = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType,
        value: fileBuffer
      }
    })
    const risky = result && result.errCode && result.errCode !== 0
    if (risky) {
      return { pass: false, word: '(图片未通过安全审核)' }
    }
    return { pass: true, word: null }
  } catch (err) {
    console.error('微信图片安全检测异常（按强制策略拦截）:', err)
    return { pass: false, word: '(图片安全服务异常)' }
  }
}

async function wxImageBatchCheck(openid, fileList) {
  const list = Array.isArray(fileList) ? fileList.filter(Boolean) : []
  if (!list.length) return { pass: true, word: null }
  const checks = await Promise.all(list.map((fileID) => wxImageCheck(openid, fileID)))
  for (let j = 0; j < checks.length; j++) {
    if (!checks[j].pass) return checks[j]
  }
  return { pass: true, word: null }
}

// ========== 主入口 ==========
exports.main = async (event, context) => {
  const { action, data = {}, webSecret } = event

  if (action === 'getTempFileUrls') {
    const { OPENID } = cloud.getWXContext()
    const envSecret = process.env.ADMIN_WEB_SECRET
    const adminSecretOk = !!(envSecret && webSecret && String(webSecret) === String(envSecret))
    if (!OPENID && !adminSecretOk) {
      return { code: -403, msg: '未授权：请登录后再获取临时链接' }
    }
    const rawFileList = Array.isArray(data.fileList) ? data.fileList : []
    const safeList = rawFileList
      .filter((f) => typeof f === 'string' && f.startsWith('cloud://'))
      .slice(0, 50)
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

  // 朋友圈单页/冷启动：不经过 getOpenid 强校验，避免 auth 为空时无法拉帖
  if (action === 'getPostById') {
    const openid = getOpenidFromContext()
    return await getPostById(data.postId, openid)
  }
  if (action === 'getComments') {
    return await getComments(data.postId, data.sortBy)
  }
  if (action === 'getMarketGoodsById') {
    const openid = getOpenidFromContext()
    return await getMarketGoodsById(data.goodsId, openid)
  }
  if (action === 'getMarketComments') {
    return await getMarketComments(data.goodsId)
  }

  // 与 callAdminPanel 相同密钥：供本机 CloudBase CLI「tcb fn invoke」执行迁移（无 OPENID）
  if (action === 'migrateCampusDefaults') {
    const envSecret = process.env.ADMIN_WEB_SECRET
    const ws = data && data.webSecret
    if (envSecret && ws && String(ws) === String(envSecret)) {
      return await runMigrateCampusDefaults()
    }
  }

  /** 校验拉黑表是否可读写（不在此 createCollection，避免 -501001） */
  if (action === 'provisionUserBlocksSchema') {
    const envSecret = process.env.ADMIN_WEB_SECRET
    const ws = data && data.webSecret
    if (!envSecret || !ws || String(ws) !== String(envSecret)) {
      return { code: -403, msg: '无效的 Web 管理密钥' }
    }
    try {
      await db.collection(USER_BLOCKS).limit(1).get()
    } catch (err) {
      if (isUserBlocksUnavailableError(err)) {
        return {
          code: -1,
          msg: '集合 user_blocks 不存在：请在云开发控制台新建该集合，或在本机 campus_treehole 执行 npm run db:create-user-blocks-collection'
        }
      }
      throw err
    }
    return {
      code: 0,
      msg: 'user_blocks 集合可访问',
      data: {
        uniqueIndex: {
          fields: ['blockerOpenid', 'blockedOpenid'],
          hint: '若未建唯一索引，请执行 npm run db:index-user-blocks 或在控制台添加复合唯一索引'
        }
      }
    }
  }

  try {
    const openid = PUBLIC_READ_ACTIONS.has(action)
      ? getOpenidFromContext()
      : getOpenid(context)
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
      case 'toggleUserBlock':
        return await toggleUserBlock(openid, data.targetOpenid)
      case 'getBlockRelation':
        return await getBlockRelation(openid, data.targetOpenid)
      case 'getBlockedUsersList':
        return await getBlockedUsersList(openid, data)

      // ===== 用户相关 =====
      case 'getUserInfo':
        return await getUserInfo(openid, data.targetOpenid || openid)
      case 'updateProfile':
        return await updateProfile(openid, data)
      case 'updateNotifySettings':
        return await updateNotifySettings(openid, data)
      case 'migrateCampusDefaults':
        return await migrateCampusDefaults(openid)
      case 'searchUsers':
        return await searchUsers(openid, data.keyword)
      case 'getMyPosts':
        return await getMyPosts(openid, data)
      case 'getUserPosts':
        return await getUserPosts(openid, data.targetOpenid, data)
      case 'getUserMarketGoods':
        return await getUserMarketGoods(openid, data.targetOpenid, data)
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
      case 'sendAnnouncementNotify':
        return await sendAnnouncementNotify(openid, data)
      case 'createAnnouncement':
        return await createAnnouncement(openid, data)
      case 'updateAnnouncement':
        return await updateAnnouncement(openid, data)
      case 'publishAnnouncement':
        return await publishAnnouncement(openid, data)
      case 'revokeAnnouncement':
        return await revokeAnnouncement(openid, data)
      case 'getAnnouncementList':
        return await getAnnouncementList(openid, data)
      case 'getAdminAnnouncementList':
        return await getAdminAnnouncementList(openid, data)
      case 'getAnnouncementDetail':
        return await getAnnouncementDetail(openid, data)
      case 'markAnnouncementRead':
        return await markAnnouncementRead(openid, data)
      case 'getUnreadAnnouncementCount':
        return await getUnreadAnnouncementCount(openid)
      case 'getActivityZone':
        return await getActivityZone(openid, data)
      case 'getActivityZoneAdmin':
        return await getActivityZoneAdmin(openid)
      case 'saveActivityZone':
        return await saveActivityZone(openid, data)
      case 'endActivityZone':
        return await endActivityZone(openid, data)

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

function sceneToNotifyPrefKey(sceneType) {
  if (sceneType === 'dm') return 'dm'
  if (sceneType === 'comment') return 'comment'
  if (sceneType === 'like') return 'like'
  if (sceneType === 'favorite') return 'favorite'
  if (sceneType === 'share') return 'share'
  if (sceneType === 'announcement') return 'announcement'
  if (sceneType === 'offshelf') return 'offshelf'
  return ''
}

async function canSendSubscribeNotify(toOpenid, sceneType) {
  if (!toOpenid) return false
  const key = sceneToNotifyPrefKey(sceneType)
  if (!key) return false
  try {
    const res = await db.collection('users').where({ _openid: toOpenid }).limit(1).get()
    const user = (res.data && res.data[0]) || {}
    if (user.notifyEnabled === false) return false
    const prefs = user.notifyPrefs || {}
    if (prefs && prefs[key] === false) return false
    return true
  } catch (err) {
    console.warn('读取通知设置失败，默认不发送订阅消息:', err)
    return false
  }
}

async function triggerSubscribeNotify(payload) {
  const toOpenid = payload && payload.toOpenid
  const sceneType = payload && payload.sceneType
  if (!(await canSendSubscribeNotify(toOpenid, sceneType))) {
    return
  }
  const internalSecret = String(process.env.INTERNAL_NOTIFY_SECRET || '').trim()
  if (!internalSecret) {
    console.warn('未配置 INTERNAL_NOTIFY_SECRET，跳过订阅消息推送')
    return
  }
  try {
    await cloud.callFunction({
      name: 'notifySender',
      data: {
        action: 'send',
        internalSecret,
        data: payload
      }
    })
  } catch (err) {
    console.warn('触发订阅消息失败（主流程不受影响）:', err)
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
async function getPostsFollowMultiChunk(targetIds, { category, keyword, page, pageSize, campusId }) {
  const parts = [{ status: 'active' }]
  const cw = campusWhereClause(campusId || DEFAULT_CAMPUS_ID)
  if (cw) parts.push(cw)
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

async function getPosts(openid, { category, keyword, page = 1, pageSize = 20, feedType = 'discover', campusId: campusIdRaw }) {
  const campusIdRead = resolveCampusIdForRead({ campusId: campusIdRaw })
  if (campusIdRead === null) {
    return { code: 0, data: [] }
  }

  const isActivityFeed = feedType === 'activity'
  let categoryForQuery = isActivityFeed ? '校园活动' : category

  let followTargetIds = null
  if (feedType === 'follow') {
    followTargetIds = await getFollowTargetOpenids(openid)
    if (followTargetIds.length === 0) {
      return { code: 0, data: [] }
    }
    if (followTargetIds.length > 20) {
      let merged = await getPostsFollowMultiChunk(followTargetIds, { category: categoryForQuery, keyword, page, pageSize, campusId: campusIdRead })
      if (openid && merged.length > 0) {
        const hide = await findAuthorsHiddenByBlockRelation(openid, merged.map((p) => p._openid))
        merged = merged.filter((p) => !hide.has(p._openid))
      }
      const withEng = await attachPostEngagement(openid, merged)
      const data = await sanitizePostsForClient(withEng, openid)
      return { code: 0, data }
    }
  }

  const parts = [{ status: 'active' }]

  const cwMain = campusWhereClause(campusIdRead)
  if (cwMain) parts.push(cwMain)

  if (isActivityFeed) {
    const zoneDoc = await fetchActivityZoneConfigDoc()
    await maybeAutoFinalizeActivityZone(zoneDoc)
    const zoneAfter = await fetchActivityZoneConfigDoc()
    if (!activityZoneCore.isActivityZoneRunning(zoneAfter)) {
      return { code: 0, data: [] }
    }
    parts.push({ category: '校园活动' })
    parts.push({ inActivityZone: true })
    if (zoneAfter.roundId) {
      parts.push({ activityRoundId: String(zoneAfter.roundId) })
    }
    categoryForQuery = '校园活动'
  } else if (categoryForQuery && categoryForQuery !== '全部') {
    parts.push({ category: categoryForQuery })
  }

  if (feedType === 'follow') {
    parts.push({ _openid: _.in(followTargetIds) })
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
  if (openid && allPosts.length > 0) {
    const hide = await findAuthorsHiddenByBlockRelation(openid, allPosts.map((p) => p._openid))
    allPosts = allPosts.filter((p) => !hide.has(p._openid))
  }
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

  const authorOpenid = post._openid
  if (authorOpenid && openid && authorOpenid !== openid) {
    if (await contentDetailBlocked(openid, authorOpenid)) {
      return { code: -1, msg: '无法查看该帖子' }
    }
  }

  let isLiked = false
  let isFavored = false
  let isAdmin = false
  if (openid) {
    const [likeRes, favorRes, adminFlag] = await Promise.all([
      db.collection('likes').where({ _openid: openid, targetId: postId, targetType: 'post' }).count(),
      db.collection('favors').where({ _openid: openid, postId: postId }).count(),
      checkAdmin(openid)
    ])
    isLiked = likeRes.total > 0
    isFavored = favorRes.total > 0
    isAdmin = adminFlag
  }

  const data = sanitizePostForClient(
    {
      ...post,
      isLiked,
      isFavored
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

  const images = Array.isArray(data.images) ? data.images : []
  const imagePromise = wxImageBatchCheck(openid, images)
  const wxCheck = await wxTextCheck(openid, textToCheck)
  if (!wxCheck.pass) {
    imagePromise.catch((e) => console.warn('addPost: image check after text fail', e))
    return { code: -2, msg: '内容未通过安全审核' }
  }
  const wxImageRes = await imagePromise
  if (!wxImageRes.pass) return { code: -2, msg: '图片未通过安全审核' }

  const videos = Array.isArray(data.videos) ? data.videos : []
  const thumbImages = Array.isArray(data.thumbImages) ? data.thumbImages : []
  if (videos.length > 0 && !isAdmin) {
    return { code: -1, msg: '仅管理员可发布视频' }
  }

  const campusIdPost =
    typeof data.campusId === 'string' && data.campusId.trim()
      ? data.campusId.trim()
      : (user.campusId || DEFAULT_CAMPUS_ID)
  const displayCollege = user.campusName || user.college || '未设置'

  const newPost = {
    _openid: openid,
    nickname: user.nickName || '未知用户',
    avatar: user.avatarUrl || '/images/avatar_default.png',
    college: displayCollege,
    campusId: campusIdPost,
    userId: openid,
    category: data.category || '校园生活',
    title: data.title || '',
    content: data.content,
    images,
    thumbImages,
    videos,
    image: images.length > 0 ? images[0] : '',
    likes: 0,
    comments: 0,
    isAnonymous: false,
    location: data.location || '',
    isTop: false,
    status: videos.length > 0 ? 'pending' : 'active',
    createTime: db.serverDate()
  }

  Object.assign(newPost, await resolveActivityTagsForPost(campusIdPost, newPost.category))

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

  const images = Array.isArray(data.images) ? data.images : []
  const imagePromise = wxImageBatchCheck(openid, images)
  const wxCheck = await wxTextCheck(openid, textToCheck)
  if (!wxCheck.pass) {
    imagePromise.catch((e) => console.warn('updatePost: image check after text fail', e))
    return { code: -2, msg: '内容未通过安全审核' }
  }
  const wxImageRes = await imagePromise
  if (!wxImageRes.pass) return { code: -2, msg: '图片未通过安全审核' }
  const thumbImages = Array.isArray(data.thumbImages) ? data.thumbImages : []
  const videos = Array.isArray(data.videos) ? data.videos : []
  if (videos.length > 0 && !isAdmin) {
    return { code: -1, msg: '仅管理员可发布视频' }
  }
  const previousVideos = Array.isArray(post.videos) ? post.videos : []
  const videosChanged = JSON.stringify(previousVideos) !== JSON.stringify(videos)

  let campusIdUpdate =
    typeof data.campusId === 'string' && data.campusId.trim()
      ? data.campusId.trim()
      : (post.campusId || user.campusId || DEFAULT_CAMPUS_ID)
  const displayCollegeUpdate = user.campusName || user.college || post.college || '未设置'

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
    college: displayCollegeUpdate,
    campusId: campusIdUpdate,
    updateTime: db.serverDate()
  }

  if (videosChanged) {
    updateData.status = videos.length > 0 ? 'pending' : 'active'
  }

  Object.assign(
    updateData,
    await resolveActivityTagsForPost(campusIdUpdate, updateData.category, post)
  )

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

  const postPre = await db.collection('posts').doc(data.postId).get().catch(() => ({ data: null }))
  const postAuthor = postPre && postPre.data && postPre.data._openid
  const postOk = postPre && postPre.data && postPre.data.status === 'active'
  if (!postOk || !postAuthor) return { code: -1, msg: '帖子不存在或已删除' }
  if (await contentDetailBlocked(openid, postAuthor)) {
    return { code: -1, msg: '无法评论该帖子' }
  }

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
  await triggerSubscribeNotify({
    toOpenid: post._openid,
    sceneType: 'comment',
    actorName: user.nickName || '有人',
    summary: `评论了你的帖子：${trimSnippet(post.title || post.content || '帖子')}`,
    page: `/pages/detail/detail?id=${data.postId}`
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
    await triggerSubscribeNotify({
      toOpenid: parentComment._openid,
      sceneType: 'comment',
      actorName: user.nickName || '有人',
      summary: `回复了你的评论：${trimSnippet(post.title || post.content || '帖子')}`,
      page: `/pages/detail/detail?id=${data.postId}`
    })
  }

  newComment._id = addRes._id
  return { code: 0, msg: '评论成功', data: newComment }
}

// ========== 点赞操作 ==========

async function toggleLikePost(openid, postId) {
  const user = await getUserForAction(openid, { requireActive: true })
  if (user.isLikeBanned) return { code: -1, msg: '您已被限制点赞' }

  const postPeek = await db.collection('posts').doc(postId).get().catch(() => ({ data: null }))
  const peek = postPeek && postPeek.data
  if (!peek || !peek._openid || peek.status !== 'active') {
    return { code: -1, msg: '帖子不存在或已删除' }
  }
  if (await contentDetailBlocked(openid, peek._openid)) {
    return { code: -1, msg: '无法点赞该帖子' }
  }

  // 使用确定性 _id 保证幂等：并发重复点赞只会有一次成功，避免计数虚增
  const likeId = makeDeterministicId('like', openid, 'post', postId)
  const existingDoc = await db.collection('likes').doc(likeId).get().catch(() => ({ data: null }))

  if (existingDoc && existingDoc.data) {
    // 取消点赞
    const removed = await db.collection('likes').doc(likeId).remove().catch(() => ({ stats: { removed: 0 } }))
    if (removed && removed.stats && removed.stats.removed > 0) {
      await db.collection('posts').doc(postId).update({ data: { likes: _.inc(-1) } })
    }
    return { code: 0, data: { isLiked: false } }
  } else {
    // 点赞：使用 _id 字段+add 确保只有一次成功；并发的另一次会因 duplicate key 而失败
    let added = false
    try {
      await db.collection('likes').add({
        data: { _id: likeId, _openid: openid, targetId: postId, targetType: 'post', createTime: db.serverDate() }
      })
      added = true
    } catch (err) {
      const msg = (err && (err.errMsg || err.message)) || ''
      if (!/duplicate|already exist|exists/i.test(String(msg))) {
        throw err
      }
    }
    if (!added) {
      // 并发兜底：另一并发请求已记录点赞，不再重复 inc
      return { code: 0, data: { isLiked: true } }
    }
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
    await triggerSubscribeNotify({
      toOpenid: post._openid,
      sceneType: 'like',
      actorName: user.nickName || '有人',
      itemTitle: trimSnippet(post.title || post.content || '帖子'),
      summary: '点赞了你的帖子',
      page: `/pages/detail/detail?id=${postId}`
    })
    return { code: 0, data: { isLiked: true } }
  }
}

async function toggleLikeComment(openid, commentId) {
  const user = await getUserForAction(openid, { requireActive: true })
  if (user.isLikeBanned) return { code: -1, msg: '您已被限制点赞' }

  // P2 #14：先校验评论存在且为 active，避免对已删除/已隐藏评论 inc
  const commentPeek = await db.collection('comments').doc(commentId).get().catch(() => ({ data: null }))
  const peekComment = commentPeek && commentPeek.data
  if (!peekComment || peekComment.status === 'deleted' || peekComment.status === 'hidden') {
    return { code: -1, msg: '评论不存在或已删除' }
  }

  const likeId = makeDeterministicId('like', openid, 'comment', commentId)
  const existingDoc = await db.collection('likes').doc(likeId).get().catch(() => ({ data: null }))

  if (existingDoc && existingDoc.data) {
    const removed = await db.collection('likes').doc(likeId).remove().catch(() => ({ stats: { removed: 0 } }))
    if (removed && removed.stats && removed.stats.removed > 0) {
      await db.collection('comments').doc(commentId).update({ data: { likes: _.inc(-1) } })
    }
    return { code: 0, data: { isLiked: false } }
  } else {
    let added = false
    try {
      await db.collection('likes').add({
        data: { _id: likeId, _openid: openid, targetId: commentId, targetType: 'comment', createTime: db.serverDate() }
      })
      added = true
    } catch (err) {
      const msg = (err && (err.errMsg || err.message)) || ''
      if (!/duplicate|already exist|exists/i.test(String(msg))) throw err
    }
    if (!added) {
      return { code: 0, data: { isLiked: true } }
    }
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
    await triggerSubscribeNotify({
      toOpenid: comment._openid,
      sceneType: 'like',
      actorName: user.nickName || '有人',
      itemTitle: trimSnippet(comment.content || '评论'),
      summary: '点赞了你的评论',
      page: comment.postId ? `/pages/detail/detail?id=${comment.postId}` : '/pages/message/message'
    })
    return { code: 0, data: { isLiked: true } }
  }
}

// ========== 收藏操作 ==========

async function toggleFavorPost(openid, postId) {
  const actor = await getUserForAction(openid, { requireActive: true })
  const existing = await db.collection('favors').where({
    _openid: openid, postId
  }).get()

  if (existing.data.length > 0) {
    await db.collection('favors').doc(existing.data[0]._id).remove()
    return { code: 0, data: { isFavored: false } }
  } else {
    const postPre = await db.collection('posts').doc(postId).get().catch(() => ({ data: null }))
    const pre = postPre && postPre.data
    if (!pre || !pre._openid || pre.status !== 'active') {
      return { code: -1, msg: '帖子不存在或已删除' }
    }
    if (await contentDetailBlocked(openid, pre._openid)) {
      return { code: -1, msg: '无法收藏该帖子' }
    }
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
    await triggerSubscribeNotify({
      toOpenid: post._openid,
      sceneType: 'favorite',
      actorName: actor.nickName || '有人',
      itemTitle: trimSnippet(post.title || post.content || '帖子'),
      summary: '收藏了你的帖子',
      page: `/pages/detail/detail?id=${postId}`
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

  if (await conversationBlocked(openid, normalizedTarget)) {
    return { code: -1, msg: '无法关注该用户' }
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
  if (openid && targetOpenid && openid !== targetOpenid) {
    if (await viewerBlockedByAuthor(openid, targetOpenid)) {
      return { code: -1, msg: '对方已将你拉黑，无法查看其主页' }
    }
  }

  const [followingRes, followerRes] = await Promise.all([
    db.collection('follows').where({ _openid: targetOpenid }).count(),
    db.collection('follows').where({ targetOpenid }).count()
  ])

  let isFollowing = false
  let iBlockedThem = false
  if (openid && targetOpenid && openid !== targetOpenid) {
    const [followRes, blockOwnRes] = await Promise.all([
      db.collection('follows').where({ _openid: openid, targetOpenid }).count(),
      safeUserBlocksQuery(() =>
        db.collection(USER_BLOCKS).where({ blockerOpenid: openid, blockedOpenid: targetOpenid }).limit(1).get()
      )
    ])
    isFollowing = followRes.total > 0
    iBlockedThem = !!(blockOwnRes && (blockOwnRes.data || []).length > 0)
  }

  return {
    code: 0,
    data: {
      ...user,
      followingCount: followingRes.total,
      followerCount: followerRes.total,
      isFollowing,
      iBlockedThem
    }
  }
}

/** 批量补齐 campusId（历史数据默认桂航） */
async function runMigrateCampusDefaults() {
  const name = '桂林航天工业学院'
  const whereMissing = _.or([
    { campusId: _.exists(false) },
    { campusId: '' }
  ])
  let postsUpdated = 0
  let goodsUpdated = 0
  let usersUpdated = 0
  try {
    const pr = await db.collection('posts').where(whereMissing).update({
      data: { campusId: DEFAULT_CAMPUS_ID }
    })
    postsUpdated = (pr && pr.stats && pr.stats.updated) || 0
  } catch (e) {
    console.error('migrate posts', e)
  }
  try {
    const gr = await db.collection('market_goods').where(whereMissing).update({
      data: { campusId: DEFAULT_CAMPUS_ID }
    })
    goodsUpdated = (gr && gr.stats && gr.stats.updated) || 0
  } catch (e) {
    console.error('migrate market_goods', e)
  }
  try {
    const ur = await db.collection('users').where(whereMissing).update({
      data: {
        campusId: DEFAULT_CAMPUS_ID,
        campusName: name,
        college: name
      }
    })
    usersUpdated = (ur && ur.stats && ur.stats.updated) || 0
  } catch (e) {
    console.error('migrate users', e)
  }
  return {
    code: 0,
    msg: '迁移完成',
    data: { postsUpdated, goodsUpdated, usersUpdated, campusId: DEFAULT_CAMPUS_ID }
  }
}

/** 管理员一次性补齐 campusId；小程序端用管理员 OPENID；CLI 用 webSecret 见 MIGRATE_CAMPUS.md */
async function migrateCampusDefaults(openid) {
  if (!(await checkAdmin(openid))) {
    return { code: -403, msg: '仅管理员可执行校区字段迁移' }
  }
  return await runMigrateCampusDefaults()
}

async function updateProfile(openid, data) {
  // 只允许更新指定字段
  const allowedFields = ['nickName', 'avatarUrl', 'college', 'bio', 'tags', 'coverImage', 'profileCompleted', 'campusId', 'campusName', 'notifyEnabled', 'notifyPrefs', 'notifyAcceptedTemplateIds', 'notifyAcceptTime']
  const updateData = {}
  for (const key of allowedFields) {
    if (data[key] !== undefined) {
      updateData[key] = data[key]
    }
  }

  if (updateData.campusName && !updateData.college) {
    updateData.college = updateData.campusName
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

  // 微信官方文本安全审核（强制）
  if (updateData.nickName) {
    const wxCheck = await wxTextCheck(openid, String(updateData.nickName))
    if (!wxCheck.pass) return { code: -2, msg: '昵称未通过安全审核' }
  }
  if (updateData.bio) {
    const wxCheck = await wxTextCheck(openid, String(updateData.bio))
    if (!wxCheck.pass) return { code: -2, msg: '简介未通过安全审核' }
  }

  // 微信官方图片安全审核（强制）
  // 这里仅接受 cloud:// 文件，确保可同步审核后再入库展示
  if (updateData.avatarUrl) {
    const avatar = String(updateData.avatarUrl || '').trim()
    if (avatar && avatar.startsWith('cloud://')) {
      const wxAvatar = await wxImageCheck(openid, avatar)
      if (!wxAvatar.pass) return { code: -2, msg: '头像未通过安全审核' }
    } else if (avatar) {
      return { code: -2, msg: '头像需先上传到云存储后再提交' }
    }
  }
  if (updateData.coverImage) {
    const cover = String(updateData.coverImage || '').trim()
    if (cover && cover.startsWith('cloud://')) {
      const wxCover = await wxImageCheck(openid, cover)
      if (!wxCover.pass) return { code: -2, msg: '封面未通过安全审核' }
    } else if (cover) {
      return { code: -2, msg: '封面需先上传到云存储后再提交' }
    }
  }

  await db.collection('users').where({ _openid: openid }).update({ data: updateData })
  return { code: 0, msg: '资料更新成功' }
}

async function updateNotifySettings(openid, data = {}) {
  const notifyEnabled = data.notifyEnabled !== undefined ? !!data.notifyEnabled : true
  const rawPrefs = data.notifyPrefs || {}
  const prefs = {
    dm: rawPrefs.dm !== false,
    comment: rawPrefs.comment !== false,
    like: rawPrefs.like !== false,
    favorite: rawPrefs.favorite !== false,
    share: rawPrefs.share !== false,
    announcement: rawPrefs.announcement !== false,
    offshelf: rawPrefs.offshelf !== false
  }
  const acceptedTemplateIds = Array.isArray(data.acceptedTemplateIds)
    ? data.acceptedTemplateIds.filter((id) => typeof id === 'string' && id.trim())
    : []
  const updateData = {
    notifyEnabled,
    notifyPrefs: prefs,
    notifyAcceptTime: db.serverDate()
  }
  if (acceptedTemplateIds.length) {
    updateData.notifyAcceptedTemplateIds = acceptedTemplateIds
  }
  await db.collection('users').where({ _openid: openid }).update({ data: updateData })
  return { code: 0, msg: '通知设置已更新' }
}

async function searchUsers(openid, keyword) {
  const baseFilters = [{ status: 'active' }]
  if (openid) {
    baseFilters.push({ _openid: _.neq(openid) })
  }

  const kw = keyword == null ? '' : String(keyword).trim()
  if (!kw) {
    // 返回推荐用户
    const cond = baseFilters.length > 1 ? _.and(baseFilters) : baseFilters[0]
    const res = await db.collection('users').where(cond)
      .limit(20).get()
    return { code: 0, data: res.data }
  }

  // 搜索昵称、学院或用户 ID（云数据库模糊匹配用正则；纯数字同时做精确匹配兼容 number / string 存库）
  const regex = db.RegExp({ regexp: escapeRegExp(kw), options: 'i' })
  const orBranches = [
    { nickName: regex },
    { college: regex },
    { numericId: regex }
  ]
  if (/^\d+$/.test(kw)) {
    orBranches.push({ numericId: kw })
    const nidNum = Number(kw)
    if (!Number.isNaN(nidNum)) orBranches.push({ numericId: nidNum })
  }
  const cond = _.and([
    ...baseFilters,
    _.or(orBranches)
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
  if (
    viewerOpenid &&
    targetOpenid &&
    viewerOpenid !== targetOpenid &&
    await viewerBlockedByAuthor(viewerOpenid, targetOpenid)
  ) {
    return { code: 0, data: [] }
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
async function getUserMarketGoods(viewerOpenid, targetOpenid, { page = 1, pageSize = 15 }) {
  if (!targetOpenid) {
    return { code: -1, msg: '缺少用户标识' }
  }
  if (
    viewerOpenid &&
    targetOpenid &&
    viewerOpenid !== targetOpenid &&
    await viewerBlockedByAuthor(viewerOpenid, targetOpenid)
  ) {
    return { code: 0, data: [], total: 0 }
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

  try {
    await removeDocsByQuery(USER_BLOCKS, _.or([
      { blockerOpenid: openid },
      { blockedOpenid: openid }
    ]))
  } catch (e) {
    if (!isCollectionNotExistError(e)) throw e
  }

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

  const [blockedByMe, blockedMe] = await Promise.all([
    safeUserBlocksQuery(() =>
      db.collection(USER_BLOCKS).where({ blockerOpenid: openid }).limit(500).get()
    ),
    safeUserBlocksQuery(() =>
      db.collection(USER_BLOCKS).where({ blockedOpenid: openid }).limit(500).get()
    )
  ])
  const hideConv = new Set()
  ;(blockedByMe && blockedByMe.data ? blockedByMe.data : []).forEach((r) => hideConv.add(r.blockedOpenid))
  ;(blockedMe && blockedMe.data ? blockedMe.data : []).forEach((r) => hideConv.add(r.blockerOpenid))

  for (const msg of allMessages) {
    const otherOpenid = msg.fromOpenid === openid ? msg.toOpenid : msg.fromOpenid
    if (hideConv.has(otherOpenid)) continue
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

  if (await conversationBlocked(openid, normalizedTarget)) {
    return { code: -1, msg: '无法查看与该用户的私信' }
  }

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

  if (await conversationBlocked(openid, targetOpenid)) {
    return { code: -1, msg: '无法与对方发送私信' }
  }

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
    const wxCheck = await wxTextCheck(openid, trimmedContent)
    if (!wxCheck.pass) return { code: -2, msg: '消息未通过安全审核' }
  }

  if (type === 'image') {
    const wxImageRes = await wxImageCheck(openid, normalizedFileId)
    if (!wxImageRes.pass) return { code: -2, msg: '图片消息未通过安全审核' }
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
  if (type === 'text' || type === 'emoji' || type === 'image' || type === 'voice') {
    const actorName = user.nickName || '有人'
    const summary = type === 'image'
      ? '给你发来了一张图片'
      : type === 'voice'
        ? '给你发来了一条语音'
        : `给你发来私信：${trimSnippet(trimmedContent || '新消息')}`
    await triggerSubscribeNotify({
      toOpenid: targetOpenid,
      sceneType: 'dm',
      actorName,
      summary,
      page: `/pages/chat/chat?openid=${openid}&nickname=${encodeURIComponent(actorName)}`
    })
  }
  if (type === 'post_share' && normalizedShareData && normalizedShareData.id) {
    const postRes = await db.collection('posts').doc(normalizedShareData.id).get().catch(() => ({ data: null }))
    const post = postRes.data || {}
    if (post._openid && post._openid !== openid) {
      await triggerSubscribeNotify({
        toOpenid: post._openid,
        sceneType: 'share',
        actorName: user.nickName || '有人',
        itemTitle: trimSnippet(post.title || post.content || normalizedShareData.title || '帖子'),
        summary: '转发了你的帖子',
        page: `/pages/detail/detail?id=${normalizedShareData.id}`
      })
    }
  }
  if (type === 'goods_share' && normalizedShareData && normalizedShareData.id) {
    const goodsRes = await db.collection('market_goods').doc(normalizedShareData.id).get().catch(() => ({ data: null }))
    const goods = goodsRes.data || {}
    if (goods._openid && goods._openid !== openid) {
      await triggerSubscribeNotify({
        toOpenid: goods._openid,
        sceneType: 'share',
        actorName: user.nickName || '有人',
        itemTitle: trimSnippet(goods.title || normalizedShareData.title || '商品'),
        summary: '转发了你的商品',
        page: `/pages/market-detail/market-detail?id=${normalizedShareData.id}`
      })
    }
  }
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

async function sendAnnouncementNotify(openid, data = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  const title = trimSnippet(data.title || '社区公告')
  const summary = trimSnippet(data.summary || '有新的公告，请及时查看')
  const announcementType = trimSnippet(data.announcementType || '社区公告')
  const page = typeof data.page === 'string' && data.page.trim() ? data.page.trim() : '/pages/index/index'
  const toOpenids = Array.isArray(data.toOpenids)
    ? Array.from(new Set(data.toOpenids.map((id) => String(id || '').trim()).filter(Boolean)))
    : []
  if (!toOpenids.length) return { code: -1, msg: '缺少接收用户列表' }
  let sent = 0
  for (const toOpenid of toOpenids) {
    await triggerSubscribeNotify({
      toOpenid,
      sceneType: 'announcement',
      itemTitle: title,
      summary,
      announcementType,
      page
    })
    sent += 1
  }
  return { code: 0, msg: '公告通知已发送', data: { sent } }
}

function normalizeCampusIds(raw) {
  const list = Array.isArray(raw) ? raw : []
  const ids = Array.from(new Set(list.map((x) => String(x || '').trim()).filter(Boolean)))
  return ids.length ? ids : ['all']
}

function buildAnnouncementBaseWhere() {
  const now = new Date()
  return _.and([
    { status: 'published' },
    { publishAt: _.lte(now) },
    _.or([{ expireAt: _.exists(false) }, { expireAt: _.gt(now) }])
  ])
}

function announcementTargetsCampus(item, campusId) {
  const target = String(campusId || DEFAULT_CAMPUS_ID).trim() || DEFAULT_CAMPUS_ID
  const ids = Array.isArray(item && item.campusIds)
    ? item.campusIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [String((item && item.campusIds) || '').trim()].filter(Boolean)
  if (!ids.length) return true
  return ids.includes('all') || ids.includes(target)
}

function announcementIsVisibleNow(item, now = new Date()) {
  if (!item || item.status !== 'published') return false
  const publishAt = item.publishAt ? new Date(item.publishAt) : null
  const expireAt = item.expireAt ? new Date(item.expireAt) : null
  if (publishAt && !Number.isNaN(publishAt.getTime()) && publishAt.getTime() > now.getTime()) return false
  if (expireAt && !Number.isNaN(expireAt.getTime()) && expireAt.getTime() <= now.getTime()) return false
  return true
}

function getPublishTs(item) {
  const t = item && item.publishAt ? new Date(item.publishAt).getTime() : 0
  return Number.isFinite(t) ? t : 0
}

function sortAnnouncements(list) {
  return (list || []).slice().sort((a, b) => {
    const pinDiff = (b && b.pinTop ? 1 : 0) - (a && a.pinTop ? 1 : 0)
    if (pinDiff !== 0) return pinDiff
    return getPublishTs(b) - getPublishTs(a)
  })
}

async function createAnnouncement(openid, data = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  const title = String(data.title || '').trim()
  const content = String(data.content || '').trim()
  if (!title) return { code: -1, msg: '公告标题不能为空' }
  if (!content) return { code: -1, msg: '公告内容不能为空' }
  const textCheck1 = await wxTextCheck(openid, title)
  const textCheck2 = await wxTextCheck(openid, content)
  if (!textCheck1.pass || !textCheck2.pass) return { code: -2, msg: '公告内容未通过安全审核' }
  const images = Array.isArray(data.images)
    ? data.images.filter((x) => typeof x === 'string' && x.trim())
    : []
  if (images.length > 10) return { code: -1, msg: '公告最多上传10张图片' }
  if (images.length) {
    const imgCheck = await wxImageBatchCheck(openid, images)
    if (!imgCheck.pass) return { code: -2, msg: '公告图片未通过安全审核' }
  }
  const userSnap = await getUserSnapshot(openid)
  const doc = {
    _openid: openid,
    title,
    content,
    images,
    campusIds: normalizeCampusIds(data.campusIds),
    status: data.status === 'published' ? 'published' : 'draft',
    priority: ['normal', 'important', 'urgent'].includes(data.priority) ? data.priority : 'normal',
    pinTop: !!data.pinTop,
    publishAt: data.status === 'published' ? db.serverDate() : null,
    expireAt: data.expireAt ? new Date(data.expireAt) : null,
    createdByOpenid: openid,
    createdByName: userSnap.nickName || '管理员',
    readCount: 0,
    targetCount: 0,
    notifySent: false,
    notifySentAt: null,
    createTime: db.serverDate(),
    updateTime: db.serverDate()
  }
  let res
  try {
    res = await db.collection('announcements').add({ data: doc })
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err
    await ensureCollection('announcements')
    res = await db.collection('announcements').add({ data: doc })
  }
  return { code: 0, msg: '公告已创建', data: { _id: res._id } }
}

async function updateAnnouncement(openid, data = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  const id = String(data.announcementId || '').trim()
  if (!id) return { code: -1, msg: '缺少公告ID' }
  const patch = {}
  if (data.title !== undefined) patch.title = String(data.title || '').trim()
  if (data.content !== undefined) patch.content = String(data.content || '').trim()
  if (data.campusIds !== undefined) patch.campusIds = normalizeCampusIds(data.campusIds)
  if (data.priority !== undefined) patch.priority = ['normal', 'important', 'urgent'].includes(data.priority) ? data.priority : 'normal'
  if (data.pinTop !== undefined) patch.pinTop = !!data.pinTop
  if (data.expireAt !== undefined) patch.expireAt = data.expireAt ? new Date(data.expireAt) : null
  if (data.images !== undefined) {
    patch.images = Array.isArray(data.images)
      ? data.images.filter((x) => typeof x === 'string' && x.trim())
      : []
    if (patch.images.length > 10) return { code: -1, msg: '公告最多上传10张图片' }
  }
  if (patch.title) {
    const c = await wxTextCheck(openid, patch.title)
    if (!c.pass) return { code: -2, msg: '标题未通过安全审核' }
  }
  if (patch.content) {
    const c = await wxTextCheck(openid, patch.content)
    if (!c.pass) return { code: -2, msg: '内容未通过安全审核' }
  }
  if (patch.images && patch.images.length) {
    const imgCheck = await wxImageBatchCheck(openid, patch.images)
    if (!imgCheck.pass) return { code: -2, msg: '公告图片未通过安全审核' }
  }
  patch.updateTime = db.serverDate()
  await db.collection('announcements').doc(id).update({ data: patch })
  return { code: 0, msg: '公告已更新' }
}

async function publishAnnouncement(openid, data = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  const id = String(data.announcementId || '').trim()
  if (!id) return { code: -1, msg: '缺少公告ID' }
  const aRes = await db.collection('announcements').doc(id).get().catch(() => ({ data: null }))
  const item = aRes.data
  if (!item) return { code: -1, msg: '公告不存在' }
  await db.collection('announcements').doc(id).update({
    data: { status: 'published', publishAt: db.serverDate(), updateTime: db.serverDate() }
  })
  if (data.sendNotify === true) {
    const where = item.campusIds && item.campusIds.indexOf('all') >= 0
      ? { status: 'active' }
      : { status: 'active', campusId: _.in(item.campusIds || [DEFAULT_CAMPUS_ID]) }
    const users = await db.collection('users').where(where).limit(200).get()
    const toOpenids = (users.data || []).map((u) => u._openid).filter(Boolean)
    if (toOpenids.length) {
      await sendAnnouncementNotify(openid, {
        title: item.title,
        summary: trimSnippet(item.content || item.title || '社区公告'),
        page: '/pages/announcement/announcement',
        toOpenids
      })
      await db.collection('announcements').doc(id).update({
        data: {
          targetCount: toOpenids.length,
          notifySent: true,
          notifySentAt: db.serverDate()
        }
      })
    }
  }
  return { code: 0, msg: '公告已发布' }
}

async function revokeAnnouncement(openid, data = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  const id = String(data.announcementId || '').trim()
  if (!id) return { code: -1, msg: '缺少公告ID' }
  await db.collection('announcements').doc(id).update({
    data: { status: 'revoked', updateTime: db.serverDate() }
  })
  return { code: 0, msg: '公告已撤回' }
}

// ---------- 活动专区（期次 + 结束后帖子转普通 + 专区清空） ----------
async function fetchActivityZoneConfigDoc() {
  try {
    const res = await db.collection('activity_zone').doc('config').get()
    return (res && res.data) || null
  } catch (err) {
    if (isCollectionNotExistError(err)) return null
    throw err
  }
}

/** set 不支持 _.remove()，写入前剔除 Command 字段 */
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

async function persistActivityZoneConfig(doc) {
  const clean = sanitizeActivityZoneConfigForSet(doc)
  try {
    await db.collection('activity_zone').doc('config').set({ data: clean })
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err
    await ensureCollection('activity_zone')
    await db.collection('activity_zone').doc('config').set({ data: clean })
  }
}

async function resolveActivityTagsForPost(campusId, category, existingPost = null) {
  const cat = String(category || '').trim()
  if (cat !== '校园活动') {
    return { inActivityZone: false, activityRoundId: _.remove() }
  }
  let zoneDoc = await fetchActivityZoneConfigDoc()
  await maybeAutoFinalizeActivityZone(zoneDoc)
  zoneDoc = await fetchActivityZoneConfigDoc()
  if (!activityZoneCore.isActivityZoneRunning(zoneDoc)) {
    return { inActivityZone: false, activityRoundId: _.remove() }
  }
  if (!activityZoneCore.announcementTargetsCampus(zoneDoc, campusId)) {
    return { inActivityZone: false, activityRoundId: _.remove() }
  }
  const roundId = String(zoneDoc.roundId || '')
  if (!roundId) {
    return { inActivityZone: false, activityRoundId: _.remove() }
  }
  if (
    existingPost &&
    existingPost.inActivityZone === true &&
    String(existingPost.activityRoundId || '') === roundId
  ) {
    return { inActivityZone: true, activityRoundId: roundId }
  }
  return { inActivityZone: true, activityRoundId: roundId }
}

async function convertActivityPostsToNormal(zoneDoc) {
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

async function finalizeActivityZoneRound(triggeredByOpenid, reason = 'manual') {
  const zoneDoc = await fetchActivityZoneConfigDoc()
  if (!zoneDoc || !zoneDoc.enabled) {
    return { code: -1, msg: '当前没有进行中的活动' }
  }
  const converted = await convertActivityPostsToNormal(zoneDoc)
  const nextRoundId = String(Date.now())
  const nextDoc = {
    enabled: false,
    campusIds: Array.isArray(zoneDoc.campusIds) ? zoneDoc.campusIds : ['all'],
    slides: [],
    roundId: nextRoundId,
    lastEndedAt: db.serverDate(),
    lastEndedBy: triggeredByOpenid || '',
    lastEndReason: reason,
    lastConvertedCount: converted,
    updateTime: db.serverDate(),
    updatedByOpenid: triggeredByOpenid || 'system'
  }
  await persistActivityZoneConfig(nextDoc)
  return {
    code: 0,
    msg: `本期活动已结束，${converted} 篇帖子已转为普通帖，专区已清空`,
    data: { converted, roundId: nextRoundId }
  }
}

async function maybeAutoFinalizeActivityZone(zoneDoc) {
  if (!zoneDoc || !zoneDoc.enabled) return null
  const endAt = activityZoneCore.parseActivityEndAt(zoneDoc.endAt)
  if (!endAt || endAt.getTime() > Date.now()) return null
  try {
    return await finalizeActivityZoneRound(zoneDoc.updatedByOpenid || 'system', 'auto_endAt')
  } catch (err) {
    console.error('[maybeAutoFinalizeActivityZone]', err)
    return { code: -1, msg: (err && err.message) || '自动结束活动失败' }
  }
}

async function getActivityZone(openid, data = {}) {
  let campusId = resolveCampusIdForRead(data)
  if (!campusId) {
    const uRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const user = (uRes.data && uRes.data[0]) || {}
    campusId = user.campusId || DEFAULT_CAMPUS_ID
  }
  let doc = await fetchActivityZoneConfigDoc()
  await maybeAutoFinalizeActivityZone(doc)
  doc = await fetchActivityZoneConfigDoc()
  if (!activityZoneCore.isActivityZoneRunning(doc)) return { code: 0, data: null }
  if (!announcementTargetsCampus(doc, campusId)) return { code: 0, data: null }
  const slides = Array.isArray(doc.slides)
    ? doc.slides.filter((s) => s && (String(s.image || '').trim() || String(s.title || '').trim()))
    : []
  if (!slides.length) return { code: 0, data: null }
  const endAt = activityZoneCore.parseActivityEndAt(doc.endAt)
  return {
    code: 0,
    data: {
      slides,
      roundId: String(doc.roundId || ''),
      endAt: endAt ? endAt.toISOString() : null
    }
  }
}

async function getActivityZoneAdmin(openid) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  let doc = await fetchActivityZoneConfigDoc()
  await maybeAutoFinalizeActivityZone(doc)
  doc = await fetchActivityZoneConfigDoc()
  const base = activityZoneCore.adminDataFromDoc(doc)
  let activePostCount = 0
  if (base.activityRunning && base.roundId) {
    try {
      const whereCond = activityZoneCore.buildFinalizePostWhere(base.campusIds, base.roundId, _)
      const cnt = await db.collection('posts').where(whereCond).count()
      activePostCount = cnt.total || 0
    } catch (err) {
      console.warn('[getActivityZoneAdmin] count posts:', err && err.message)
    }
  }
  return { code: 0, data: { ...base, activePostCount } }
}

async function saveActivityZone(openid, data = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  const prev = await fetchActivityZoneConfigDoc()
  const enabled = !!data.enabled
  const campusIds = normalizeCampusIds(data.campusIds)
  const slidesIn = Array.isArray(data.slides) ? data.slides : []
  if (slidesIn.length > 10) return { code: -1, msg: '轮播最多 10 张' }
  const slides = slidesIn.map((s) => ({
    image: String(s.image || '').trim(),
    title: String(s.title || '').trim().slice(0, 80),
    subtitle: String(s.subtitle || '').trim().slice(0, 120),
    content: String(s.content || '').trim().slice(0, 2000),
    activityTime: String(s.activityTime || '').trim().slice(0, 300),
    participation: String(s.participation || '').trim().slice(0, 800),
    rewards: String(s.rewards || '').trim().slice(0, 800),
    ctaText: String(s.ctaText || '').trim().slice(0, 16) || '了解详情'
  })).filter((s) => s.image || s.title)

  const startNewRound = !!data.startNewRound
  const prevRunning = activityZoneCore.isActivityZoneRunning(prev)
  let roundId = prev && prev.roundId ? String(prev.roundId) : ''
  if (startNewRound || (enabled && !prevRunning)) {
    roundId = String(Date.now())
  } else if (enabled && !roundId) {
    roundId = String(Date.now())
  }

  let endAt = activityZoneCore.parseActivityEndAt(data.endAt)
  if (data.endAt === null || data.endAt === '') {
    endAt = null
  }

  const doc = {
    enabled,
    campusIds,
    slides,
    roundId,
    updateTime: db.serverDate(),
    updatedByOpenid: openid
  }
  if (endAt) {
    doc.endAt = endAt
  }
  if (prev && prev.lastEndedAt) doc.lastEndedAt = prev.lastEndedAt

  await persistActivityZoneConfig(doc)

  if (enabled && endAt && endAt.getTime() <= Date.now()) {
    return await finalizeActivityZoneRound(openid, 'save_past_endAt')
  }
  return { code: 0, msg: '已保存活动专区配置', data: { roundId, endAt: endAt ? endAt.toISOString() : null } }
}

async function endActivityZone(openid) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  return finalizeActivityZoneRound(openid, 'manual')
}

async function getAnnouncementList(openid, { page = 1, pageSize = 20 } = {}) {
  const uRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
  const user = (uRes.data && uRes.data[0]) || {}
  const campusId = user.campusId || DEFAULT_CAMPUS_ID
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.max(1, Math.min(50, Number(pageSize) || 20))
  const now = new Date()
  let res
  try {
    res = await db.collection('announcements')
      .limit(200)
      .get()
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err
    return { code: 0, data: [] }
  }
  const filtered = sortAnnouncements((res.data || []).filter((item) =>
    announcementIsVisibleNow(item, now) && announcementTargetsCampus(item, campusId)
  ))
  const start = (safePage - 1) * safePageSize
  return { code: 0, data: filtered.slice(start, start + safePageSize) }
}

async function getAdminAnnouncementList(openid, { page = 1, pageSize = 30 } = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  let res
  try {
    res = await db.collection('announcements')
      .orderBy('createTime', 'desc')
      .skip((Math.max(1, page) - 1) * pageSize)
      .limit(pageSize)
      .get()
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err
    return { code: 0, data: [] }
  }
  return { code: 0, data: res.data || [] }
}

async function getAnnouncementDetail(openid, data = {}) {
  if (!(await checkAdmin(openid))) return { code: -1, msg: '无管理员权限' }
  const announcementId = String(data.announcementId || '').trim()
  if (!announcementId) return { code: -1, msg: '缺少公告ID' }
  const res = await db.collection('announcements').doc(announcementId).get().catch(() => ({ data: null }))
  if (!res || !res.data) return { code: -1, msg: '公告不存在' }
  return { code: 0, data: res.data }
}

async function markAnnouncementRead(openid, data = {}) {
  const announcementId = String(data.announcementId || '').trim()
  if (!announcementId) return { code: -1, msg: '缺少公告ID' }
  // 使用确定性 _id 防并发重复 inc
  const readId = makeDeterministicId('annread', openid, announcementId)
  const existingDoc = await db.collection('announcement_reads').doc(readId).get().catch((err) => {
    if (isCollectionNotExistError && isCollectionNotExistError(err)) {
      return null
    }
    return { data: null }
  })
  if (existingDoc && existingDoc.data) return { code: 0, msg: '已读' }

  let added = false
  const tryAdd = async () => {
    await db.collection('announcement_reads').add({
      data: {
        _id: readId,
        _openid: openid,
        announcementId,
        readTime: db.serverDate()
      }
    })
  }
  try {
    await tryAdd()
    added = true
  } catch (err) {
    const msg = (err && (err.errMsg || err.message)) || ''
    if (/duplicate|already exist|exists/i.test(String(msg))) {
      // 并发兜底：另一并发请求已写入，不再重复 inc
      return { code: 0, msg: '已读' }
    }
    if (isCollectionNotExistError && isCollectionNotExistError(err)) {
      await ensureCollection('announcement_reads')
      try {
        await tryAdd()
        added = true
      } catch (err2) {
        const msg2 = (err2 && (err2.errMsg || err2.message)) || ''
        if (/duplicate|already exist|exists/i.test(String(msg2))) {
          return { code: 0, msg: '已读' }
        }
        throw err2
      }
    } else {
      throw err
    }
  }
  if (added) {
    await db.collection('announcements').doc(announcementId).update({ data: { readCount: _.inc(1) } }).catch(() => {})
  }
  return { code: 0, msg: '已标记已读' }
}

async function getUnreadAnnouncementCount(openid) {
  const uRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
  const user = (uRes.data && uRes.data[0]) || {}
  const campusId = user.campusId || DEFAULT_CAMPUS_ID
  const now = new Date()
  let annRes
  try {
    annRes = await db.collection('announcements').limit(200).get()
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err
    return { code: 0, data: { unreadCount: 0 } }
  }
  const list = (annRes.data || []).filter((item) =>
    announcementIsVisibleNow(item, now) && announcementTargetsCampus(item, campusId)
  )
  if (!list.length) return { code: 0, data: { unreadCount: 0 } }
  const ids = list.map((x) => x._id)
  let readRes
  try {
    readRes = await db.collection('announcement_reads').where({
      _openid: openid,
      announcementId: _.in(ids)
    }).get()
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err
    readRes = { data: [] }
  }
  const readSet = new Set((readRes.data || []).map((x) => x.announcementId))
  const unreadCount = list.reduce((n, item) => n + (readSet.has(item._id) ? 0 : 1), 0)
  return { code: 0, data: { unreadCount } }
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

  // 隐藏该用户主要内容（仅 active → hidden，标记为 banUser 以便解封时精确恢复）
  await db.collection('posts').where({ _openid: targetOpenid, status: 'active' }).update({
    data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() }
  })
  await db.collection('market_goods').where({ _openid: targetOpenid, status: 'active' }).update({
    data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() }
  }).catch((err) => {
    if (!(err && err.message && err.message.includes('not exist'))) throw err
  })
  await db.collection('comments').where({ _openid: targetOpenid, status: 'active' }).update({
    data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() }
  })
  await db.collection('market_comments').where({ _openid: targetOpenid, status: 'active' }).update({
    data: { status: 'hidden', hiddenBy: 'banUser', hiddenAt: db.serverDate() }
  }).catch((err) => {
    if (!(err && err.message && err.message.includes('not exist'))) throw err
  })

  return { code: 0, msg: '用户已封禁' }
}

// ========== 集市操作 ==========

async function getMarketGoods({ category, keyword, page = 1, pageSize = 20, campusId: campusIdRaw }) {
  const campusIdRead = resolveCampusIdForRead({ campusId: campusIdRaw })
  if (campusIdRead === null) {
    return { code: 0, data: [] }
  }
  const parts = [{ status: 'active' }]
  const cw = campusWhereClause(campusIdRead)
  if (cw) parts.push(cw)
  if (category) {
    const catWhere = buildMarketCategoryWhere(_, category)
    if (catWhere) parts.push(catWhere)
  }

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

  let rows = res.data || []
  const { OPENID } = cloud.getWXContext()
  if (OPENID && rows.length > 0) {
    const hide = await findAuthorsHiddenByBlockRelation(OPENID, rows.map((r) => r._openid))
    rows = rows.filter((r) => !hide.has(r._openid))
  }

  return { code: 0, data: rows }
}

async function getMarketGoodsById(goodsId, openid) {
  const res = await db.collection('market_goods').doc(goodsId).get()
  let goods = res.data
  if (!goods || !goods._id || goods.status !== 'active') {
    return { code: -1, msg: '商品不存在或已下架' }
  }

  const sellerOpenid = goods._openid
  if (sellerOpenid && openid && sellerOpenid !== openid) {
    if (await contentDetailBlocked(openid, sellerOpenid)) {
      return { code: -1, msg: '无法查看该商品' }
    }
  }

  const userRes = await db.collection('users').where({ _openid: goods._openid }).limit(1).get()
  const seller = userRes.data[0] || {}
  goods = {
    ...goods,
    numericId: goods.numericId || seller.numericId || ''
  }

  let isFavored = false
  if (openid) {
    try {
      const favorRes = await db.collection('market_favors').where({
        _openid: openid, goodsId
      }).count()
      isFavored = favorRes.total > 0
    } catch (e) {
      // 如果 market_favors 表还没有被生成，忽略即可
    }
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
  const parts = []
  if (data.status) parts.push({ status: data.status })
  else parts.push({ status: _.neq('deleted') })
  if (data.category) {
    const catWhere = buildMarketCategoryWhere(_, data.category)
    if (catWhere) parts.push(catWhere)
  }
  const cond = parts.length === 1 ? parts[0] : _.and(parts)

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

  const imagePromise = wxImageBatchCheck(openid, data.images || [])
  const wxCheck = await wxTextCheck(openid, textToCheck)
  if (!wxCheck.pass) {
    imagePromise.catch((e) => console.warn('addMarketGoods: image check after text fail', e))
    return { code: -2, msg: '内容未通过安全审核' }
  }
  const wxImageRes = await imagePromise
  if (!wxImageRes.pass) return { code: -2, msg: '商品图片未通过安全审核' }

  const campusIdGoods =
    typeof data.campusId === 'string' && data.campusId.trim()
      ? data.campusId.trim()
      : (user.campusId || DEFAULT_CAMPUS_ID)

  // 获取用户信息
  const newGoods = {
    _openid: openid,
    numericId: user.numericId || '',
    campusId: campusIdGoods,
    nickname: user.nickName || '未知卖家',
    avatar: user.avatarUrl || '/images/avatar_default.png',
    title: data.title,
    description: data.description || '',
    price,
    originalPrice,
    images: data.images || [],
    category: normalizePublishCategory(data.category),
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
  const actor = await getUserForAction(openid, { requireActive: true })
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
    await triggerSubscribeNotify({
      toOpenid: goods._openid,
      sceneType: 'favorite',
      actorName: actor.nickName || '有人',
      itemTitle: trimSnippet(goods.title || '商品'),
      summary: '收藏了你的商品',
      page: `/pages/market-detail/market-detail?id=${goodsId}`
    })
    return { code: 0, data: { isFavored: true } }
  }
}

async function wantMarketGoods(openid, goodsId) {
  await getUserForAction(openid, { requireActive: true })
  // 使用确定性 _id 保证幂等：并发重复点击只会写入一次
  const wantId = makeDeterministicId('want', openid, goodsId)
  const existingDoc = await db.collection('market_wants').doc(wantId).get().catch(() => ({ data: null }))
  if (existingDoc && existingDoc.data) return { code: 0, msg: '已标记' }

  let added = false
  try {
    await db.collection('market_wants').add({
      data: { _id: wantId, _openid: openid, goodsId, createTime: db.serverDate() }
    })
    added = true
  } catch (err) {
    const msg = (err && (err.errMsg || err.message)) || ''
    if (!/duplicate|already exist|exists/i.test(String(msg))) throw err
  }
  if (!added) {
    return { code: 0, msg: '已标记' }
  }
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

  const favorRes = await db.collection('market_favors').where({ goodsId }).get().catch(() => ({ data: [] }))
  const wantRes = await db.collection('market_wants').where({ goodsId }).get().catch(() => ({ data: [] }))
  const receiverSet = new Set()
  ;(favorRes.data || []).forEach((item) => {
    if (item && item._openid && item._openid !== openid) receiverSet.add(item._openid)
  })
  ;(wantRes.data || []).forEach((item) => {
    if (item && item._openid && item._openid !== openid) receiverSet.add(item._openid)
  })
  const receivers = Array.from(receiverSet)
  for (const toOpenid of receivers) {
    await triggerSubscribeNotify({
      toOpenid,
      sceneType: 'offshelf',
      itemTitle: trimSnippet(goods.title || '商品'),
      reason: '作品已下架',
      summary: '你关注的内容已下架，可查看其他在售内容',
      page: '/pages/market/market'
    })
  }

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

  if (goods._openid && await contentDetailBlocked(openid, goods._openid)) {
    return { code: -1, msg: '无法评论该商品' }
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
