const app = getApp()

const WF_COL_WIDTH_RPX = (750 - 16 * 2 - 16) / 2
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
    if (index % 2 === 0) leftCol.push(post)
    else rightCol.push(post)
  })
  return { leftCol, rightCol }
}

Page({
  data: {
    zoneSlides: [],
    showDetail: false,
    detailSlide: null,
    posts: [],
    leftCol: [],
    rightCol: [],
    mediaLoadedMap: {},
    coverHeightsMap: {},
    searchKeyword: '',
    loading: false,
    loadError: '',
    page: 1,
    hasMore: true,
    searchLoading: false
  },

  onLoad() {
    this._zoneFirstShow = true
    app.waitForLogin(() => this.boot())
  },

  onShow() {
    if (this._zoneFirstShow) {
      this._zoneFirstShow = false
      return
    }
    if (app.globalData.isLoggedIn && app.hasSelectedCampusInStorage()) {
      this.loadZone()
    }
  },

  onUnload() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
  },

  boot() {
    if (!app.globalData.isLoggedIn) return
    if (!app.ensureComplianceOnTabShow({ mode: 'browse' })) return
    if (!app.hasSelectedCampusInStorage()) {
      wx.showToast({ title: '请先在首页选择校区', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1600)
      return
    }
    this.loadZone()
    this.setData({ page: 1, hasMore: true })
    this.loadPosts({ page: 1 })
  },

  async loadZone() {
    const zone = await app.getActivityZone()
    if (!zone || !zone.slides || !zone.slides.length) {
      this.setData({ zoneSlides: [] })
      return
    }
    const ids = zone.slides.map((s) => s.image).filter(Boolean)
    const map = ids.length ? await app.resolveFileUrlsMap(ids) : {}
    const zoneSlides = zone.slides.map((s) => ({
      ...s,
      displayImage: (s.image && map[s.image]) || s.image || ''
    }))
    this.setData({ zoneSlides })
  },

  onBannerTap(e) {
    const idx = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(idx)) return
    const slide = this.data.zoneSlides[idx]
    if (!slide) return
    this.setData({ detailSlide: slide, showDetail: true })
  },

  onCloseDetail() {
    this.setData({ showDetail: false, detailSlide: null })
  },

  noop() {},

  async loadPosts(options = {}) {
    const requestedPage = Number(options.page || this.data.page || 1)
    this._reqSeq = (this._reqSeq || 0) + 1
    const requestId = this._reqSeq
    this.latestRequestId = requestId
    if (!this.data.loading || this.data.loadError) {
      this.setData({ loading: true, loadError: '' })
    }

    try {
      const keyword = this.data.searchKeyword
      const posts = await app.getPosts('全部', keyword, requestedPage, 'activity')
      const resolved = (posts && posts.length && typeof app.resolveFeedCardMedia === 'function')
        ? await app.resolveFeedCardMedia(posts)
        : posts
      if (requestId !== this.latestRequestId) return
      const basePosts = formatPosts(resolved)
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
        hasMore: posts.length >= 12,
        loadError: ''
      }
      if (requestedPage === 1) {
        patch.mediaLoadedMap = {}
        patch.coverHeightsMap = {}
      }
      this.setData(patch)
    } catch (err) {
      if (requestId !== this.latestRequestId) return
      this.setData({
        loading: false,
        searchLoading: false,
        loadError: '加载失败，请下拉重试'
      })
    }
  },

  onSearchInput(e) {
    const keyword = typeof (e.detail && e.detail.value) === 'string' ? e.detail.value : ''
    this.setData({ searchKeyword: keyword, searchLoading: true })
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.setData({ page: 1, hasMore: true })
      this.loadPosts({ page: 1 })
    }, keyword.trim() ? 250 : 0)
  },

  onSearchConfirm() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this.setData({ page: 1, hasMore: true })
    this.loadPosts({ page: 1 })
  },

  onClearSearch() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this.setData({
      searchKeyword: '',
      page: 1,
      hasMore: true,
      searchLoading: true
    })
    this.loadPosts({ page: 1 })
  },

  onMediaLoad(e) {
    const key = e.currentTarget.dataset.key
    if (!key || this.data.mediaLoadedMap[key]) return
    const d = e.detail || {}
    const hRpx = clampCoverHeightRpx(d.width, d.height)
    this.setData({
      [`mediaLoadedMap.${key}`]: true,
      [`coverHeightsMap.${key}`]: hRpx
    })
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
    if (this._favorBusy) return
    if (!app.requestComplianceForAction()) return
    this._favorBusy = true
    try {
      const next = await app.toggleFavorPost(id)
      if (next === null) return
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
    if (!id) return
    if (this._likeBusy) return
    if (!app.requestComplianceForAction()) return
    this._likeBusy = true
    try {
      const result = await app.toggleLikePost(id)
      if (!result) return
      const loc = this._findCardPath(id)
      if (loc) {
        const cur = this.data[loc.col][loc.idx]
        const wasLiked = !!cur.isLiked
        const nowLiked = !!result.isLiked
        let likes = cur.likes || 0
        if (wasLiked !== nowLiked) {
          likes = Math.max(0, likes + (nowLiked ? 1 : -1))
        }
        this.setData({
          [`${loc.col}[${loc.idx}].isLiked`]: nowLiked,
          [`${loc.col}[${loc.idx}].likes`]: likes
        })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      this._likeBusy = false
    }
  },

  async onPullDownRefresh() {
    try {
      await Promise.all([this.loadZone(), this.loadPosts({ page: 1 })])
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.loadPosts({ page: this.data.page + 1 })
  }
})
