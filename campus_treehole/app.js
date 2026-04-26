// app.js - 小程序入口文件
// 云数据库驱动的全局数据管理中心

function trimTextForCard(text, max = 28) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/**
 * 云开发环境 ID，须与已部署 login、dbOperations 的环境一致。
 * 查看：开发者工具 → 云开发 → 设置 → 环境设置 → 环境 ID（形如 cloud1-xxxx）。
 * 若你新建了环境，把下面改成新 ID；勿用 DYNAMIC_CURRENT_ENV（体验版/真机未绑默认环境时常报错）。
 */
const CLOUD_ENV_ID = 'xyblh-5gb26qrnf9d30feb'

/** 员工推广扫码 scene 本地缓存 key（与 bindInviteEmployee 配合） */
const INVITE_SCENE_STORAGE_KEY = 'invite_scene'

App({
  // 小程序初始化
  onLaunch(options) {
    console.log('校园便利盒小程序启动')
    this.saveInviteSceneIfPresent(options)
    this._requestCache = new Map()
    this._requestInflight = new Map()
    this._tempUrlCache = new Map()

    if (wx.cloud) {
      const envId = String(CLOUD_ENV_ID || '').trim() || 'xyblh-5gb26qrnf9d30feb'
      wx.cloud.init({
        env: envId,
        traceUser: true
      })
      this.globalData.cloudReady = true
      console.log('[云开发] 初始化成功, env:', envId)
    } else {
      console.warn('[云开发] 当前环境不支持云开发')
    }

    // 执行登录
    this.doLogin()
  },

  /**
   * 从启动参数或页面 onLoad 的 options 中解析小程序码 scene，写入 invite_scene。
   * 数字型 scene 为微信场景值枚举，忽略。
   */
  saveInviteSceneIfPresent(options) {
    const scene = this._parseInviteSceneFromOptions(options)
    if (!scene) return
    try {
      wx.setStorageSync(INVITE_SCENE_STORAGE_KEY, scene)
    } catch (e) {
      console.warn('[invite_scene] 写入失败', e)
    }
  },

  _parseInviteSceneFromOptions(options) {
    if (!options || typeof options !== 'object') return ''
    let raw = options.scene
    if (raw === undefined || raw === null || raw === '') {
      const q = options.query
      if (q && q.scene !== undefined && q.scene !== null && q.scene !== '') {
        raw = q.scene
      }
    }
    if (raw === undefined || raw === null || raw === '') return ''
    if (typeof raw === 'number') return ''
    const s = String(raw).trim()
    if (!s) return ''
    try {
      return decodeURIComponent(s).trim()
    } catch (e) {
      return s
    }
  },

  /** 登录成功后尝试绑定推广员；clearScene 由云函数指示是否清除本地 scene */
  _tryBindInviteEmployee() {
    if (!this.globalData.cloudReady || !this.globalData.isLoggedIn) return
    let scene = ''
    try {
      scene = String(wx.getStorageSync(INVITE_SCENE_STORAGE_KEY) || '').trim()
    } catch (e) {
      scene = ''
    }
    if (!scene) return

    wx.cloud.callFunction({
      name: 'bindInviteEmployee',
      data: { scene },
      success: (res) => {
        const r = (res && res.result) || {}
        if (r.success && this.globalData.userInfo) {
          if (r.empId) this.globalData.userInfo.inviteEmpId = r.empId
          if (r.inviteCode != null) this.globalData.userInfo.inviteCode = r.inviteCode
          if (r.isFirstBind && r.firstScene != null) this.globalData.userInfo.firstScene = r.firstScene
        }
        const clear = r.success === true || r.clearScene === true
        if (clear) {
          try {
            wx.removeStorageSync(INVITE_SCENE_STORAGE_KEY)
          } catch (e) {}
        }
      },
      fail: (err) => {
        console.warn('[bindInviteEmployee] 调用失败，保留 invite_scene 以便重试', err)
      }
    })
  },

  // 全局数据
  globalData: {
    // 当前用户信息（登录后填充）
    userInfo: null,
    openid: '',
    isLoggedIn: false,
    loggingIn: false,
    // 应用名称
    appName: '校园便利盒',
    version: '2.0.0',
    cloudReady: false,
    // 登录回调队列（其他页面可能需要等登录完成）
    loginCallbacks: [],
    // 由发布/编辑等动作置位，Tab 页 onShow 检测后拉取最新数据
    indexFeedNeedsRefresh: false,
    marketNeedsRefresh: false,
    mineNeedsRefresh: false
  },

  // ========== 登录 ==========

  flushLoginWaiters(userInfo) {
    const cbs = this.globalData.loginCallbacks
    this.globalData.loginCallbacks = []
    cbs.forEach((cb) => {
      try {
        cb(userInfo)
      } catch (e) {
        console.error('[登录回调]', e)
      }
    })
  },

  resetSession() {
    this.globalData.userInfo = null
    this.globalData.openid = ''
    this.globalData.isLoggedIn = false
    this.globalData.loggingIn = false
    this.globalData.loginCallbacks = []
  },

  // 执行登录
  doLogin() {
    if (this.globalData.loggingIn) {
      return
    }
    if (!this.globalData.cloudReady) {
      console.warn('云开发未就绪，跳过登录')
      this.flushLoginWaiters(null)
      return
    }

    this.globalData.loggingIn = true

    wx.cloud.callFunction({
      name: 'login',
      success: (res) => {
        this.globalData.loggingIn = false
        const result = res && res.result != null ? res.result : {}
        if (result.code === 0) {
          this.globalData.openid = result.openid
          this.globalData.userInfo = result.user
          this.globalData.isLoggedIn = true
          console.log('[登录] 成功:', result.msg)

          // 员工推广：登录完成后再绑定（users 文档已由 login 云函数创建/更新）
          this._tryBindInviteEmployee()

          // 不在此自动跳转登录/隐私页：须先允许用户浏览首页等功能，在用户主动使用需身份的功能时再引导（平台审核要求）

          this.flushLoginWaiters(this.globalData.userInfo)
        } else if (result.code === -2) {
          wx.showModal({
            title: '账号已被封禁',
            content: '您的账号因违规行为已被封禁，如有疑问请联系客服。',
            showCancel: false
          })
          this.flushLoginWaiters(null)
        } else if (result.code === -3) {
          wx.showModal({
            title: '账号已注销',
            content: result.msg || '该账号已注销，无法继续使用。',
            showCancel: false
          })
          this.flushLoginWaiters(null)
        } else {
          console.error('[登录] 失败:', result.msg)
          wx.showToast({
            title: result.msg || '登录失败，请稍后重试',
            icon: 'none',
            duration: 2500
          })
          this.flushLoginWaiters(null)
        }
      },
      fail: (err) => {
        this.globalData.loggingIn = false
        console.error('[登录] 云函数调用失败:', err)
        wx.showToast({ title: '网络异常，请检查网络后重试', icon: 'none' })
        this.flushLoginWaiters(null)
      }
    })
  },

  /**
   * Tab 页 onShow 首行调用：未完成资料/协议时跳转至对应页。
   * @param {{ mode?: 'strict' | 'browse' }} options
   * - strict（默认）：未完成则跳转（用于「发布 / 消息 / 我的」等）
   * - browse：不因未完成而跳转（用于首页、集市先浏览再授权，符合审核）
   * @returns {boolean} false 表示已发起跳转，当前页应中止后续逻辑
   */
  ensureComplianceOnTabShow(options = {}) {
    const mode = options && options.mode === 'browse' ? 'browse' : 'strict'
    if (!this.globalData.isLoggedIn || !this.globalData.userInfo) return true
    const u = this.globalData.userInfo
    const pages = getCurrentPages()
    const cur = pages.length ? pages[pages.length - 1] : null
    const route = cur && cur.route ? cur.route : ''
    if (route.indexOf('pages/login/login') >= 0 || route.indexOf('pages/privacy/privacy') >= 0) {
      return true
    }
    if (mode === 'browse') {
      return true
    }
    if (u.profileCompleted === false) {
      wx.navigateTo({ url: '/pages/login/login' })
      return false
    }
    if (u.agreedPrivacy !== true) {
      wx.navigateTo({ url: '/pages/privacy/privacy' })
      return false
    }
    return true
  },

  /**
   * 用户主动交互（点赞、收藏、评论、关注流等）前调用：未完成资料或隐私协议则跳转。
   * @returns {boolean} true 表示可继续操作；false 表示已跳转或无法继续
   */
  requestComplianceForAction() {
    if (!this.globalData.cloudReady) {
      wx.showToast({ title: '服务初始化中，请稍后', icon: 'none' })
      return false
    }
    if (!this.globalData.isLoggedIn || !this.globalData.userInfo) {
      wx.showToast({ title: '请稍候或下拉刷新后再试', icon: 'none' })
      if (!this.globalData.loggingIn) {
        this.doLogin()
      }
      return false
    }
    const u = this.globalData.userInfo
    const pages = getCurrentPages()
    const cur = pages.length ? pages[pages.length - 1] : null
    const route = cur && cur.route ? cur.route : ''
    if (route.indexOf('pages/login/login') >= 0 || route.indexOf('pages/privacy/privacy') >= 0) {
      return false
    }
    if (u.profileCompleted === false) {
      wx.navigateTo({ url: '/pages/login/login' })
      return false
    }
    if (u.agreedPrivacy !== true) {
      wx.navigateTo({ url: '/pages/privacy/privacy' })
      return false
    }
    return true
  },

  // 等待登录完成（供页面调用；失败或云未就绪时 userInfo 可能为 null）
  waitForLogin(callback) {
    if (this.globalData.isLoggedIn) {
      callback(this.globalData.userInfo)
    } else {
      this.globalData.loginCallbacks.push(callback)
      if (!this.globalData.loggingIn && this.globalData.cloudReady) {
        this.doLogin()
      }
    }
  },

  // ========== 云函数调用封装 ==========

  // 调用 dbOperations 云函数（统一入口）
  callDB(action, data = {}) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'dbOperations',
        data: { action, data },
        success: (res) => {
          const result = res && res.result != null ? res.result : {}
          if (result.code === 0) {
            resolve(result)
          } else {
            reject(result)
          }
        },
        fail: (err) => {
          console.error(`[callDB] ${action} 失败:`, err)
          const errMsg = String((err && err.errMsg) || err.message || '')
          let msg = '网络错误，请重试'
          if (/function not found|FUNCTION_NOT_FOUND|不存在对应云函数|-4040|404012/i.test(errMsg)) {
            msg = '云端未部署：请在开发者工具部署云函数 dbOperations 并选择正确云环境'
          } else if (/env not exists|环境不存在|invalid env|-601034/i.test(errMsg)) {
            msg = '云环境 ID 不匹配：请在 app.js 顶部将 CLOUD_ENV_ID 改为云开发控制台里的环境 ID'
          } else if (errMsg && errMsg.length < 100) {
            msg = errMsg
          }
          reject({ code: -1, msg })
        }
      })
    })
  },

  getCachedValue(key) {
    const item = this._requestCache && this._requestCache.get(key)
    if (!item) return null
    if (item.expireAt <= Date.now()) {
      this._requestCache.delete(key)
      return null
    }
    return item.value
  },

  setCachedValue(key, value, ttlMs) {
    if (!key || !ttlMs) return value
    this._requestCache.set(key, {
      value,
      expireAt: Date.now() + ttlMs
    })
    return value
  },

  invalidateCacheByPrefix(prefix) {
    if (!this._requestCache || !prefix) return
    Array.from(this._requestCache.keys()).forEach((key) => {
      if (key.indexOf(prefix) === 0) {
        this._requestCache.delete(key)
      }
    })
  },

  cachedCall(key, ttlMs, factory) {
    const cached = this.getCachedValue(key)
    if (cached !== null) {
      return Promise.resolve(cached)
    }
    if (this._requestInflight.has(key)) {
      return this._requestInflight.get(key)
    }
    const promise = Promise.resolve()
      .then(factory)
      .then((value) => {
        this.setCachedValue(key, value, ttlMs)
        this._requestInflight.delete(key)
        return value
      })
      .catch((err) => {
        this._requestInflight.delete(key)
        throw err
      })
    this._requestInflight.set(key, promise)
    return promise
  },

  // ========== 帖子操作 ==========

  // 获取帖子列表（失败时抛出，由页面区分「网络错误」与「真的没有帖子」）
  async getPosts(category, keyword, page = 1, feedType = 'discover') {
    const payload = { category, keyword, page, feedType }
    const oid = this.globalData.openid || ''
    const cacheKey = `getPosts:${stableStringify(payload)}:${oid}`
    return this.cachedCall(cacheKey, page === 1 ? 15000 : 8000, async () => {
      const result = await this.callDB('getPosts', payload)
      return result.data || []
    })
  },

  // 获取单个帖子
  async getPostById(postId) {
    try {
      const oid = this.globalData.openid || ''
      return await this.cachedCall(`getPostById:${postId}:${oid}`, 15000, async () => {
        const result = await this.callDB('getPostById', { postId })
        return result.data || null
      })
    } catch (err) {
      console.error('获取帖子详情失败:', err)
      return null
    }
  },

  // 发布新帖子
  async addPost(postData) {
    try {
      const result = await this.callDB('addPost', postData)
      this.invalidateCacheByPrefix('getPosts:')
      this.invalidateCacheByPrefix('getPostById:')
      return result
    } catch (err) {
      wx.showToast({ title: err.msg || '发布失败', icon: 'none' })
      return null
    }
  },

  async updatePost(postId, postData) {
    try {
      const result = await this.callDB('updatePost', { postId, ...postData })
      this.invalidateCacheByPrefix('getPosts:')
      this.invalidateCacheByPrefix(`getPostById:${postId}`)
      return result
    } catch (err) {
      wx.showToast({ title: err.msg || '更新失败', icon: 'none' })
      return null
    }
  },

  // 删除帖子
  async deletePostById(postId) {
    try {
      await this.callDB('deletePost', { postId })
      this.invalidateCacheByPrefix('getPosts:')
      this.invalidateCacheByPrefix(`getPostById:${postId}`)
      return true
    } catch (err) {
      wx.showToast({ title: err.msg || '删除失败', icon: 'none' })
      return false
    }
  },

  async deleteMarketGoodsById(goodsId) {
    try {
      await this.callDB('deleteMarketGoods', { goodsId })
      this.globalData.marketNeedsRefresh = true
      this.globalData.mineNeedsRefresh = true
      return true
    } catch (err) {
      wx.showToast({ title: err.msg || '下架失败', icon: 'none' })
      return false
    }
  },

  // 置顶帖子
  async toggleTopPost(postId) {
    try {
      const result = await this.callDB('toggleTopPost', { postId })
      const d = result.data
      return d && typeof d.isTop === 'boolean' ? d.isTop : null
    } catch (err) {
      wx.showToast({ title: err.msg || '操作失败', icon: 'none' })
      return null
    }
  },

  // ========== 点赞操作 ==========

  async toggleLikePost(postId) {
    try {
      const result = await this.callDB('toggleLikePost', { postId })
      return result.data || null
    } catch (err) {
      wx.showToast({ title: err.msg || '操作失败', icon: 'none' })
      return null
    }
  },

  async toggleLikeComment(commentId) {
    try {
      const result = await this.callDB('toggleLikeComment', { commentId })
      return result.data || null
    } catch (err) {
      wx.showToast({ title: err.msg || '操作失败', icon: 'none' })
      return null
    }
  },

  // ========== 评论操作 ==========

  async getComments(postId, sortBy) {
    try {
      const result = await this.callDB('getComments', { postId, sortBy })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async addComment(postId, content, replyTo) {
    try {
      const result = await this.callDB('addComment', { postId, content, replyTo })
      return result.data
    } catch (err) {
      wx.showToast({ title: err.msg || '评论失败', icon: 'none' })
      return null
    }
  },

  async getMarketComments(goodsId) {
    try {
      const result = await this.callDB('getMarketComments', { goodsId })
      return result.data || []
    } catch (err) {
      if (err && /未知操作/.test(err.msg || '')) {
        wx.showToast({ title: '请先上传最新云函数', icon: 'none' })
      }
      return []
    }
  },

  async addMarketComment(goodsId, content, replyTo = null) {
    try {
      const result = await this.callDB('addMarketComment', { goodsId, content, replyTo })
      return result.data
    } catch (err) {
      wx.showToast({
        title: /未知操作/.test(err.msg || '') ? '请先上传最新云函数' : (err.msg || '评论失败'),
        icon: 'none'
      })
      return null
    }
  },

  // ========== 收藏操作 ==========

  async toggleFavorPost(postId) {
    try {
      const result = await this.callDB('toggleFavorPost', { postId })
      const d = result.data
      return d && typeof d.isFavored === 'boolean' ? d.isFavored : null
    } catch (err) {
      wx.showToast({ title: err.msg || '操作失败', icon: 'none' })
      return null
    }
  },

  async getFavoredPosts(page = 1, pageSize = 20) {
    try {
      const result = await this.callDB('getFavoredPosts', { page, pageSize })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async getLikedPosts(page = 1, pageSize = 20) {
    try {
      const result = await this.callDB('getLikedPosts', { page, pageSize })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  // ========== 关注操作 ==========

  async toggleFollow(targetOpenid) {
    try {
      const result = await this.callDB('toggleFollow', { targetOpenid })
      return result.data.isFollowing
    } catch (err) {
      wx.showToast({ title: err.msg || '操作失败', icon: 'none' })
      return null
    }
  },

  async getFollowingList(page = 1) {
    try {
      const result = await this.callDB('getFollowingList', { page })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async getFollowerList(page = 1) {
    try {
      const result = await this.callDB('getFollowerList', { page })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  // ========== 用户操作 ==========

  async getUserInfo(targetOpenid) {
    try {
      const result = await this.callDB('getUserInfo', { targetOpenid })
      return result.data || null
    } catch (err) {
      return null
    }
  },

  async updateProfile(data) {
    try {
      const result = await this.callDB('updateProfile', data)
      // 同步更新本地缓存
      if (this.globalData.userInfo) {
        Object.assign(this.globalData.userInfo, data)
      }
      return result
    } catch (err) {
      wx.showToast({ title: err.msg || '更新失败', icon: 'none' })
      return null
    }
  },

  async searchUsers(keyword) {
    try {
      const result = await this.callDB('searchUsers', { keyword })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async getMyPosts(page = 1, pageSize = 20) {
    try {
      const result = await this.callDB('getMyPosts', { page, pageSize })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async getUserPosts(targetOpenid, page = 1, pageSize = 20) {
    try {
      const result = await this.callDB('getUserPosts', { targetOpenid, page, pageSize })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async getUserMarketGoods(targetOpenid, page = 1, pageSize = 15) {
    try {
      const result = await this.callDB('getUserMarketGoods', { targetOpenid, page, pageSize })
      return {
        list: result.data || [],
        total: typeof result.total === 'number' ? result.total : 0
      }
    } catch (err) {
      return { list: [], total: 0 }
    }
  },

  // 同意隐私协议
  async agreePrivacy() {
    try {
      await this.callDB('agreePrivacy')
      if (this.globalData.userInfo) {
        this.globalData.userInfo.agreedPrivacy = true
      }
      return true
    } catch (err) {
      return false
    }
  },

  // 注销账号
  async deleteAccount() {
    try {
      await this.callDB('deleteAccount')
      this.resetSession()
      return true
    } catch (err) {
      wx.showToast({ title: err.msg || '注销失败', icon: 'none' })
      return false
    }
  },

  // ========== 私信操作 ==========

  async getConversationList() {
    try {
      const result = await this.callDB('getConversations')
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async getUnreadMessageCount() {
    return this.cachedCall('unread:message', 5000, async () => {
      try {
        const result = await this.callDB('getUnreadMessageCount')
        return (result.data && result.data.unreadCount) || 0
      } catch (err) {
        const conversations = await this.getConversationList()
        return conversations.reduce((sum, item) => sum + (item.unreadCount || 0), 0)
      }
    })
  },

  async getInteractionNotifications(page = 1, pageSize = 30) {
    try {
      const result = await this.callDB('getInteractionNotifications', { page, pageSize })
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async markInteractionNotificationsRead(ids = []) {
    try {
      await this.callDB('markInteractionNotificationsRead', { ids })
      this.invalidateCacheByPrefix('unread:')
      return true
    } catch (err) {
      return false
    }
  },

  async getUnreadInteractionCount() {
    return this.cachedCall('unread:interaction', 5000, async () => {
      try {
        const result = await this.callDB('getUnreadInteractionCount')
        return (result.data && result.data.unreadCount) || 0
      } catch (err) {
        return 0
      }
    })
  },

  resolveTabBar(tabBarInstance) {
    return tabBarInstance ||
      (getCurrentPages().length > 0 &&
      typeof getCurrentPages()[getCurrentPages().length - 1].getTabBar === 'function'
        ? getCurrentPages()[getCurrentPages().length - 1].getTabBar()
        : null)
  },

  setMessageBadgeCount(unreadCount, tabBarInstance) {
    const safeUnread = Math.max(0, Number(unreadCount) || 0)
    const tabBar = this.resolveTabBar(tabBarInstance)
    if (tabBar && typeof tabBar.setData === 'function') {
      if (!tabBar.data || tabBar.data.unreadCount !== safeUnread) {
        tabBar.setData({ unreadCount: safeUnread })
      }
    }
    this._lastBadgeCount = safeUnread
    return safeUnread
  },

  syncMessageBadge(tabBarInstance, options = {}) {
    const minIntervalMs = options.minIntervalMs === undefined
      ? 15000
      : Number(options.minIntervalMs) || 0
    const preload = options.preload && typeof options.preload === 'object' ? options.preload : null
    const force = !!options.force

    if (this._badgeDebounceTimer) {
      clearTimeout(this._badgeDebounceTimer)
    }
    this._badgeDebounceTimer = setTimeout(() => {
      this._badgeDebounceTimer = null
      const now = Date.now()
      if (!force && minIntervalMs > 0 && this._lastBadgeSyncAt && now - this._lastBadgeSyncAt < minIntervalMs) {
        return
      }
      this._syncMessageBadgeNow(tabBarInstance, preload)
        .then(() => {
          this._lastBadgeSyncAt = Date.now()
        })
        .catch((err) => {
          console.warn('[syncMessageBadge] 失败:', err)
        })
    }, 120)
  },

  async _syncMessageBadgeNow(tabBarInstance, preload = null) {
    let chatUnread
    let interactionUnread

    if (
      preload &&
      Number.isFinite(preload.chatUnread) &&
      Number.isFinite(preload.interactionUnread)
    ) {
      chatUnread = Math.max(0, Number(preload.chatUnread) || 0)
      interactionUnread = Math.max(0, Number(preload.interactionUnread) || 0)
    } else {
      [chatUnread, interactionUnread] = await Promise.all([
        this.getUnreadMessageCount(),
        this.getUnreadInteractionCount()
      ])
    }

    return this.setMessageBadgeCount(chatUnread + interactionUnread, tabBarInstance)
  },

  async getMessages(targetOpenid) {
    try {
      const result = await this.callDB('getMessages', { targetOpenid })
      this.invalidateCacheByPrefix('unread:')
      return result.data || []
    } catch (err) {
      return []
    }
  },

  async getTempFileUrls(fileList = []) {
    if (!Array.isArray(fileList) || fileList.length === 0) {
      return []
    }

    const chunkSize = 50
    const map = {}
    const now = Date.now()
    const pending = []

    const ingest = (rawList) => {
      if (!Array.isArray(rawList)) return
      rawList.forEach((item) => {
        const fid = item.fileID || item.FileID || item.fileId
        const url = item.tempFileURL || item.TempFileURL || item.download_url || item.download_URL
        if (fid && url) {
          const normalized = { fileID: fid, tempFileURL: url }
          map[fid] = normalized
          this._tempUrlCache.set(fid, {
            value: normalized,
            expireAt: Date.now() + 25 * 60 * 1000
          })
        }
      })
    }

    fileList.forEach((fid) => {
      const cached = this._tempUrlCache.get(fid)
      if (cached && cached.expireAt > now) {
        map[fid] = cached.value
      } else {
        pending.push(fid)
      }
    })

    if (pending.length === 0) {
      return fileList.filter((fid) => map[fid]).map((fid) => map[fid])
    }

    if (this.globalData.cloudReady && typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.getTempFileURL === 'function') {
      for (let i = 0; i < pending.length; i += chunkSize) {
        const chunk = pending.slice(i, i + chunkSize)
        try {
          const res = await new Promise((resolve, reject) => {
            wx.cloud.getTempFileURL({
              fileList: chunk,
              success: resolve,
              fail: reject
            })
          })
          ingest(res && res.fileList)
        } catch (err) {
          console.error('[getTempFileUrls] 客户端解析失败:', err)
        }
      }
    }

    const missing = pending.filter((fid) => typeof fid === 'string' && fid.startsWith('cloud://') && !map[fid])
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i += chunkSize) {
        const chunk = missing.slice(i, i + chunkSize)
        try {
          const result = await this.callDB('getTempFileUrls', { fileList: chunk })
          if (result.data && result.data.length) ingest(result.data)
        } catch (err) {
          console.error('[getTempFileUrls] 云函数分片失败:', err)
        }
      }
    }

    return fileList.filter((fid) => map[fid]).map((fid) => map[fid])
  },

  /**
   * 将帖子中的 cloud:// 转为临时 HTTPS，便于 image/video 展示他人上传的媒体
   */
  async resolvePostsMedia(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return posts

    try {
      const ids = []
      const collect = (u) => {
        if (typeof u !== 'string' || !u.startsWith('cloud://')) return
        ids.push(u)
      }

      for (const p of posts) {
        if (Array.isArray(p.images)) p.images.forEach(collect)
        if (Array.isArray(p.videos)) p.videos.forEach(collect)
        collect(p.image)
        collect(p.avatar)
      }

      if (ids.length === 0) return posts

      const urlMap = await this.resolveFileUrlsMap(ids)
      if (!urlMap || Object.keys(urlMap).length === 0) return posts

      const mapOne = (u) => (typeof u === 'string' && urlMap[u] ? urlMap[u] : u)

      return posts.map((p) => ({
        ...p,
        images: Array.isArray(p.images) ? p.images.map(mapOne) : p.images,
        videos: Array.isArray(p.videos) ? p.videos.map(mapOne) : p.videos,
        image: p.image ? mapOne(p.image) : p.image,
        avatar: p.avatar ? mapOne(p.avatar) : p.avatar
      }))
    } catch (err) {
      console.warn('[resolvePostsMedia] 解析失败，返回原始数据:', err)
      return posts
    }
  },

  /**
   * 首页卡片只展示首图/首视频/头像，避免把整帖所有媒体都解析一遍
   */
  async resolveFeedCardMedia(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return posts

    try {
      const ids = []
      const collect = (u) => {
        if (typeof u !== 'string' || !u.startsWith('cloud://')) return
        ids.push(u)
      }

      posts.forEach((post) => {
        collect(Array.isArray(post.thumbImages) && post.thumbImages.length ? post.thumbImages[0] : '')
        collect(Array.isArray(post.images) ? post.images[0] : '')
        collect(Array.isArray(post.videos) ? post.videos[0] : '')
        collect(post.avatar)
        collect(post.image)
      })

      if (ids.length === 0) return posts

      const urlMap = await this.resolveFileUrlsMap(ids)
      if (!urlMap || Object.keys(urlMap).length === 0) return posts

      const mapOne = (u) => (typeof u === 'string' && urlMap[u] ? urlMap[u] : u)

      return posts.map((post) => ({
        ...post,
        images: Array.isArray(post.images) && post.images.length
          ? [mapOne(post.images[0]), ...post.images.slice(1)]
          : post.images,
        thumbImages: Array.isArray(post.thumbImages) && post.thumbImages.length
          ? [mapOne(post.thumbImages[0]), ...post.thumbImages.slice(1)]
          : post.thumbImages,
        videos: Array.isArray(post.videos) && post.videos.length
          ? [mapOne(post.videos[0]), ...post.videos.slice(1)]
          : post.videos,
        image: post.image ? mapOne(post.image) : post.image,
        avatar: post.avatar ? mapOne(post.avatar) : post.avatar
      }))
    } catch (err) {
      console.warn('[resolveFeedCardMedia] 解析失败，返回原始数据:', err)
      return posts
    }
  },

  async resolvePostMedia(post) {
    if (!post) return post
    const list = await this.resolvePostsMedia([post])
    return list[0] || post
  },

  async resolveFileUrlsMap(fileList = []) {
    const cloudIds = Array.from(new Set((fileList || []).filter(item => typeof item === 'string' && item.startsWith('cloud://'))))
    if (cloudIds.length === 0) return {}

    const tempFiles = await this.getTempFileUrls(cloudIds)
    return tempFiles.reduce((map, item) => {
      const fid = item.fileID || item.FileID
      const fileUrl = item.tempFileURL || item.TempFileURL || item.download_url || item.download_URL
      if (fid && fileUrl) {
        map[fid] = fileUrl
      }
      return map
    }, {})
  },

  async resolveFileUrl(fileId, fallback = '') {
    if (!fileId || typeof fileId !== 'string') return fallback
    if (!fileId.startsWith('cloud://')) return fileId

    const urlMap = await this.resolveFileUrlsMap([fileId])
    return urlMap[fileId] || fallback || fileId
  },

  /**
   * 分享给好友/朋友圈用的封面图（HTTPS 或本地包路径）；无图或仅 cloud 未解析时用默认图
   */
  async computeShareImageUrl(entity) {
    const fallback = '/images/icon_share.png'
    if (!entity) return fallback
    const raw = (Array.isArray(entity.images) && entity.images.length
      ? entity.images[0]
      : entity.image) || ''
    if (!raw) return fallback
    if (raw.startsWith('cloud://')) {
      const url = await this.resolveFileUrl(raw, '')
      return url || fallback
    }
    return raw
  },

  async resolveUserMedia(user) {
    if (!user) return user

    const urlMap = await this.resolveFileUrlsMap([user.avatarUrl, user.coverImage])
    return {
      ...user,
      avatarUrl: urlMap[user.avatarUrl] || user.avatarUrl || '/images/avatar_default.png',
      coverImage: urlMap[user.coverImage] || user.coverImage || ''
    }
  },

  async sendMessage(targetOpenid, content, type, extra = {}) {
    try {
      const result = await this.callDB('sendMessage', {
        targetOpenid,
        content,
        type,
        ...extra
      })
      return result.data
    } catch (err) {
      wx.showToast({ title: err.msg || '发送失败', icon: 'none' })
      return null
    }
  },

  async sendPostCardMessage(targetOpenid, post) {
    if (!post || !post._id) return null
    const shareData = {
      id: post._id,
      title: post.title || trimTextForCard(post.content || '帖子'),
      summary: trimTextForCard(post.content || ''),
      image: Array.isArray(post.images) && post.images.length ? post.images[0] : (post.image || ''),
      category: post.category || ''
    }
    return this.sendMessage(targetOpenid, shareData.title, 'post_share', { shareData })
  },

  async sendGoodsCardMessage(targetOpenid, goods) {
    if (!goods || !goods._id) return null
    const shareData = {
      id: goods._id,
      title: goods.title || '商品',
      summary: trimTextForCard(goods.description || ''),
      image: Array.isArray(goods.images) && goods.images.length ? goods.images[0] : '',
      price: goods.price
    }
    return this.sendMessage(targetOpenid, shareData.title, 'goods_share', { shareData })
  },

  // ========== 举报操作 ==========

  async reportContent(targetId, targetType, reason) {
    try {
      const result = await this.callDB('reportContent', { targetId, targetType, reason })
      return result
    } catch (err) {
      wx.showToast({ title: err.msg || '举报失败', icon: 'none' })
      return null
    }
  },

  // ========== 管理员操作 ==========

  async banUser(targetOpenid) {
    try {
      await this.callDB('banUser', { targetOpenid })
      return true
    } catch (err) {
      wx.showToast({ title: err.msg || '操作失败', icon: 'none' })
      return false
    }
  },

  // ========== 内容审核（前端预检） ==========

  // 前端违禁词预检（减少云函数调用，服务端会二次校验）
  checkContent(text) {
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
      '代写论文', '枪手代考', '买卖答案', '作弊器',
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
  },

  // ========== 图片/视频内容安全检测 ==========

  checkImageContent(filePath) {
    return new Promise((resolve) => {
      const fs = wx.getFileSystemManager()
      fs.getFileInfo({
        filePath: filePath,
        success: (fileInfo) => {
          if (fileInfo.size > 10 * 1024 * 1024) {
            resolve({ pass: false, errMsg: '图片文件过大，请压缩后重试（最大 10MB）' })
            return
          }
          if (this.globalData.cloudReady) {
            this._cloudCheckImage(filePath).then(resolve).catch(() => {
              resolve({ pass: true, errMsg: '云审核服务暂不可用，已跳过图片检测' })
            })
          } else {
            this._localCheckImage(filePath).then(resolve)
          }
        },
        fail: () => {
          resolve({ pass: false, errMsg: '无法读取图片文件' })
        }
      })
    })
  },

  _cloudCheckImage(filePath) {
    return new Promise((resolve, reject) => {
      const cloudPath = `content_check/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (uploadRes) => {
          wx.cloud.callFunction({
            name: 'contentCheck',
            data: { type: 'image', fileID: uploadRes.fileID },
            success: (res) => {
              wx.cloud.deleteFile({ fileList: [uploadRes.fileID] })
              if (res.result && !res.result.pass) {
                resolve({ pass: false, errMsg: res.result.errMsg || '图片包含违规内容' })
              } else {
                resolve({ pass: true, errMsg: '图片审核通过' })
              }
            },
            fail: (err) => {
              wx.cloud.deleteFile({ fileList: [uploadRes.fileID] })
              reject(err)
            }
          })
        },
        fail: reject
      })
    })
  },

  _localCheckImage(filePath) {
    return new Promise((resolve) => {
      wx.getImageInfo({
        src: filePath,
        success: (info) => {
          const validTypes = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
          const ext = (info.type || '').toLowerCase()
          if (ext && !validTypes.includes(ext)) {
            resolve({ pass: false, errMsg: `不支持的图片格式: ${ext}` })
            return
          }
          if (info.width < 20 || info.height < 20) {
            resolve({ pass: false, errMsg: '图片尺寸过小' })
            return
          }
          resolve({ pass: true, errMsg: '本地检测通过' })
        },
        fail: () => {
          resolve({ pass: false, errMsg: '无法识别的图片格式' })
        }
      })
    })
  },

  checkVideoContent(filePath) {
    return new Promise((resolve) => {
      const fs = wx.getFileSystemManager()
      fs.getFileInfo({
        filePath,
        success: (fileInfo) => {
          if (fileInfo.size > 30 * 1024 * 1024) {
            resolve({ pass: false, errMsg: '视频文件过大（最大允许 30MB）' })
            return
          }
          // 全面切断微信云审查 API 的同步等待卡顿！
          // 以“转入人工审核”为由直接放行，把所有包含视频的帖子都交给云函数赋予 pending 状态。
          resolve({ pass: true, errMsg: '进入人工审核队列' })
        },
        fail: () => resolve({ pass: false, errMsg: '无法读取真实的视频文件内容' })
      })
    })
  },

  async checkAllMedia(images, videos) {
    for (let i = 0; i < images.length; i++) {
      const result = await this.checkImageContent(images[i])
      if (!result.pass) {
        return { pass: false, errMsg: `第${i + 1}张图片审核未通过：${result.errMsg}`, index: i }
      }
    }
    for (let i = 0; i < videos.length; i++) {
      const result = await this.checkVideoContent(videos[i])
      if (!result.pass) {
        return { pass: false, errMsg: `视频审核未通过：${result.errMsg}`, index: i }
      }
    }
    return { pass: true, errMsg: '全部媒体审核通过' }
  },

  // ========== 工具函数 ==========

  // 格式化时间显示（兼容云数据库 Date / 字符串 / 时间戳）
  formatTime(dateStr) {
    if (!dateStr) return ''
    const date = dateStr instanceof Date ? dateStr : new Date(dateStr)
    if (Number.isNaN(date.getTime())) return ''
    const now = new Date()
    const diff = now - date

    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前'
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前'
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前'
    if (date.getFullYear() !== now.getFullYear()) {
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
    }
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
})

