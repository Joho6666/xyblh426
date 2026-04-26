const app = getApp()
const INDEX_CACHE_KEY = 'index_feed_cache_v1'
const INDEX_CACHE_TTL = 5 * 60 * 1000

/** 与 index.wxss 瀑布流一致：左右 padding 12rpx + 列间距 12rpx */
const WF_COL_WIDTH_RPX = (750 - 12 * 2 - 12) / 2
/** 封面展示高度上下限（过长图居中裁剪，过扁图加高并裁两侧） */
const COVER_HEIGHT_MIN_RPX = 220
const COVER_HEIGHT_MAX_RPX = 900
const COVER_HEIGHT_FALLBACK_RPX = 420

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

function buildFeedCacheKey(feedType, currentCategory, searchKeyword) {
  return JSON.stringify({
    feedType,
    currentCategory,
    searchKeyword: (searchKeyword || '').trim()
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
    categories: ['全部', '树洞', '求助', '找搭子', '校园生活', '学术交流', '失物招领', '社团活动', '其他'],
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
    showSkeleton: true
  },

  onLoad(options) {
    app.saveInviteSceneIfPresent(options || {})
    this.setData(getNavMetrics())
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
      this.loadPosts()
    })
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
    this._mediaFallbackTimer = setTimeout(() => {
      const map = this.data.mediaLoadedMap
      const batch = {}
      let changed = false
      ;(posts || []).forEach((p) => {
        if (p._id && !map[p._id]) {
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
      this.data.searchKeyword
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
      this.setData({
        posts: restored,
        leftCol: columns.leftCol,
        rightCol: columns.rightCol,
        mediaLoadedMap: {},
        coverHeightsMap: {},
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

  async loadPosts() {
    this._reqSeq = (this._reqSeq || 0) + 1
    const requestId = this._reqSeq
    const requestedPage = this.data.page
    this.latestRequestId = requestId
    this.setData({ loading: true, loadError: '' })

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
        loading: false,
        searchLoading: false,
        hasMore: posts.length >= 20
      }
      if (requestedPage === 1) {
        patch.mediaLoadedMap = {}
        patch.coverHeightsMap = {}
      }
      if (this.data.showSkeleton) patch.showSkeleton = false
      this.setData(patch)
      this._dismissSplash()
      this._scheduleMediaFallback(allPosts)
      if (requestedPage === 1) {
        this.persistFeedCache(allPosts, posts.length >= 20)
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
      const formattedMediaPosts = formatPosts(withMedia)
      const mergedPosts = requestedPage === 1
        ? formattedMediaPosts
        : [...this.data.posts.slice(0, this.data.posts.length - formattedMediaPosts.length), ...formattedMediaPosts]

      if (requestId !== this.latestRequestId) return
      if (feedMediaSignature(mergedPosts) === feedMediaSignature(allPosts)) return

      const mediaColumns = splitPosts(mergedPosts)

      this.setData({
        posts: mergedPosts,
        leftCol: mediaColumns.leftCol,
        rightCol: mediaColumns.rightCol
      })
      this._scheduleMediaFallback(mergedPosts)
      if (requestedPage === 1) {
        this.persistFeedCache(mergedPosts, posts.length >= 20)
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
      if (requestedPage > 1 && this.data.page === requestedPage) {
        patch.page = requestedPage - 1
      }
      this.setData(patch)
      this._dismissSplash()
    }
  },

  onFeedSwitch(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.feedType) return
    if (type === 'follow' && !app.requestComplianceForAction()) return
    this.setData({ feedType: type, page: 1, hasMore: true })
    this.loadPosts()
  },

  onCategoryTap(e) {
    const index = e.currentTarget.dataset.index
    if (index === this.data.currentCategory) return
    this.setData({ currentCategory: index, page: 1, hasMore: true })
    this.loadPosts()
  },

  onSearchInput(e) {
    const keyword = e.detail.value
    this.setData({ searchKeyword: keyword, searchLoading: true })
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }
    this.searchTimer = setTimeout(() => {
      this.setData({ page: 1, hasMore: true })
      this.loadPosts()
    }, keyword.trim() ? 250 : 0)
  },

  onSearchConfirm() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this.setData({ page: 1, hasMore: true })
    this.loadPosts()
  },

  onClearSearch() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this.setData({
      searchKeyword: '',
      searchLoading: true,
      page: 1,
      hasMore: true
    })
    this.loadPosts()
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
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
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
    if (this._favorBusy) return
    if (!app.requestComplianceForAction()) return
    this._favorBusy = true
    try {
      const next = await app.toggleFavorPost(id)
      if (next === null) { this._favorBusy = false; return }
      const loc = this._findCardPath(id)
      if (loc) {
        this.setData({ [`${loc.col}[${loc.idx}].isFavored`]: next })
      }
      wx.showToast({ title: next ? '已收藏' : '已取消收藏', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      this._favorBusy = false
    }
  },

  async onLikeTap(e) {
    const id = e.currentTarget.dataset.id
    if (this._likeBusy) return
    if (!app.requestComplianceForAction()) return
    this._likeBusy = true
    try {
      const result = await app.toggleLikePost(id)
      if (!result) { this._likeBusy = false; return }
      const loc = this._findCardPath(id)
      if (loc) {
        const cur = this.data[loc.col][loc.idx]
        this.setData({
          [`${loc.col}[${loc.idx}].isLiked`]: result.isLiked,
          [`${loc.col}[${loc.idx}].likes`]: Math.max(0, (cur.likes || 0) + (result.isLiked ? 1 : -1))
        })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      this._likeBusy = false
    }
  },

  onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true })
    this.loadPosts().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 })
    this.loadPosts()
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
