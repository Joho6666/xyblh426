const app = getApp()
const MARKET_CACHE_KEY = 'market_feed_cache_v1'
const MARKET_CACHE_TTL = 5 * 60 * 1000

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

  const navBottomGap = 12
  return {
    statusBarHeight,
    navBarHeight,
    navContentHeight: contentHeight,
    navBottomGap,
    navOffsetHeight: navBarHeight + navBottomGap
  }
}

function splitGoods(goods) {
  const leftCol = []
  const rightCol = []
  ;(goods || []).forEach((item, index) => {
    if (index % 2 === 0) {
      leftCol.push(item)
    } else {
      rightCol.push(item)
    }
  })
  return { leftCol, rightCol }
}

function buildMarketCacheKey(categoryIndex, searchKeyword) {
  return JSON.stringify({
    categoryIndex,
    searchKeyword: (searchKeyword || '').trim()
  })
}

function marketMediaSignature(goods) {
  return (goods || []).map((item) => [
    item && item._id,
    Array.isArray(item && item.images) ? item.images[0] : '',
    item && item.avatar
  ].join('|')).join('~')
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 64,
    navContentHeight: 44,
    navBottomGap: 12,
    navOffsetHeight: 76,
    mediaLoadedMap: {},
    currentCategory: 0,
    searchKeyword: '',
    categories: [
      { name: '全部', icon: '🛍️' },
      { name: '书籍', icon: '📚' },
      { name: '手机数码', icon: '📱' },
      { name: '电器', icon: '🔌' },
      { name: '生活用品', icon: '🧴' },
      { name: '美妆', icon: '💄' },
      { name: '男装', icon: '👕' },
      { name: '女装', icon: '👗' },
      { name: '医药', icon: '💊' },
      { name: '玩乐', icon: '🎮' },
      { name: '车品', icon: '🚲' },
      { name: '技能服务', icon: '🛠️' },
      { name: '虚拟产品', icon: '🧠' },
      { name: '餐饮', icon: '🍱' },
      { name: '其他', icon: '📦' }
    ],
    goods: [],
    leftCol: [],
    rightCol: [],
    searchLoading: false,
    loadError: '',
    loading: false,
    page: 1,
    hasMore: true,
    showSkeleton: true
  },

  onLoad() {
    this.setData(getNavMetrics())
    this.restoreCachedGoods()

    if (app.globalData.cloudReady) {
      this._initialLoadStarted = true
      this.loadGoods()
    }

    app.waitForLogin(() => {
      if (!app.globalData.isLoggedIn) return
      if (!app.ensureComplianceOnTabShow({ mode: 'browse' })) return
      if (!this._initialLoadStarted && !this.data.goods.length) {
        this._initialLoadStarted = true
        this.loadGoods()
      }
    })
  },

  getCurrentMarketCacheKey() {
    return buildMarketCacheKey(this.data.currentCategory, this.data.searchKeyword)
  },

  restoreCachedGoods() {
    try {
      const cache = wx.getStorageSync(MARKET_CACHE_KEY)
      if (!cache || !cache.data || !cache.savedAt) return
      if (Date.now() - cache.savedAt > MARKET_CACHE_TTL) return
      const entry = cache.data[this.getCurrentMarketCacheKey()]
      if (!entry || !Array.isArray(entry.goods) || !entry.goods.length) return
      const columns = splitGoods(entry.goods)
      this.setData({
        goods: entry.goods,
        leftCol: columns.leftCol,
        rightCol: columns.rightCol,
        mediaLoadedMap: {},
        hasMore: entry.hasMore !== false,
        loadError: '',
        loading: false,
        searchLoading: false,
        showSkeleton: false
      })
      this._scheduleMediaFallback(entry.goods)
    } catch (err) {
      console.warn('恢复集市缓存失败:', err)
    }
  },

  persistMarketCache(goods, hasMore) {
    try {
      const cache = wx.getStorageSync(MARKET_CACHE_KEY) || {}
      const data = cache.data || {}
      data[this.getCurrentMarketCacheKey()] = {
        goods,
        hasMore,
        savedAt: Date.now()
      }
      wx.setStorageSync(MARKET_CACHE_KEY, {
        savedAt: Date.now(),
        data
      })
    } catch (err) {
      console.warn('缓存集市数据失败:', err)
    }
  },

  onReady() {
    this.updateNavOffsetHeight()
  },

  onShow() {
    if (!app.ensureComplianceOnTabShow({ mode: 'browse' })) return
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar) {
      tabBar.setData({ selected: 1 })
      app.syncMessageBadge(tabBar)
    }

    if (!app.globalData.isLoggedIn) return

    if (app.globalData.marketNeedsRefresh) {
      app.globalData.marketNeedsRefresh = false
      this.setData({ page: 1, hasMore: true })
      this.loadGoods()
      return
    }

    if (!this.data.goods.length && !this.data.loading && !this.data.loadError) {
      this.setData({ page: 1, hasMore: true })
      this.loadGoods()
      return
    }

    const stale = this._tabHiddenAt && Date.now() - this._tabHiddenAt > 60000
    if (stale) {
      this._tabHiddenAt = 0
      this.setData({ page: 1, hasMore: true })
      this.loadGoods()
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

  _scheduleMediaFallback(goods) {
    if (this._mediaFallbackTimer) clearTimeout(this._mediaFallbackTimer)
    this._mediaFallbackTimer = setTimeout(() => {
      const map = this.data.mediaLoadedMap
      const batch = {}
      let changed = false
      ;(goods || []).forEach((g) => {
        if (g._id && !map[g._id]) {
          batch[`mediaLoadedMap.${g._id}`] = true
          changed = true
        }
      })
      if (changed) this.setData(batch)
    }, 1500)
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

  onGoodsImageLoad(e) {
    const key = e.currentTarget.dataset.id
    if (!key || this.data.mediaLoadedMap[key]) return
    if (!this._mediaBatch) this._mediaBatch = {}
    this._mediaBatch[`mediaLoadedMap.${key}`] = true
    if (this._mediaTimer) return
    this._mediaTimer = setTimeout(() => {
      this._mediaTimer = null
      const batch = this._mediaBatch
      this._mediaBatch = {}
      if (batch && Object.keys(batch).length) this.setData(batch)
    }, 80)
  },

  async loadGoods() {
    this._reqSeq = (this._reqSeq || 0) + 1
    const requestId = this._reqSeq
    const requestedPage = this.data.page
    this.latestRequestId = requestId
    this.setData({ loading: true, loadError: '' })
    const categoryName = this.data.categories[this.data.currentCategory].name
    const category = categoryName === '全部' ? '' : categoryName
    const keyword = this.data.searchKeyword

    try {
      const result = await app.callDB('getMarketGoods', {
        category,
        keyword,
        page: requestedPage,
        pageSize: 20
      })

      const items = result.data || []
      const allGoods = requestedPage === 1
        ? items
        : [...this.data.goods, ...items]
      const columns = splitGoods(allGoods)

      if (requestId !== this.latestRequestId) return

      const patch = {
        goods: allGoods,
        leftCol: columns.leftCol,
        rightCol: columns.rightCol,
        loading: false,
        searchLoading: false,
        hasMore: items.length >= 20
      }
      if (requestedPage === 1) {
        patch.mediaLoadedMap = {}
      }
      if (this.data.showSkeleton) patch.showSkeleton = false
      this.setData(patch)
      this._scheduleMediaFallback(allGoods)
      if (requestedPage === 1) {
        this.persistMarketCache(allGoods, items.length >= 20)
      }

      if (!app.globalData.cloudReady || !items.length) return

      await new Promise((r) => setTimeout(r, 0))

      let resolved
      try {
        resolved = await app.resolveFeedCardMedia(items)
      } catch (mediaErr) {
        console.warn('集市媒体地址解析失败，使用原始 URL:', mediaErr)
        resolved = items
      }

      const mergedGoods = requestedPage === 1
        ? resolved
        : [...this.data.goods.slice(0, this.data.goods.length - resolved.length), ...resolved]

      if (requestId !== this.latestRequestId) return
      if (marketMediaSignature(mergedGoods) === marketMediaSignature(allGoods)) return

      const mediaColumns = splitGoods(mergedGoods)
      this.setData({
        goods: mergedGoods,
        leftCol: mediaColumns.leftCol,
        rightCol: mediaColumns.rightCol
      })
      this._scheduleMediaFallback(mergedGoods)
      if (requestedPage === 1) {
        this.persistMarketCache(mergedGoods, items.length >= 20)
      }
    } catch (err) {
      console.error('加载商品失败:', err)
      if (requestId !== this.latestRequestId) return
      const patch = {
        loading: false,
        searchLoading: false,
        loadError: '加载商品失败'
      }
      if (this.data.showSkeleton) patch.showSkeleton = false
      if (requestedPage > 1 && this.data.page === requestedPage) {
        patch.page = requestedPage - 1
      }
      this.setData({
        ...patch
      })
    }
  },

  onCategoryTap(e) {
    this.setData({
      currentCategory: e.currentTarget.dataset.index,
      page: 1,
      hasMore: true
    })
    this.loadGoods()
  },

  onSearchInput(e) {
    const keyword = e.detail.value
    this.setData({ searchKeyword: keyword, searchLoading: true })
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }
    this.searchTimer = setTimeout(() => {
      this.setData({ page: 1, hasMore: true })
      this.loadGoods()
    }, keyword.trim() ? 250 : 0)
  },

  onSearchConfirm() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this.setData({ page: 1, hasMore: true })
    this.loadGoods()
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
    this.loadGoods()
  },

  onSearchFocus() {},

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${id}` })
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/market-post/market-post' })
  },

  onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true })
    this.loadGoods().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 })
    this.loadGoods()
  },

  onShareAppMessage() {
    return {
      title: '校园集市 - 校园便利盒',
      path: '/pages/market/market',
      imageUrl: '/images/icon_share.png'
    }
  }
})
