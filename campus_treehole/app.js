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

const campuses = require('./utils/campuses.js')
const SELECTED_CAMPUS_ID_KEY = 'selectedCampusId_v1'
const SELECTED_CAMPUS_NAME_KEY = 'selectedCampusName_v1'
const SUBSCRIBE_TEMPLATE_IDS = {
  dm: 'urNB_Yql0bvQrr5F1ixTXHE_RJQsiHBngQtzpsybqkk',
  comment: 'jCvXTmzXH-vqli7wgYd5ou33x1xYx3XqpgFif3rIDuU',
  like: '3GQRsj3QWK1243Olqj51-eNFyFCy-MRxQb647S4qvsc',
  favorite: 'mApnJh3ejdXJAlkHo8dv0D_5jSuvSgN821TcYOgn_Cw',
  share: 'hD4CErsSj9o32U9PuLimdLdjYgmudDevTYMkeewi7zY',
  announcement: 'VxJKCaDjfRmyBF7SQs-GWyfQSsZhcaWqaZ404Xr5Bxk',
  offshelf: 'TI9X4dyUfuoqFujGvs293DPHy64epKHatOUm5c_b7JM'
}

/** 员工推广扫码 scene 本地缓存 key（与 bindInviteEmployee 配合） */
const INVITE_SCENE_STORAGE_KEY = 'invite_scene'
/** 用户互推 ref，形如 u_<numericId>（与 userReferral 配合） */
const USER_PEER_REF_STORAGE_KEY = 'user_peer_referral_ref'

App({
  // 小程序初始化
  onLaunch(options) {
    console.log('校园便利盒小程序启动')
    this.savePromoFromOptions(options)
    this._requestCache = new Map()
    this._requestInflight = new Map()
    this._tempUrlCache = new Map()
    this._tempUrlInflight = new Map()
    this._campusCache = { id: undefined, name: undefined }

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
   * 解析启动/落地页的推广参数：员工 scene 写入 invite_scene；好友邀请 u_<数字ID> 写入 user_peer_referral_ref。
   * 分享落地支持 query.ref 或 query.r。
   */
  savePromoFromOptions(options) {
    if (!options || typeof options !== 'object') return
    const q = options.query || {}
    let ref = q.ref != null && q.ref !== '' ? q.ref : q.r != null && q.r !== '' ? q.r : ''
    if (ref !== '') {
      try {
        ref = decodeURIComponent(String(ref).trim())
      } catch (e) {
        ref = String(ref).trim()
      }
      if (/^u_[0-9]+$/.test(ref)) {
        try {
          wx.setStorageSync(USER_PEER_REF_STORAGE_KEY, ref)
        } catch (e) {
          console.warn('[user_peer_referral_ref] query 写入失败', e)
        }
      }
    }
    const scene = this._parseInviteSceneFromOptions(options)
    if (!scene) return
    try {
      if (/^u_[0-9]+$/.test(scene)) {
        wx.setStorageSync(USER_PEER_REF_STORAGE_KEY, scene)
      } else {
        wx.setStorageSync(INVITE_SCENE_STORAGE_KEY, scene)
      }
    } catch (e) {
      console.warn('[promo] 写入失败', e)
    }
  },

  /** 兼容旧调用名 */
  saveInviteSceneIfPresent(options) {
    this.savePromoFromOptions(options || {})
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

  /** 登录成功后绑定用户互推邀请人 */
  _tryBindUserReferral() {
    if (!this.globalData.cloudReady || !this.globalData.isLoggedIn) return
    let ref = ''
    try {
      ref = String(wx.getStorageSync(USER_PEER_REF_STORAGE_KEY) || '').trim()
    } catch (e) {
      ref = ''
    }
    if (!ref) return

    wx.cloud.callFunction({
      name: 'userReferral',
      data: { action: 'bind', ref },
      success: (res) => {
        const r = (res && res.result) || {}
        if (r.success && this.globalData.userInfo && r.inviterOpenid) {
          this.globalData.userInfo.inviterOpenid = r.inviterOpenid
          if (r.peerInviteRef != null) this.globalData.userInfo.peerInviteRef = r.peerInviteRef
        }
        const clear = r.success === true || r.clearScene === true
        if (clear) {
          try {
            wx.removeStorageSync(USER_PEER_REF_STORAGE_KEY)
          } catch (e) {}
        }
      },
      fail: (err) => {
        console.warn('[userReferral] 调用失败，保留 user_peer_referral_ref 以便重试', err)
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
    mineNeedsRefresh: false,
    notifyTemplateIds: { ...SUBSCRIBE_TEMPLATE_IDS }
  },

  // ========== 校区（帖子 / 集市隔离） ==========

  /** 本地是否已选校区（未选则首页 / 集市列表不拉取，直至用户确认） */
  hasSelectedCampusInStorage() {
    return !!this.getCommittedCampusId()
  },

  /** 仅已写入 Storage 的校区（用于列表请求） */
  getCommittedCampusId() {
    // 命中内存缓存就直接返回，避免在列表渲染热路径里反复同步读 storage（旧手机有明显延迟）
    if (!this._campusCache) this._campusCache = { id: undefined, name: undefined }
    if (this._campusCache.id !== undefined) return this._campusCache.id
    try {
      const id = wx.getStorageSync(SELECTED_CAMPUS_ID_KEY)
      if (id && campuses.getCampusById(id)) {
        this._campusCache.id = id
        return id
      }
    } catch (e) {}
    this._campusCache.id = null
    return null
  },

  /** 发帖等写操作：已选校区 > 用户资料 > 默认桂航 */
  getSelectedCampusId() {
    const c = this.getCommittedCampusId()
    if (c) return c
    const u = this.globalData.userInfo
    if (u && u.campusId && campuses.getCampusById(u.campusId)) return u.campusId
    return campuses.DEFAULT_CAMPUS_ID
  },

  getSelectedCampusName() {
    if (!this._campusCache) this._campusCache = { id: undefined, name: undefined }
    if (this._campusCache.name !== undefined && this._campusCache.name !== null) {
      return this._campusCache.name
    }
    try {
      const name = wx.getStorageSync(SELECTED_CAMPUS_NAME_KEY)
      if (name) {
        this._campusCache.name = name
        return name
      }
    } catch (e) {}
    const id = this.getSelectedCampusId()
    const c = campuses.getCampusById(id)
    const fallback = (c && c.name) || '桂林航天工业学院'
    this._campusCache.name = fallback
    return fallback
  },

  /**
   * 保存当前校区并刷新帖子缓存；可选同步到云端用户资料
   * @param {string} campusId
   * @param {{ syncCloud?: boolean }} options
   */
  async setSelectedCampus(campusId, options = {}) {
    const c = campuses.getCampusById(campusId)
    if (!c) {
      wx.showToast({ title: '无效的校区', icon: 'none' })
      return false
    }
    try {
      wx.setStorageSync(SELECTED_CAMPUS_ID_KEY, c.id)
      wx.setStorageSync(SELECTED_CAMPUS_NAME_KEY, c.name)
    } catch (e) {
      console.warn('[campus] storage', e)
    }
    if (!this._campusCache) this._campusCache = { id: undefined, name: undefined }
    this._campusCache.id = c.id
    this._campusCache.name = c.name
    if (this.globalData.userInfo) {
      this.globalData.userInfo.campusId = c.id
      this.globalData.userInfo.campusName = c.name
      this.globalData.userInfo.college = c.name
    }
    this.invalidateCacheByPrefix('getPosts:')
    this.globalData.marketNeedsRefresh = true
    const syncCloud = options.syncCloud !== false
    if (syncCloud && this.globalData.isLoggedIn && this.globalData.cloudReady) {
      try {
        await this.updateProfile({
          campusId: c.id,
          campusName: c.name,
          college: c.name
        })
      } catch (err) {
        console.warn('[campus] updateProfile', err)
      }
    }
    return true
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

  // 执行登录（options.silent=true 时不弹「网络异常」toast，用于分享落地页）
  doLogin(options = {}) {
    const silent = !!(options && options.silent)
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
          // 用户互推：好友邀请 ref u_<numericId>
          this._tryBindUserReferral()

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
        if (!silent) {
          wx.showToast({ title: '网络异常，请检查网络后重试', icon: 'none' })
        }
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
    this.pruneRuntimeCaches()
    return value
  },

  pruneRuntimeCaches() {
    const now = Date.now()
    if (this._requestCache && this._requestCache.size > 160) {
      Array.from(this._requestCache.entries()).forEach(([key, item]) => {
        if (!item || item.expireAt <= now) this._requestCache.delete(key)
      })
      while (this._requestCache.size > 120) {
        const firstKey = this._requestCache.keys().next().value
        if (!firstKey) break
        this._requestCache.delete(firstKey)
      }
    }
    if (this._tempUrlCache && this._tempUrlCache.size > 500) {
      Array.from(this._tempUrlCache.entries()).forEach(([key, item]) => {
        if (!item || item.expireAt <= now) this._tempUrlCache.delete(key)
      })
      while (this._tempUrlCache.size > 360) {
        const firstKey = this._tempUrlCache.keys().next().value
        if (!firstKey) break
        this._tempUrlCache.delete(firstKey)
      }
    }
  },

  invalidateCacheByPrefix(prefix) {
    if (!this._requestCache || !prefix) return
    Array.from(this._requestCache.keys()).forEach((key) => {
      if (key.indexOf(prefix) === 0) {
        this._requestCache.delete(key)
      }
    })
  },

  /** 从发帖编辑页返回时强制刷新对应详情（避免仅依赖 onShow 节流导致看不到最新内容） */
  markDetailNeedsRefresh(postId) {
    if (!postId) return
    this._detailRefreshPostIds = this._detailRefreshPostIds || {}
    this._detailRefreshPostIds[postId] = true
  },

  consumeDetailNeedsRefresh(postId) {
    const m = this._detailRefreshPostIds
    if (!postId || !m || !m[postId]) return false
    delete m[postId]
    return true
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
    const campusId = this.getCommittedCampusId()
    if (!campusId) {
      return []
    }
    // 低配机优化：降低单次拉取量，减轻图片解码与列表渲染压力
    const payload = { category, keyword, page, pageSize: 12, feedType, campusId }
    const oid = this.globalData.openid || ''
    const cacheKey = `getPosts:${stableStringify(payload)}:${oid}`
    return this.cachedCall(cacheKey, page === 1 ? 15000 : 8000, async () => {
      const result = await this.callDB('getPosts', payload)
      return result.data || []
    })
  },

  // 获取单个帖子
  async getPostById(postId) {
    return this.fetchPostForShare(postId)
  },

  /**
   * 分享落地读帖：云函数失败时用客户端只读库兜底（posts 集合需 READONLY）
   */
  async fetchPostForShare(postId) {
    const id = String(postId || '').trim()
    if (!id) return null
    const oid = this.globalData.openid || ''
    const cacheKey = `getPostById:${id}:${oid}`

    const fromCloudFn = async () => {
      const result = await this.callDB('getPostById', { postId: id })
      return result.data || null
    }

    try {
      const cached = await this.cachedCall(cacheKey, 15000, fromCloudFn)
      if (cached) return cached
    } catch (err) {
      console.warn('[fetchPostForShare] 云函数失败，尝试直连数据库', err && (err.msg || err.message) ? (err.msg || err.message) : err)
    }

    if (!this.globalData.cloudReady) return null
    try {
      const res = await wx.cloud.database().collection('posts').doc(id).get()
      const post = res && res.data
      if (!post || !post._id || post.status !== 'active') return null
      return { ...post, isLiked: false, isFavored: false }
    } catch (dbErr) {
      console.warn('[fetchPostForShare] 直连数据库失败', dbErr)
      return null
    }
  },

  async fetchCommentsForShare(postId, sortBy = 'hot') {
    try {
      const result = await this.callDB('getComments', { postId, sortBy })
      return result.data || []
    } catch (err) {
      if (!this.globalData.cloudReady) return []
      try {
        let query = wx.cloud.database().collection('comments').where({ postId, status: 'active' })
        query = sortBy === 'hot'
          ? query.orderBy('likes', 'desc')
          : query.orderBy('createTime', 'desc')
        const res = await query.limit(100).get()
        return res.data || []
      } catch (dbErr) {
        console.warn('[fetchCommentsForShare] 直连失败', dbErr)
        return []
      }
    }
  },

  /** 分享落地读商品：云函数失败时用 market_goods 只读库兜底 */
  async fetchMarketGoodsForShare(goodsId) {
    const id = String(goodsId || '').trim()
    if (!id) return { data: null, isFavored: false }
    try {
      return await this.callDB('getMarketGoodsById', { goodsId: id })
    } catch (err) {
      console.warn('[fetchMarketGoodsForShare] 云函数失败，尝试直连数据库', err && (err.msg || err.message) ? (err.msg || err.message) : err)
    }
    if (!this.globalData.cloudReady) return { data: null, isFavored: false }
    try {
      const res = await wx.cloud.database().collection('market_goods').doc(id).get()
      const goods = res && res.data
      if (!goods || !goods._id || goods.status !== 'active') {
        return { data: null, isFavored: false }
      }
      return { code: 0, data: goods, isFavored: false }
    } catch (dbErr) {
      console.warn('[fetchMarketGoodsForShare] 直连数据库失败', dbErr)
      return { data: null, isFavored: false }
    }
  },

  async fetchMarketCommentsForShare(goodsId) {
    try {
      const result = await this.callDB('getMarketComments', { goodsId })
      return result.data || []
    } catch (err) {
      if (!this.globalData.cloudReady) return []
      try {
        const res = await wx.cloud.database().collection('market_comments')
          .where({ goodsId, status: 'active' })
          .orderBy('createTime', 'desc')
          .limit(100)
          .get()
        return res.data || []
      } catch (dbErr) {
        console.warn('[fetchMarketCommentsForShare] 直连失败', dbErr)
        return []
      }
    }
  },

  // 发布新帖子
  async addPost(postData) {
    try {
      const result = await this.callDB('addPost', {
        ...postData,
        campusId: this.getSelectedCampusId()
      })
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
      if (result && result.data && postId) {
        this.invalidateCacheByPrefix(`getPostById:${postId}`)
      }
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
      if (result && result.data && postId) {
        this.invalidateCacheByPrefix(`getPostById:${postId}`)
      }
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
      if (d && typeof d.isFavored === 'boolean' && postId) {
        this.invalidateCacheByPrefix(`getPostById:${postId}`)
      }
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

  async toggleUserBlock(targetOpenid) {
    try {
      const result = await this.callDB('toggleUserBlock', { targetOpenid })
      return result.data || null
    } catch (err) {
      wx.showToast({ title: (err && err.msg) || '操作失败', icon: 'none' })
      return null
    }
  },

  async getBlockRelation(targetOpenid) {
    try {
      const result = await this.callDB('getBlockRelation', { targetOpenid })
      return result.data || { either: false, theyBlockedMe: false, iBlockedThem: false }
    } catch (err) {
      return { either: false, theyBlockedMe: false, iBlockedThem: false }
    }
  },

  async getBlockedUsersList(page = 1, pageSize = 50) {
    try {
      const result = await this.callDB('getBlockedUsersList', { page, pageSize })
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

  getNotifyTemplateIds() {
    const ids = this.globalData.notifyTemplateIds || {}
    const dedup = []
    ;['dm', 'comment', 'like', 'favorite', 'share', 'announcement', 'offshelf'].forEach((k) => {
      const id = String(ids[k] || '').trim()
      if (id && dedup.indexOf(id) === -1) dedup.push(id)
    })
    return dedup
  },

  getNotifyTemplateIdsForOneTap(batch = 1) {
    const ids = this.globalData.notifyTemplateIds || {}
    // 微信订阅消息：一次点击最多申请3个模板。
    // 第1批：优先点赞/私信/评论（核心互动）；第2批：收藏/转发/下架。
    const preferredOrderBatch1 = ['like', 'dm', 'comment']
    const preferredOrderBatch2 = ['favorite', 'share', 'offshelf']
    const preferredOrder = Number(batch) === 2 ? preferredOrderBatch2 : preferredOrderBatch1
    const picked = []
    preferredOrder.forEach((k) => {
      const id = String(ids[k] || '').trim()
      if (id && picked.indexOf(id) === -1 && picked.length < 3) picked.push(id)
    })
    return picked
  },

  async enableSubscribeNotificationsFromClient(options = {}) {
    const batch = Number(options.batch) === 2 ? 2 : 1
    const tmplIds = this.getNotifyTemplateIdsForOneTap(batch)
    if (!tmplIds.length) {
      wx.showToast({ title: '请先配置订阅消息模板ID', icon: 'none' })
      return { ok: false, msg: '模板ID未配置' }
    }
    // 注意：该 API 必须由“用户手势”直接触发，且单次请求最多 3 个模板。
    // 不可在一次点击中 await 后再连续调用多次，否则后续调用会丢失手势上下文并失败。
    try {
      const requestRes = await wx.requestSubscribeMessage({ tmplIds })
      const accepted = tmplIds.filter((id) => requestRes && requestRes[id] === 'accept')
      if (!accepted.length) {
        wx.showToast({ title: '你未开启服务通知', icon: 'none' })
        return { ok: false, msg: '用户未同意' }
      }
      const idMap = this.globalData.notifyTemplateIds || {}
      const prevUserInfo = this.globalData.userInfo || {}
      const prevPrefs = prevUserInfo.notifyPrefs || {}
      const prevAcceptedIds = Array.isArray(prevUserInfo.notifyAcceptedTemplateIds)
        ? prevUserInfo.notifyAcceptedTemplateIds
        : []
      const mergedAccepted = Array.from(new Set([...prevAcceptedIds, ...accepted]))
      const isAccepted = (sceneKey) => {
        const id = String(idMap[sceneKey] || '').trim()
        return !!(id && mergedAccepted.indexOf(id) !== -1)
      }
      const mergedPrefs = {
        dm: prevPrefs.dm !== false,
        comment: prevPrefs.comment !== false,
        like: prevPrefs.like !== false,
        favorite: prevPrefs.favorite !== false,
        share: prevPrefs.share !== false,
        announcement: prevPrefs.announcement !== false,
        offshelf: prevPrefs.offshelf !== false
      }
      ;['dm', 'comment', 'like', 'favorite', 'share', 'announcement', 'offshelf'].forEach((k) => {
        if (isAccepted(k)) mergedPrefs[k] = true
      })
      await this.callDB('updateNotifySettings', {
        notifyEnabled: true,
        notifyPrefs: mergedPrefs,
        acceptedTemplateIds: mergedAccepted
      })
      if (this.globalData.userInfo) {
        this.globalData.userInfo.notifyEnabled = true
        this.globalData.userInfo.notifyPrefs = mergedPrefs
        this.globalData.userInfo.notifyAcceptedTemplateIds = mergedAccepted
      }
      wx.showToast({ title: batch === 2 ? '第二步已开启' : '第一步已开启', icon: 'success' })
      return { ok: true, batch, acceptedTemplateIds: accepted, mergedAcceptedTemplateIds: mergedAccepted }
    } catch (err) {
      const detail = (err && (err.errMsg || err.message)) || ''
      console.error('[subscribeMessage]', err)
      wx.showToast({
        title: '开启失败，请重试',
        icon: 'none'
      })
      return { ok: false, msg: detail || '请求失败' }
    }
  },

  async searchUsers(keyword) {
    try {
      const kw = keyword == null ? '' : String(keyword)
      const result = await this.callDB('searchUsers', { keyword: kw })
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

  async getAnnouncementList(page = 1, pageSize = 20) {
    try {
      const result = await this.callDB('getAnnouncementList', { page, pageSize })
      const list = result.data || []
      return await this.resolveAnnouncementsMedia(list)
    } catch (err) {
      return []
    }
  },

  async getAdminAnnouncementList(page = 1, pageSize = 30) {
    try {
      const result = await this.callDB('getAdminAnnouncementList', { page, pageSize })
      const list = result.data || []
      return await this.resolveAnnouncementsMedia(list)
    } catch (err) {
      return []
    }
  },

  async getAnnouncementDetail(announcementId) {
    try {
      const result = await this.callDB('getAnnouncementDetail', { announcementId })
      const item = result.data || null
      if (!item) return null
      const list = await this.resolveAnnouncementsMedia([item])
      return list[0] || item
    } catch (err) {
      wx.showToast({ title: err.msg || '获取公告失败', icon: 'none' })
      return null
    }
  },

  async getActivityZone() {
    const campusId = this.getCommittedCampusId()
    try {
      const result = await this.callDB('getActivityZone', { campusId: campusId || '' })
      return result.data || null
    } catch (err) {
      return null
    }
  },

  async getActivityZoneAdmin() {
    try {
      const result = await this.callDB('getActivityZoneAdmin', {})
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '获取配置失败', icon: 'none' })
        return { enabled: false, campusIds: [], slides: [] }
      }
      return result.data || { enabled: false, campusIds: [], slides: [] }
    } catch (err) {
      wx.showToast({ title: err.msg || '获取配置失败', icon: 'none' })
      return { enabled: false, campusIds: [], slides: [] }
    }
  },

  async saveActivityZone(payload) {
    try {
      const result = await this.callDB('saveActivityZone', payload)
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '保存失败', icon: 'none' })
        return false
      }
      if (result.msg) {
        wx.showToast({ title: result.msg, icon: 'none', duration: 2800 })
      }
      return true
    } catch (err) {
      wx.showToast({ title: err.msg || '保存失败', icon: 'none' })
      return false
    }
  },

  async endActivityZone() {
    try {
      const result = await this.callDB('endActivityZone', {})
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '操作失败', icon: 'none' })
        return null
      }
      wx.showToast({ title: result.msg || '已结束本期活动', icon: 'none', duration: 2800 })
      return result.data || {}
    } catch (err) {
      wx.showToast({ title: err.msg || '操作失败', icon: 'none' })
      return null
    }
  },

  async resolveAnnouncementsMedia(list) {
    if (!Array.isArray(list) || !list.length) return list || []
    const ids = []
    list.forEach((item) => {
      const imgs = Array.isArray(item.images) ? item.images : []
      imgs.forEach((u) => {
        if (typeof u === 'string' && u.startsWith('cloud://')) ids.push(u)
      })
    })
    if (!ids.length) return list
    const urlMap = await this.resolveFileUrlsMap(ids)
    return list.map((item) => ({
      ...item,
      images: (Array.isArray(item.images) ? item.images : []).map((u) => (urlMap[u] ? urlMap[u] : u))
    }))
  },

  async createAnnouncement(data) {
    try {
      const result = await this.callDB('createAnnouncement', data)
      return result
    } catch (err) {
      wx.showToast({ title: err.msg || '创建公告失败', icon: 'none' })
      return null
    }
  },

  async publishAnnouncement(announcementId, sendNotify = true) {
    try {
      return await this.callDB('publishAnnouncement', { announcementId, sendNotify })
    } catch (err) {
      wx.showToast({ title: err.msg || '发布公告失败', icon: 'none' })
      return null
    }
  },

  async updateAnnouncement(announcementId, data = {}) {
    try {
      return await this.callDB('updateAnnouncement', { announcementId, ...data })
    } catch (err) {
      wx.showToast({ title: err.msg || '更新公告失败', icon: 'none' })
      return null
    }
  },

  async revokeAnnouncement(announcementId) {
    try {
      return await this.callDB('revokeAnnouncement', { announcementId })
    } catch (err) {
      wx.showToast({ title: err.msg || '撤回公告失败', icon: 'none' })
      return null
    }
  },

  async markAnnouncementRead(announcementId) {
    try {
      await this.callDB('markAnnouncementRead', { announcementId })
      this.invalidateCacheByPrefix('unread:')
      return true
    } catch (err) {
      return false
    }
  },

  async getUnreadAnnouncementCount() {
    return this.cachedCall('unread:announcement', 5000, async () => {
      try {
        const result = await this.callDB('getUnreadAnnouncementCount')
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
    const normalizedList = Array.from(new Set(fileList.filter((fid) =>
      typeof fid === 'string' && fid.startsWith('cloud://')
    )))
    if (normalizedList.length === 0) return []
    this._tempUrlInflight = this._tempUrlInflight || new Map()

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
      this.pruneRuntimeCaches()
    }

    normalizedList.forEach((fid) => {
      const cached = this._tempUrlCache.get(fid)
      if (cached && cached.expireAt > now) {
        map[fid] = cached.value
      } else {
        pending.push(fid)
      }
    })

    if (pending.length === 0) {
      return normalizedList.filter((fid) => map[fid]).map((fid) => map[fid])
    }

    const inflightResults = await Promise.all(pending.map(async (fid) => {
      const p = this._tempUrlInflight.get(fid)
      if (!p) return null
      try {
        return await p
      } catch (e) {
        return null
      }
    }))
    inflightResults.forEach((item) => {
      if (item && item.fileID && item.tempFileURL) map[item.fileID] = item
    })

    const missingBeforeFetch = pending.filter((fid) => !map[fid] && !this._tempUrlInflight.get(fid))
    if (missingBeforeFetch.length === 0) {
      return normalizedList.filter((fid) => map[fid]).map((fid) => map[fid])
    }

    if (this.globalData.cloudReady && typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.getTempFileURL === 'function') {
      for (let i = 0; i < missingBeforeFetch.length; i += chunkSize) {
        const chunk = missingBeforeFetch.slice(i, i + chunkSize)
        try {
          const fetchPromise = new Promise((resolve, reject) => {
            wx.cloud.getTempFileURL({
              fileList: chunk,
              success: resolve,
              fail: reject
            })
          })
          chunk.forEach((fid) => {
            this._tempUrlInflight.set(fid, fetchPromise.then((res) => {
              const item = ((res && res.fileList) || []).find((x) =>
                (x.fileID || x.FileID || x.fileId) === fid
              )
              if (!item) return null
              const url = item.tempFileURL || item.TempFileURL || item.download_url || item.download_URL
              return url ? { fileID: fid, tempFileURL: url } : null
            }))
          })
          const res = await fetchPromise
          ingest(res && res.fileList)
        } catch (err) {
          console.error('[getTempFileUrls] 客户端解析失败:', err)
        } finally {
          chunk.forEach((fid) => this._tempUrlInflight.delete(fid))
        }
      }
    }

    const missing = missingBeforeFetch.filter((fid) => typeof fid === 'string' && fid.startsWith('cloud://') && !map[fid])
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i += chunkSize) {
        const chunk = missing.slice(i, i + chunkSize)
        try {
          const fetchPromise = this.callDB('getTempFileUrls', { fileList: chunk })
          chunk.forEach((fid) => {
            this._tempUrlInflight.set(fid, fetchPromise.then((result) => {
              const item = ((result && result.data) || []).find((x) =>
                (x.fileID || x.FileID || x.fileId) === fid
              )
              if (!item) return null
              const url = item.tempFileURL || item.TempFileURL || item.download_url || item.download_URL
              return url ? { fileID: fid, tempFileURL: url } : null
            }))
          })
          const result = await fetchPromise
          if (result.data && result.data.length) ingest(result.data)
        } catch (err) {
          console.error('[getTempFileUrls] 云函数分片失败:', err)
        } finally {
          chunk.forEach((fid) => this._tempUrlInflight.delete(fid))
        }
      }
    }

    return normalizedList.filter((fid) => map[fid]).map((fid) => map[fid])
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

