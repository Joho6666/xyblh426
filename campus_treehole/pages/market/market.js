const app = getApp()
const { MARKET_BROWSE_CATEGORIES } = require('../../utils/marketCategories')
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

function buildMarketCacheKey(categoryIndex, searchKeyword, campusId) {
  return JSON.stringify({
    categoryIndex,
    searchKeyword: (searchKeyword || '').trim(),
    campusId: campusId || ''
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
    categories: MARKET_BROWSE_CATEGORIES,
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
    const maxIdx = (this.data.categories || []).length - 1
    if (maxIdx >= 0 && this.data.currentCategory > maxIdx) {
      this.setData({ currentCategory: 0 })
    }
    this.restoreCachedGoods()

    if (app.globalData.cloudReady && app.hasSelectedCampusInStorage()) {
      this._initialLoadStarted = true
      this.loadGoods()
    }

    app.waitForLogin(() => {
      if (!app.globalData.isLoggedIn) return
      if (!app.ensureComplianceOnTabShow({ mode: 'browse' })) return
      if (!app.hasSelectedCampusInStorage()) {
        this.setData({
          goods: [],
          leftCol: [],
          rightCol: [],
          loading: false,
          showSkeleton: false,
          loadError: '请先在「首页」选择校区后即可浏览本校闲置'
        })
        return
      }
      if (!this._initialLoadStarted && !this.data.goods.length) {
        this._initialLoadStarted = true
        this.loadGoods()
      }
    })
  },

  getCurrentMarketCacheKey() {
    const cid = app.getCommittedCampusId() || ''
    return buildMarketCacheKey(this.data.currentCategory, this.data.searchKeyword, cid)
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

    if (!app.hasSelectedCampusInStorage()) {
      this.setData({
        goods: [],
        leftCol: [],
        rightCol: [],
        loading: false,
        showSkeleton: false,
        loadError: '请先在「首页」选择校区后即可浏览本校闲置'
      })
      return
    }

    if (this.data.loadError && this.data.loadError.indexOf('选择校区') !== -1) {
      this.setData({ loadError: '', page: 1, hasMore: true })
      this.loadGoods()
      return
    }

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
    const sig = (goods || []).map((g) => g && g._id).filter(Boolean).join(',')
    this._mediaFallbackSig = sig
    this._mediaFallbackTimer = setTimeout(() => {
      this._mediaFallbackTimer = null
      if (this._mediaFallbackSig !== sig) return
      const map = this.data.mediaLoadedMap
      const batch = {}
      let changed = false
      ;(goods || []).forEach((g) => {
        if (g && g._id && !map[g._id]) {
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

  async loadGoods(options = {}) {
    const campusId = app.getCommittedCampusId()
    if (!campusId) {
      this.setData({
        loading: false,
        loadError: '请先在「首页」选择校区后即可浏览本校闲置',
        showSkeleton: false
      })
      return
    }

    this._reqSeq = (this._reqSeq || 0) + 1
    const requestId = this._reqSeq
    const requestedPage = Number(options.page || this.data.page || 1)
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
        pageSize: 20,
        campusId
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

      if (requestId !== this.latestRequestId) return

      const mergedGoods = requestedPage === 1
        ? resolved
        : [...allGoods.slice(0, allGoods.length - resolved.length), ...resolved]

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
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isFinite(index)) return
    if (index === this.data.currentCategory) return
    this.setData({
      currentCategory: index,
      page: 1,
      hasMore: true
    })
    this.loadGoods({ page: 1 })
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
    if (!id) return
    wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${encodeURIComponent(id)}` })
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
    const nextPage = (this.data.page || 1) + 1
    this.setData({ page: nextPage })
    this.loadGoods({ page: nextPage })
  },

  onShareAppMessage() {
    return {
      title: '校园集市 - 校园便利盒',
      path: '/pages/market/market',
      imageUrl: '/images/icon_share.png'
    }
  }
})
