const app = getApp()
const campuses = require('../../utils/campuses.js')
const INDEX_CACHE_KEY = 'index_feed_cache_v1'
const INDEX_CACHE_TTL = 5 * 60 * 1000

/** 与 index.wxss 瀑布流一致：左右 padding 16rpx + 列间距 16rpx */
const WF_COL_WIDTH_RPX = (750 - 16 * 2 - 16) / 2
/** 封面展示高度上下限（过长图居中裁剪，过扁图加高并裁两侧） */
const COVER_HEIGHT_MIN_RPX = 220
const COVER_HEIGHT_MAX_RPX = 900
const COVER_HEIGHT_FALLBACK_RPX = 420
const FIRST_PAINT_POSTS = 8
/** 与 app.js getPosts pageSize 保持一致：不足一页就视为没有更多 */
const PAGE_SIZE = 12
const ANNOUNCEMENT_DISMISS_KEY = 'announcement_modal_dismiss_v1'
const SUBSCRIBE_GUIDE_SHOWN_KEY = 'subscribe_guide_shown_v1'

function clampCoverHeightRpx(naturalW, naturalH) {
  if (!naturalW || !naturalH) return COVER_HEIGHT_FALLBACK_RPX
  const raw = WF_COL_WIDTH_RPX * (naturalH / naturalW)
  return Math.round(
    Math.max(COVER_HEIGHT_MIN_RPX, Math.min(COVER_HEIGHT_MAX_RPX, raw))
  )
}

function getNavMetrics() {
  let statusBarHeight = 20
  if (typeof wx.getWindowInfo === 'function') {
    const wi = wx.getWindowInfo()
    statusBarHeight = wi.statusBarHeight || 20
  } else {
    try {
      statusBarHeight = wx.getSystemInfoSync().statusBarHeight || 20
    } catch (e) {
      statusBarHeight = 20
    }
  }
  const menuButton = wx.getMenuButtonBoundingClientRect
    ? wx.getMenuButtonBoundingClientRect()
    : null
  const topGap = menuButton ? Math.max(menuButton.top - statusBarHeight, 8) : 10
  const contentHeight = menuButton ? menuButton.height + topGap * 2 : 44
  const navBarHeight = statusBarHeight + contentHeight

  return {
    statusBarHeight,
    navBarHeight,
    navContentHeight: contentHeight,
    navOffsetHeight: navBarHeight + 12,
    navBottomGap: 12
  }
}

function firstCoverSrc(post) {
  if (!post) return ''
  const t = post.thumbImages
  if (Array.isArray(t) && t.length) {
    const u = String(t[0] || '').trim()
    if (u) return u
  }
  const imgs = post.images
  if (Array.isArray(imgs) && imgs.length) {
    const u = String(imgs[0] || '').trim()
    if (u) return u
  }
  return ''
}

function formatPosts(posts) {
  return (posts || []).map((post) => ({
    ...post,
    time: app.formatTime(post.createTime),
    _coverSrc: firstCoverSrc(post)
  }))
}

function splitPosts(posts) {
  const leftCol = []
  const rightCol = []
  ;(posts || []).forEach((post, index) => {
    if (index % 2 === 0) {
      leftCol.push(post)
    } else {
      rightCol.push(post)
    }
  })
  return { leftCol, rightCol }
}

function feedMediaSignature(posts) {
  return (posts || []).map((post) => [
    post && post._id,
    firstCoverSrc(post),
    post && post.avatar,
    Array.isArray(post && post.videos) ? post.videos[0] : ''
  ].join('|')).join('~')
}

function buildFeedCacheKey(feedType, currentCategory, searchKeyword, campusId) {
  return JSON.stringify({
    feedType,
    currentCategory,
    searchKeyword: (searchKeyword || '').trim(),
    campusId: campusId || ''
  })
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 64,
    navContentHeight: 44,
    navOffsetHeight: 76,
    navBottomGap: 12,
    feedType: 'discover',
    currentCategory: 0,
    searchKeyword: '',
    categories: ['全部', '树洞', '求助', '找搭子', '校园生活', '学术交流', '失物招领', '社团活动', '校园活动', '其他'],
    posts: [],
    leftCol: [],
    rightCol: [],
    mediaLoadedMap: {},
    coverHeightsMap: {},
    searchLoading: false,
    loadError: '',
    loading: false,
    page: 1,
    hasMore: true,
    showSplash: true,
    splashHidden: false,
    showSkeleton: true,
    selectedCampusId: '',
    selectedCampusName: '',
    showCampusPicker: false,
    campusQuery: '',
    campusPickerList: [],
    latestAnnouncement: null,
    showAnnouncementModal: false,
    modalAnnouncement: null,
    showSubscribeGuideModal: false,
    subscribeGuideSubmitting: false,
    subscribeGuideStep: 1
  },

  onLoad(options) {
    app.savePromoFromOptions(options || {})
    this.setData(getNavMetrics())
    this._syncCampusUiFromApp()
    this.restoreCachedFeed()

    app.waitForLogin(() => {
      if (!app.globalData.isLoggedIn) {
        this._dismissSplash()
        if (this.data.showSkeleton) this.setData({ showSkeleton: false })
        if (app.globalData.cloudReady) {
          wx.showToast({ title: '登录失败，请下拉刷新', icon: 'none' })
        }
        return
      }
      if (!app.ensureComplianceOnTabShow({ mode: 'browse' })) return
      if (!app.hasSelectedCampusInStorage()) {
        this.setData({
          showCampusPicker: true,
          campusQuery: '',
          campusPickerList: campuses.filterCampusesByQuery('')
        })
        this._dismissSplash()
        if (this.data.showSkeleton) this.setData({ showSkeleton: false })
        return
      }
      this._syncCampusUiFromApp()
      this._maybeShowSubscribeGuideModal()
      this.loadLatestAnnouncement()
      this.loadPosts()
    })
  },

  _syncCampusUiFromApp() {
    if (!app.hasSelectedCampusInStorage()) {
      this.setData({
        selectedCampusId: '',
        selectedCampusName: ''
      })
      return
    }
    this.setData({
      selectedCampusId: app.getCommittedCampusId(),
      selectedCampusName: app.getSelectedCampusName(),
      showCampusPicker: false
    })
  },

  preventCampusMove() {},

  onCampusSearch(e) {
    const campusQuery = e.detail.value || ''
    this.setData({ campusQuery })
    if (this._campusSearchTimer) {
      clearTimeout(this._campusSearchTimer)
    }
    this._campusSearchTimer = setTimeout(() => {
      this._campusSearchTimer = null
      this.setData({ campusPickerList: campuses.filterCampusesByQuery(campusQuery) })
    }, 80)
  },

  onCampusSearchConfirm() {
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard()
  },

  onClearCampusSearch() {
    this.setData({
      campusQuery: '',
      campusPickerList: campuses.filterCampusesByQuery('')
    })
  },

  onOpenCampusPicker() {
    const q = this.data.campusQuery || ''
    this.setData({
      showCampusPicker: true,
      campusPickerList: campuses.filterCampusesByQuery(q)
    })
  },

  async onPickCampus(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    await app.setSelectedCampus(id, { syncCloud: true })
    this.setData({
      selectedCampusId: id,
      selectedCampusName: app.getSelectedCampusName(),
      showCampusPicker: false,
      page: 1,
      hasMore: true
    })
    this.loadLatestAnnouncement()
    this.loadPosts()
  },

  async loadLatestAnnouncement() {
    try {
      const list = await app.getAnnouncementList(1, 1)
      const latest = list.length ? list[0] : null
      this.setData({ latestAnnouncement: latest })
      this._maybeShowAnnouncementModal(latest)
    } catch (e) {
      this.setData({ latestAnnouncement: null, showAnnouncementModal: false, modalAnnouncement: null })
    }
  },

  _maybeShowAnnouncementModal(latest) {
    if (!latest || !latest._id) {
      this.setData({ showAnnouncementModal: false, modalAnnouncement: null })
      return
    }
    let dismissedId = ''
    try {
      dismissedId = String(wx.getStorageSync(ANNOUNCEMENT_DISMISS_KEY) || '')
    } catch (e) {}
    if (dismissedId === latest._id) {
      this.setData({ showAnnouncementModal: false, modalAnnouncement: null })
      return
    }
    this.setData({ showAnnouncementModal: true, modalAnnouncement: latest })
  },

  onCloseAnnouncementModal() {
    const item = this.data.modalAnnouncement
    if (item && item._id) {
      try {
        wx.setStorageSync(ANNOUNCEMENT_DISMISS_KEY, item._id)
      } catch (e) {}
    }
    this.setData({ showAnnouncementModal: false })
  },

  onTapAnnouncementMask() {
    this.onCloseAnnouncementModal()
  },

  onOpenAnnouncementFromModal() {
    const item = this.data.modalAnnouncement
    if (item && item._id) {
      app.markAnnouncementRead(item._id)
    }
    this.setData({ showAnnouncementModal: false })
    this.onOpenAnnouncement()
  },

  _maybeShowSubscribeGuideModal() {
    let shown = false
    try {
      shown = !!wx.getStorageSync(SUBSCRIBE_GUIDE_SHOWN_KEY)
    } catch (e) {}
    if (shown) return
    const step = this._resolveSubscribeGuideStep()
    if (step === 0) {
      try { wx.setStorageSync(SUBSCRIBE_GUIDE_SHOWN_KEY, 1) } catch (e) {}
      return
    }
    this.setData({ showSubscribeGuideModal: true, subscribeGuideStep: step })
    try { wx.setStorageSync(SUBSCRIBE_GUIDE_SHOWN_KEY, 1) } catch (e) {}
  },

  _resolveSubscribeGuideStep() {
    const userInfo = app.globalData.userInfo || {}
    const prefs = userInfo.notifyPrefs || {}
    const isOn = (key) => userInfo.notifyEnabled === true && prefs[key] !== false
    const batch1Ready = isOn('like') && isOn('dm') && isOn('comment')
    const batch2Ready = isOn('favorite') && isOn('share') && isOn('offshelf')
    if (!batch1Ready) return 1
    if (!batch2Ready) return 2
    return 0
  },

  onCloseSubscribeGuideModal() {
    if (this.data.subscribeGuideSubmitting) return
    this.setData({ showSubscribeGuideModal: false })
  },

  async onEnableSubscribeFromGuide() {
    if (this.data.subscribeGuideSubmitting) return
    this.setData({ subscribeGuideSubmitting: true })
    try {
      const step = this.data.subscribeGuideStep === 2 ? 2 : 1
      const result = await app.enableSubscribeNotificationsFromClient({ batch: step })
      if (result && result.ok) {
        if (step === 1) {
          const nextStep = this._resolveSubscribeGuideStep()
          if (nextStep === 2) {
            this.setData({ subscribeGuideStep: 2 })
            wx.showToast({ title: '请继续完成第2步', icon: 'none' })
          } else {
            this.setData({ showSubscribeGuideModal: false })
          }
        } else {
          this.setData({ showSubscribeGuideModal: false })
        }
      }
    } finally {
      this.setData({ subscribeGuideSubmitting: false })
    }
  },

  onReady() {
    this.updateNavOffsetHeight()
    setTimeout(() => { this._dismissSplash() }, 3000)
  },

  _dismissSplash() {
    if (!this.data.showSplash || this._splashDismissed) return
    this._splashDismissed = true
    this.setData({ splashHidden: true })
    setTimeout(() => { this.setData({ showSplash: false }) }, 500)
  },

  _scheduleMediaFallback(posts) {
    if (this._mediaFallbackTimer) clearTimeout(this._mediaFallbackTimer)
    // 用最近一次的 ids 做指纹，避免连续多次 setData/_scheduleMediaFallback 排队后再扫一次
    const ids = (posts || []).map((p) => p && p._id).filter(Boolean).join(',')
    this._mediaFallbackSig = ids
    const sig = ids
    this._mediaFallbackTimer = setTimeout(() => {
      this._mediaFallbackTimer = null
      if (this._mediaFallbackSig !== sig) return
      const map = this.data.mediaLoadedMap
      const batch = {}
      let changed = false
      ;(posts || []).forEach((p) => {
        if (p && p._id && !map[p._id]) {
          batch[`mediaLoadedMap.${p._id}`] = true
          batch[`coverHeightsMap.${p._id}`] = COVER_HEIGHT_FALLBACK_RPX
          changed = true
        }
      })
      if (changed) this.setData(batch)
    }, 1500)
  },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar) {
      tabBar.setData({ selected: 0 })
      app.syncMessageBadge(tabBar)
    }

    if (!app.ensureComplianceOnTabShow({ mode: 'browse' })) return

    if (!app.globalData.isLoggedIn) return

    if (!app.hasSelectedCampusInStorage()) {
      this.setData({
        showCampusPicker: true,
        campusPickerList: campuses.filterCampusesByQuery(this.data.campusQuery || '')
      })
      return
    }
    this._syncCampusUiFromApp()
    this._maybeShowSubscribeGuideModal()
    this.loadLatestAnnouncement()

    if (app.globalData.indexFeedNeedsRefresh) {
      app.globalData.indexFeedNeedsRefresh = false
      this.setData({ page: 1, hasMore: true })
      this.loadPosts()
      return
    }

    if (!this.data.posts.length && !this.data.loading && !this.data.loadError) {
      this.setData({ page: 1, hasMore: true })
      this.loadPosts()
      return
    }

    const stale = this._tabHiddenAt && Date.now() - this._tabHiddenAt > 60000
    if (stale) {
      this._tabHiddenAt = 0
      this.setData({ page: 1, hasMore: true })
      this.loadPosts()
    }
  },

  onHide() {
    this._tabHiddenAt = Date.now()
  },

  onUnload() {
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null }
    if (this._campusSearchTimer) { clearTimeout(this._campusSearchTimer); this._campusSearchTimer = null }
    if (this._mediaFallbackTimer) { clearTimeout(this._mediaFallbackTimer); this._mediaFallbackTimer = null }
    if (this._mediaTimer) { clearTimeout(this._mediaTimer); this._mediaTimer = null }
  },

  updateNavOffsetHeight() {
    wx.nextTick(() => {
      const query = this.createSelectorQuery()
      query.select('.nav-bar').boundingClientRect()
      query.exec((res) => {
        const rect = res && res[0]
        if (!rect || !rect.height) return
        const navOffsetHeight = Math.ceil(rect.height) + this.data.navBottomGap
        if (navOffsetHeight !== this.data.navOffsetHeight) {
          this.setData({ navOffsetHeight })
        }
      })
    })
  },

  getCurrentFeedCacheKey() {
    return buildFeedCacheKey(
      this.data.feedType,
      this.data.currentCategory,
      this.data.searchKeyword,
      app.getCommittedCampusId() || ''
    )
  },

  restoreCachedFeed() {
    try {
      const cache = wx.getStorageSync(INDEX_CACHE_KEY)
      if (!cache || !cache.data || !cache.savedAt) return
      if (Date.now() - cache.savedAt > INDEX_CACHE_TTL) return
      const currentKey = this.getCurrentFeedCacheKey()
      const entry = cache.data[currentKey]
      if (!entry || !Array.isArray(entry.posts) || !entry.posts.length) return
      const restored = formatPosts(entry.posts)
      const columns = splitPosts(restored)
      // 缓存恢复时图片大概率已经命中本地解码缓存，不重置 mediaLoadedMap，
      // 让卡片首帧不出现“占位骨架→真图”闪烁
      this.setData({
        posts: restored,
        leftCol: columns.leftCol,
        rightCol: columns.rightCol,
        hasMore: entry.hasMore !== false,
        loadError: '',
        loading: false,
        searchLoading: false,
        showSkeleton: false
      })
      this._dismissSplash()
      this._scheduleMediaFallback(entry.posts)
    } catch (err) {
      console.warn('恢复首页缓存失败:', err)
    }
  },

  persistFeedCache(posts, hasMore) {
    try {
      const cache = wx.getStorageSync(INDEX_CACHE_KEY) || {}
      const data = cache.data || {}
      data[this.getCurrentFeedCacheKey()] = {
        posts,
        hasMore,
        savedAt: Date.now()
      }
      wx.setStorageSync(INDEX_CACHE_KEY, {
        savedAt: Date.now(),
        data
      })
    } catch (err) {
      console.warn('缓存首页数据失败:', err)
    }
  },

  async loadPosts(options = {}) {
    const requestedPage = Number(options.page || this.data.page || 1)
    this._reqSeq = (this._reqSeq || 0) + 1
    const requestId = this._reqSeq
    this.latestRequestId = requestId
    if (!this.data.loading || this.data.loadError) {
      this.setData({ loading: true, loadError: '' })
    }

    try {
      const category = this.data.categories[this.data.currentCategory]
      const keyword = this.data.searchKeyword
      const posts = await app.getPosts(category, keyword, requestedPage, this.data.feedType)
      const basePosts = formatPosts(posts)
      const allPosts = requestedPage === 1
        ? basePosts
        : [...this.data.posts, ...basePosts]
      const columns = splitPosts(allPosts)

      if (requestId !== this.latestRequestId) return

      const patch = {
        posts: allPosts,
        leftCol: columns.leftCol,
        rightCol: columns.rightCol,
        page: requestedPage,
        loading: false,
        searchLoading: false,
        hasMore: posts.length >= PAGE_SIZE
      }
      if (requestedPage === 1) {
        patch.mediaLoadedMap = {}
        patch.coverHeightsMap = {}
      }
      if (this.data.showSkeleton) patch.showSkeleton = false
      const shouldChunkFirstPaint = requestedPage === 1 && allPosts.length > FIRST_PAINT_POSTS
      if (shouldChunkFirstPaint) {
        const firstPaintPosts = allPosts.slice(0, FIRST_PAINT_POSTS)
        const firstPaintCols = splitPosts(firstPaintPosts)
        const firstPatch = {
          ...patch,
          posts: firstPaintPosts,
          leftCol: firstPaintCols.leftCol,
          rightCol: firstPaintCols.rightCol
        }
        this.setData(firstPatch)
        this._dismissSplash()
        this._scheduleMediaFallback(firstPaintPosts)
        await new Promise((r) => setTimeout(r, 0))
        if (requestId !== this.latestRequestId) return
        this.setData({
          posts: allPosts,
          leftCol: columns.leftCol,
          rightCol: columns.rightCol
        })
      } else {
        this.setData(patch)
        this._dismissSplash()
      }
      this._scheduleMediaFallback(allPosts)
      if (requestedPage === 1) {
        this.persistFeedCache(allPosts, posts.length >= PAGE_SIZE)
      }

      if (!app.globalData.cloudReady || !posts.length) return

      await new Promise((r) => setTimeout(r, 0))

      let withMedia
      try {
        withMedia = await app.resolveFeedCardMedia(posts)
      } catch (mediaErr) {
        console.warn('媒体地址解析失败，使用原始 URL:', mediaErr)
        withMedia = posts
      }
      if (requestId !== this.latestRequestId) return

      const formattedMediaPosts = formatPosts(withMedia)
      const mergedPosts = requestedPage === 1
        ? formattedMediaPosts
        : [...allPosts.slice(0, allPosts.length - formattedMediaPosts.length), ...formattedMediaPosts]

      if (feedMediaSignature(mergedPosts) === feedMediaSignature(allPosts)) return

      const mediaColumns = splitPosts(mergedPosts)

      this.setData({
        posts: mergedPosts,
        leftCol: mediaColumns.leftCol,
        rightCol: mediaColumns.rightCol
      })
      this._scheduleMediaFallback(mergedPosts)
      if (requestedPage === 1) {
        this.persistFeedCache(mergedPosts, posts.length >= PAGE_SIZE)
      }
    } catch (err) {
      console.error('加载帖子失败:', err)
      if (requestId !== this.latestRequestId) return
      const raw = (err && (err.msg || err.errMsg || err.message)) || ''
      const needRedeploy =
        /504002|FUNCTIONS_EXECUTE_FAIL|execute fail|SyntaxError/i.test(String(raw))
      let loadError = raw && String(raw).length < 120 ? String(raw) : '加载失败，请下拉刷新重试'
      if (needRedeploy) {
        loadError = '云端服务需更新：请在微信开发者工具中对云函数 dbOperations 右键「上传并部署：云端安装依赖」，部署完成后下拉刷新本页。'
      }
      const patch = {
        loading: false,
        searchLoading: false,
        loadError
      }
      if (this.data.showSkeleton) patch.showSkeleton = false
      this.setData(patch)
      this._dismissSplash()
    }
  },

  _reloadFirstPage(extraPatch = {}) {
    this.setData({ page: 1, hasMore: true, ...extraPatch })
    this.loadPosts({ page: 1 })
  },

  onOpenActivityZone() {
    if (!app.globalData.isLoggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    if (!app.ensureComplianceOnTabShow({ mode: 'browse' })) return
    if (!app.hasSelectedCampusInStorage()) {
      wx.showToast({ title: '请先选择校区', icon: 'none' })
      this.setData({
        showCampusPicker: true,
        campusPickerList: campuses.filterCampusesByQuery(this.data.campusQuery || '')
      })
      return
    }
    wx.navigateTo({ url: '/pages/activity/activity' })
  },

  onFeedSwitch(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.feedType) return
    if (type === 'follow' && !app.requestComplianceForAction()) return
    this._reloadFirstPage({ feedType: type })
  },

  onCategoryTap(e) {
    const index = e.currentTarget.dataset.index
    if (index === this.data.currentCategory) return
    this._reloadFirstPage({ currentCategory: index })
  },

  onSearchInput(e) {
    const keyword = e.detail.value
    const patch = { searchKeyword: keyword }
    if (!this.data.searchLoading) patch.searchLoading = true
    this.setData(patch)
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }
    this.searchTimer = setTimeout(() => {
      this._reloadFirstPage()
    }, keyword.trim() ? 250 : 0)
  },

  onSearchConfirm() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this._reloadFirstPage()
  },

  onClearSearch() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this._reloadFirstPage({
      searchKeyword: '',
      searchLoading: true
    })
  },

  onSearchFocus() {},

  onMediaLoad(e) {
    const key = e.currentTarget.dataset.key
    if (!key || this.data.mediaLoadedMap[key]) return
    const d = e.detail || {}
    const hRpx = clampCoverHeightRpx(d.width, d.height)
    if (!this._mediaBatch) this._mediaBatch = {}
    this._mediaBatch[`mediaLoadedMap.${key}`] = true
    this._mediaBatch[`coverHeightsMap.${key}`] = hRpx
    if (this._mediaTimer) return
    this._mediaTimer = setTimeout(() => {
      this._mediaTimer = null
      const batch = this._mediaBatch
      this._mediaBatch = {}
      if (batch && Object.keys(batch).length) this.setData(batch)
    }, 80)
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  _findCardPath(id) {
    const li = this.data.leftCol.findIndex((p) => p._id === id)
    if (li !== -1) return { col: 'leftCol', idx: li }
    const ri = this.data.rightCol.findIndex((p) => p._id === id)
    if (ri !== -1) return { col: 'rightCol', idx: ri }
    return null
  },

  async onFavorTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this._favorBusyMap = this._favorBusyMap || {}
    if (this._favorBusyMap[id]) return
    if (!app.requestComplianceForAction()) return

    const loc = this._findCardPath(id)
    const snapshot = loc ? !!this.data[loc.col][loc.idx].isFavored : null
    if (loc) {
      this.setData({ [`${loc.col}[${loc.idx}].isFavored`]: !snapshot })
    }
    this._favorBusyMap[id] = true
    try {
      const next = await app.toggleFavorPost(id)
      if (next === null) {
        if (loc) this.setData({ [`${loc.col}[${loc.idx}].isFavored`]: snapshot })
        return
      }
      // 服务器结果与乐观一致就不重设，省一次 setData
      if (loc && next !== !snapshot) {
        this.setData({ [`${loc.col}[${loc.idx}].isFavored`]: next })
      }
      wx.showToast({ title: next ? '已收藏' : '已取消收藏', icon: 'none' })
    } catch (err) {
      if (loc) this.setData({ [`${loc.col}[${loc.idx}].isFavored`]: snapshot })
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      delete this._favorBusyMap[id]
    }
  },

  async onLikeTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this._likeBusyMap = this._likeBusyMap || {}
    if (this._likeBusyMap[id]) return
    if (!app.requestComplianceForAction()) return

    const loc = this._findCardPath(id)
    const snapshot = loc
      ? { isLiked: !!this.data[loc.col][loc.idx].isLiked, likes: this.data[loc.col][loc.idx].likes || 0 }
      : null
    if (loc && snapshot) {
      const optimisticLiked = !snapshot.isLiked
      this.setData({
        [`${loc.col}[${loc.idx}].isLiked`]: optimisticLiked,
        [`${loc.col}[${loc.idx}].likes`]: Math.max(0, snapshot.likes + (optimisticLiked ? 1 : -1))
      })
    }
    this._likeBusyMap[id] = true
    try {
      const result = await app.toggleLikePost(id)
      if (!result) {
        if (loc && snapshot) {
          this.setData({
            [`${loc.col}[${loc.idx}].isLiked`]: snapshot.isLiked,
            [`${loc.col}[${loc.idx}].likes`]: snapshot.likes
          })
        }
        return
      }
      if (loc && snapshot) {
        let newLikes = snapshot.likes
        if (result.isLiked && !snapshot.isLiked) newLikes = snapshot.likes + 1
        else if (!result.isLiked && snapshot.isLiked) newLikes = Math.max(0, snapshot.likes - 1)
        this.setData({
          [`${loc.col}[${loc.idx}].isLiked`]: result.isLiked,
          [`${loc.col}[${loc.idx}].likes`]: newLikes
        })
      }
    } catch (err) {
      if (loc && snapshot) {
        this.setData({
          [`${loc.col}[${loc.idx}].isLiked`]: snapshot.isLiked,
          [`${loc.col}[${loc.idx}].likes`]: snapshot.likes
        })
      }
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      delete this._likeBusyMap[id]
    }
  },

  onPullDownRefresh() {
    this.loadLatestAnnouncement()
    this.loadPosts({ page: 1 }).finally(() => wx.stopPullDownRefresh())
  },

  onOpenAnnouncement() {
    wx.navigateTo({ url: '/pages/announcement/announcement' })
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.loadPosts({ page: this.data.page + 1 })
  },

  onShareAppMessage() {
    return {
      title: '发现校园新鲜事 - 校园便利盒',
      path: '/pages/index/index',
      imageUrl: '/images/icon_share.png'
    }
  },

  onShareTimeline() {
    return {
      title: '发现校园新鲜事 - 校园便利盒',
      imageUrl: '/images/icon_share.png'
    }
  }
})
