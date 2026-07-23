// pages/mine/mine.js - 我的页面逻辑
// 云数据库驱动：个人信息、帖子列表（分页）、账号操作

const app = getApp()
const LIST_PAGE_SIZE = 10
/** 退出登录后写入，登录页读取以预填昵称/头像 */
const LOGIN_PREFILL_KEY = 'login_prefill_v1'

function splitWaterfall(list) {
  const left = []
  const right = []
  ;(list || []).forEach((item, index) => {
    if (index % 2 === 0) left.push(item)
    else right.push(item)
  })
  return { left, right }
}

function firstCoverSrc(item) {
  if (!item) return ''
  const thumbs = Array.isArray(item.thumbImages) ? item.thumbImages : []
  if (thumbs.length && String(thumbs[0] || '').trim()) return String(thumbs[0]).trim()
  const images = Array.isArray(item.images) ? item.images : []
  if (images.length && String(images[0] || '').trim()) return String(images[0]).trim()
  return ''
}

Page({
  data: {
    userInfo: {},
    postCount: 0,
    totalLikes: 0,
    followingCount: 0,
    followerCount: 0,
    currentTab: 0,
    tabs: ['发布', '闲置', '点赞', '收藏'],
    myPosts: [],
    myGoods: [],
    likedPosts: [],
    favoredPosts: [],
    myPostsExpanded: false,
    myGoodsExpanded: false,
    likedPostsExpanded: false,
    favoredPostsExpanded: false,
    myPostsLeft: [],
    myPostsRight: [],
    myGoodsLeft: [],
    myGoodsRight: [],
    likedPostsLeft: [],
    likedPostsRight: [],
    favoredPostsLeft: [],
    favoredPostsRight: [],
    myPostsHasMore: true,
    myGoodsHasMore: true,
    likedPostsHasMore: true,
    favoredPostsHasMore: true,
    myPostsLoadingMore: false,
    myGoodsLoadingMore: false,
    likedPostsLoadingMore: false,
    favoredPostsLoadingMore: false,
    loading: false,
    menuExpanded: false,
    tabLoaded: [true, false, false, false]
  },

  _computeWaterfallPatch() {
    const myPostsView = this.data.myPostsExpanded ? this.data.myPosts : this.data.myPosts.slice(0, 2)
    const myGoodsView = this.data.myGoodsExpanded ? this.data.myGoods : this.data.myGoods.slice(0, 2)
    const likedPostsView = this.data.likedPostsExpanded ? this.data.likedPosts : this.data.likedPosts.slice(0, 2)
    const favoredPostsView = this.data.favoredPostsExpanded ? this.data.favoredPosts : this.data.favoredPosts.slice(0, 2)
    const mp = splitWaterfall(myPostsView)
    const mg = splitWaterfall(myGoodsView)
    const lp = splitWaterfall(likedPostsView)
    const fp = splitWaterfall(favoredPostsView)
    return {
      myPostsLeft: mp.left,
      myPostsRight: mp.right,
      myGoodsLeft: mg.left,
      myGoodsRight: mg.right,
      likedPostsLeft: lp.left,
      likedPostsRight: lp.right,
      favoredPostsLeft: fp.left,
      favoredPostsRight: fp.right
    }
  },

  /** 仅同步分列结果（仅在外层 setData 之后没有合并能力时使用） */
  _syncWaterfallView() {
    this.setData(this._computeWaterfallPatch())
  },

  onToggleExpand(e) {
    const type = e.currentTarget.dataset.type
    const map = {
      myPosts: 'myPostsExpanded',
      myGoods: 'myGoodsExpanded',
      likedPosts: 'likedPostsExpanded',
      favoredPosts: 'favoredPostsExpanded'
    }
    const flagKey = map[type]
    if (!flagKey) return
    // 先在内存里翻转，再一次性下发分列结果，比双段 setData 少一次渲染往返
    this.data[flagKey] = !this.data[flagKey]
    const patch = this._computeWaterfallPatch()
    patch[flagKey] = this.data[flagKey]
    this.setData(patch)
  },

  onToggleMenuMore() {
    this.setData({ menuExpanded: !this.data.menuExpanded })
  },

  onLoad() {
    app.waitForLogin((userInfo) => {
      this.setData({ userInfo: userInfo || {} })
      this._applyResolvedUserInfo()
      this.refreshData()
    })
  },

  /** 解析云存储封面/头像为可展示的 HTTPS，与主页 profile 一致 */
  async _applyResolvedUserInfo() {
    const u = app.globalData.userInfo
    if (!u || !app.globalData.isLoggedIn) return
    try {
      const resolved = await app.resolveUserMedia({ ...u })
      this.setData({ userInfo: resolved })
    } catch (e) {
      console.warn('resolveUserMedia', e)
    }
  },

  async _setUserInfoResolved() {
    const resolved = await app.resolveUserMedia({ ...(app.globalData.userInfo || {}) })
    this.setData({ userInfo: resolved })
  },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar) {
      tabBar.setData({ selected: 4 })
      app.syncMessageBadge(tabBar)
    }
    if (!app.ensureComplianceOnTabShow()) return
    if (!app.globalData.isLoggedIn) return

    this._applyResolvedUserInfo()

    if (app.globalData.mineNeedsRefresh) {
      app.globalData.mineNeedsRefresh = false
      this.refreshData()
      return
    }

    if (!this._dataLoaded && !this.data.loading) {
      this.refreshData()
      return
    }

    const stale = this._tabHiddenAt && Date.now() - this._tabHiddenAt > 45000
    if (stale) {
      this._tabHiddenAt = 0
      this.refreshData()
    }
  },

  onHide() {
    this._tabHiddenAt = Date.now()
  },

  async _formatPostRows(rawList) {
    const raw = rawList || []
    const resolved =
      app.globalData.cloudReady && raw.length
        ? await app.resolvePostsMedia(raw)
        : raw
    return resolved.map((p) => ({
      ...p,
      time: app.formatTime(p.createTime),
      _coverSrc: firstCoverSrc(p)
    }))
  },

  async _fetchMyGoodsSlice(page) {
    const skip = (page - 1) * LIST_PAGE_SIZE
    try {
      const db = wx.cloud.database()
      const goodsRes = await db
        .collection('market_goods')
        .where({ _openid: app.globalData.openid, status: 'active' })
        .orderBy('createTime', 'desc')
        .skip(skip)
        .limit(LIST_PAGE_SIZE)
        .get()
      const rawGoods = goodsRes.data || []
      const goodsResolved =
        app.globalData.cloudReady && rawGoods.length
          ? await app.resolvePostsMedia(rawGoods)
          : rawGoods
      const list = goodsResolved.map((g) => ({
        ...g,
        time: app.formatTime(g.createTime),
        _coverSrc: firstCoverSrc(g)
      }))
      return { list, hasMore: rawGoods.length >= LIST_PAGE_SIZE }
    } catch (e) {
      return { list: [], hasMore: false }
    }
  },

  async refreshData() {
    this.setData({ loading: true })

    try {
      // 首屏优先：先拿“我的发布 + 用户信息”，减少低配机首屏并发压力
      const [rawMyPosts, rawUserInfo] = await Promise.all([
        app.getMyPosts(1, LIST_PAGE_SIZE),
        app.getUserInfo(app.globalData.openid)
      ])

      const userInfo = await app.resolveUserMedia(rawUserInfo || {})
      const formattedMyPosts = await this._formatPostRows(rawMyPosts)

      const totalLikes = formattedMyPosts.reduce(
        (sum, p) => sum + (p.likes || 0),
        0
      )
      const postCountDisplay =
        userInfo && typeof userInfo.postCount === 'number'
          ? userInfo.postCount
          : formattedMyPosts.length

      this.data.myPosts = formattedMyPosts
      this.data.myGoods = []
      this.data.likedPosts = []
      this.data.favoredPosts = []
      const waterfall = this._computeWaterfallPatch()
      this.setData({
        postCount: postCountDisplay,
        totalLikes,
        followingCount: userInfo ? userInfo.followingCount || 0 : 0,
        followerCount: userInfo ? userInfo.followerCount || 0 : 0,
        myPosts: formattedMyPosts,
        myGoods: [],
        likedPosts: [],
        favoredPosts: [],
        myPostsHasMore: rawMyPosts.length >= LIST_PAGE_SIZE,
        myGoodsHasMore: true,
        likedPostsHasMore: true,
        favoredPostsHasMore: true,
        userInfo,
        loading: false,
        tabLoaded: [true, false, false, false],
        ...waterfall
      })
      this._dataLoaded = true
    } catch (err) {
      console.error('刷新数据失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: '数据加载失败，请下拉重试', icon: 'none' })
    }
  },

  onReachBottom() {
    if (this.data.loading) return
    const tab = this.data.currentTab
    if (tab === 0 && this.data.myPostsExpanded) this.loadMoreMyPosts()
    else if (tab === 1 && this.data.myGoodsExpanded) this.loadMoreMyGoods()
    else if (tab === 2 && this.data.likedPostsExpanded) this.loadMoreLikedPosts()
    else if (tab === 3 && this.data.favoredPostsExpanded) this.loadMoreFavoredPosts()
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  _nextListPage(itemCount) {
    return Math.floor(itemCount / LIST_PAGE_SIZE) + 1
  },

  async loadMoreMyPosts() {
    if (
      !this.data.myPostsHasMore ||
      this.data.myPostsLoadingMore ||
      this.data.loading
    ) {
      return
    }
    this.setData({ myPostsLoadingMore: true })
    const page = this._nextListPage(this.data.myPosts.length)
    try {
      const raw = await app.getMyPosts(page, LIST_PAGE_SIZE)
      const rows = await this._formatPostRows(raw)
      const merged = [...this.data.myPosts, ...rows]
      const totalLikes = merged.reduce((s, p) => s + (p.likes || 0), 0)
      this.data.myPosts = merged
      this.setData({
        myPosts: merged,
        myPostsHasMore: raw.length >= LIST_PAGE_SIZE,
        myPostsLoadingMore: false,
        totalLikes,
        ...this._computeWaterfallPatch()
      })
    } catch (e) {
      this.setData({ myPostsLoadingMore: false })
    }
  },

  async loadMoreMyGoods() {
    if (
      !this.data.myGoodsHasMore ||
      this.data.myGoodsLoadingMore ||
      this.data.loading
    ) {
      return
    }
    this.setData({ myGoodsLoadingMore: true })
    const page = this._nextListPage(this.data.myGoods.length)
    try {
      const { list, hasMore } = await this._fetchMyGoodsSlice(page)
      const merged = [...this.data.myGoods, ...list]
      this.data.myGoods = merged
      this.setData({
        myGoods: merged,
        myGoodsHasMore: hasMore,
        myGoodsLoadingMore: false,
        ...this._computeWaterfallPatch()
      })
    } catch (e) {
      this.setData({ myGoodsLoadingMore: false })
    }
  },

  async loadMoreLikedPosts() {
    if (
      !this.data.likedPostsHasMore ||
      this.data.likedPostsLoadingMore ||
      this.data.loading
    ) {
      return
    }
    this.setData({ likedPostsLoadingMore: true })
    const page = this._nextListPage(this.data.likedPosts.length)
    try {
      const raw = await app.getLikedPosts(page, LIST_PAGE_SIZE)
      const rows = await this._formatPostRows(raw)
      const merged = [...this.data.likedPosts, ...rows]
      this.data.likedPosts = merged
      this.setData({
        likedPosts: merged,
        likedPostsHasMore: raw.length >= LIST_PAGE_SIZE,
        likedPostsLoadingMore: false,
        ...this._computeWaterfallPatch()
      })
    } catch (e) {
      this.setData({ likedPostsLoadingMore: false })
    }
  },

  async loadMoreFavoredPosts() {
    if (
      !this.data.favoredPostsHasMore ||
      this.data.favoredPostsLoadingMore ||
      this.data.loading
    ) {
      return
    }
    this.setData({ favoredPostsLoadingMore: true })
    const page = this._nextListPage(this.data.favoredPosts.length)
    try {
      const raw = await app.getFavoredPosts(page, LIST_PAGE_SIZE)
      const rows = await this._formatPostRows(raw)
      const merged = [...this.data.favoredPosts, ...rows]
      this.data.favoredPosts = merged
      this.setData({
        favoredPosts: merged,
        favoredPostsHasMore: raw.length >= LIST_PAGE_SIZE,
        favoredPostsLoadingMore: false,
        ...this._computeWaterfallPatch()
      })
    } catch (e) {
      this.setData({ favoredPostsLoadingMore: false })
    }
  },

  onTabChange(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index)) return
    this.setData({ currentTab: index }, () => this.ensureTabDataLoaded(index))
  },

  async ensureTabDataLoaded(index) {
    const loaded = this.data.tabLoaded || []
    if (loaded[index]) return
    try {
      if (index === 1) {
        const goodsFirst = await this._fetchMyGoodsSlice(1)
        const next = loaded.slice()
        next[1] = true
        this.data.myGoods = goodsFirst.list
        this.setData({
          myGoods: goodsFirst.list,
          myGoodsHasMore: goodsFirst.hasMore,
          tabLoaded: next,
          ...this._computeWaterfallPatch()
        })
        return
      }
      if (index === 2) {
        const rawLiked = await app.getLikedPosts(1, LIST_PAGE_SIZE)
        const formattedLiked = await this._formatPostRows(rawLiked)
        const next = loaded.slice()
        next[2] = true
        this.data.likedPosts = formattedLiked
        this.setData({
          likedPosts: formattedLiked,
          likedPostsHasMore: rawLiked.length >= LIST_PAGE_SIZE,
          tabLoaded: next,
          ...this._computeWaterfallPatch()
        })
        return
      }
      if (index === 3) {
        const rawFavored = await app.getFavoredPosts(1, LIST_PAGE_SIZE)
        const formattedFavored = await this._formatPostRows(rawFavored)
        const next = loaded.slice()
        next[3] = true
        this.data.favoredPosts = formattedFavored
        this.setData({
          favoredPosts: formattedFavored,
          favoredPostsHasMore: rawFavored.length >= LIST_PAGE_SIZE,
          tabLoaded: next,
          ...this._computeWaterfallPatch()
        })
      }
    } catch (e) {
      // 按需懒加载失败时保持当前页可用
    }
  },

  onStatsTap(e) {
    const type = e.currentTarget.dataset.type
    if (type === 'posts') this.setData({ currentTab: 0 }, () => this.ensureTabDataLoaded(0))
    else if (type === 'likes') this.setData({ currentTab: 2 }, () => this.ensureTabDataLoaded(2))
    else if (type === 'favored') this.setData({ currentTab: 3 }, () => this.ensureTabDataLoaded(3))
  },

  onFollowingTap() {
    wx.navigateTo({ url: '/pages/follow/follow?tab=0' })
  },

  onFollowerTap() {
    wx.navigateTo({ url: '/pages/follow/follow?tab=1' })
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  goToMarketDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${encodeURIComponent(id)}` })
  },

  onViewMyProfile() {
    const oid = app.globalData.openid
    if (!oid) return
    wx.navigateTo({ url: `/pages/profile/profile?openid=${encodeURIComponent(oid)}` })
  },

  onEditProfile() {
    wx.navigateTo({ url: '/pages/edit-profile/edit-profile' })
  },

  async _uploadAndSaveProfileImage({ filePath, cloudDir, field, successText }) {
    // 前置检测：尽量在上传前就给出明确失败原因
    const check = await app.checkImageContent(filePath)
    if (!check || !check.pass) {
      wx.showToast({ title: (check && check.errMsg) || '图片未通过审核', icon: 'none' })
      return
    }

    wx.showLoading({ title: '上传中...' })
    let uploadedFileId = ''
    try {
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `${cloudDir}/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`,
        filePath
      })
      uploadedFileId = uploadRes && uploadRes.fileID ? uploadRes.fileID : ''
      if (!uploadedFileId) {
        wx.showToast({ title: '上传失败，请重试', icon: 'none' })
        return
      }

      const result = await app.updateProfile({ [field]: uploadedFileId })
      if (!result) {
        // 服务端拒绝时清理刚上传文件，避免云存储残留
        try { await wx.cloud.deleteFile({ fileList: [uploadedFileId] }) } catch (e) {}
        return
      }

      await this._setUserInfoResolved()
      wx.showToast({ title: successText, icon: 'success' })
    } catch (err) {
      if (uploadedFileId) {
        try { await wx.cloud.deleteFile({ fileList: [uploadedFileId] }) } catch (e) {}
      }
      wx.showToast({ title: '上传失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  onChangeCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: async (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        await this._uploadAndSaveProfileImage({
          filePath,
          cloudDir: 'covers',
          field: 'coverImage',
          successText: '封面已更新'
        })
      }
    })
  },

  onChangeAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: async (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        await this._uploadAndSaveProfileImage({
          filePath,
          cloudDir: 'avatars',
          field: 'avatarUrl',
          successText: '头像已更新'
        })
      }
    })
  },

  onEditNickname() {
    wx.showModal({
      title: '修改昵称',
      content: (this.data.userInfo || {}).nickName || '',
      editable: true,
      placeholderText: '请输入新的昵称',
      confirmColor: '#426089',
      success: async (res) => {
        if (res.confirm && res.content.trim()) {
          const check = app.checkContent(res.content.trim())
          if (!check.pass) {
            wx.showToast({ title: '昵称包含违规内容', icon: 'none' })
            return
          }
          const result = await app.updateProfile({ nickName: res.content.trim() })
          if (!result) {
            return
          }
          await this._setUserInfoResolved()
          wx.showToast({ title: '昵称已修改', icon: 'success' })
        }
      }
    })
  },

  onCopyUserId() {
    const numericId = (this.data.userInfo && this.data.userInfo.numericId) || ''
    const idText = String(numericId).trim()
    if (!idText) {
      wx.showToast({ title: '当前暂无可复制ID', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: idText,
      success: () => {
        wx.showToast({ title: 'ID已复制', icon: 'success' })
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' })
      }
    })
  },

  onMenuTap(e) {
    const page = e.currentTarget.dataset.page
    if (page === 'adminReferral') {
      wx.navigateTo({ url: '/pages/admin-referral/admin-referral' })
    } else if (page === 'adminAnnouncement') {
      wx.navigateTo({ url: '/pages/admin-announcement/admin-announcement' })
    } else if (page === 'adminActivityZone') {
      wx.navigateTo({ url: '/pages/admin-activity-zone/admin-activity-zone' })
    } else if (page === 'referral') {
      wx.navigateTo({ url: '/pages/referral/referral' })
    } else if (page === 'editProfile') {
      this.onEditProfile()
    } else if (page === 'searchUser') {
      wx.navigateTo({ url: '/pages/follow/follow?tab=2' })
    } else if (page === 'blockedUsers') {
      wx.navigateTo({ url: '/pages/blacklist/blacklist' })
    } else if (page === 'contact') {
      wx.navigateTo({ url: '/pages/contact/contact' })
    } else if (page === 'privacy') {
      wx.navigateTo({ url: '/pages/privacy/privacy' })
    }
  },

  onShareAppMessage() {
    return {
      title: '我的校园名片 - 校园便利盒',
      path: '/pages/index/index',
      imageUrl: '/images/icon_share.png'
    }
  },
  onShareTimeline() {
    return {
      title: '我的校园名片 - 校园便利盒',
      imageUrl: '/images/icon_share.png'
    }
  },

  onLogout() {
    wx.showModal({
      title: '提示',
      content: '确定要退出登录吗？退出后将回到欢迎页，您的昵称与头像会保留，已同意的协议无需再次确认。',
      confirmColor: '#426089',
      success(res) {
        if (res.confirm) {
          const u = app.globalData.userInfo
          const prefill =
            u && typeof u === 'object'
              ? {
                  nickName: (u.nickName || '').trim(),
                  avatarUrl: u.avatarUrl || '/images/avatar_default.png'
                }
              : null
          app.resetSession()
          wx.clearStorageSync()
          if (prefill) {
            try {
              wx.setStorageSync(LOGIN_PREFILL_KEY, prefill)
            } catch (e) {
              console.warn('[logout] save prefill', e)
            }
          }
          wx.showToast({ title: '已退出登录', icon: 'none', duration: 900 })
          setTimeout(() => {
            wx.reLaunch({ url: '/pages/login/login' })
          }, 650)
        }
      }
    })
  },

  onDeleteAccount() {
    wx.showModal({
      title: '注销账号',
      content:
        '注销后，您的所有数据（帖子、评论、私信等）将被永久删除且无法恢复。确定注销吗？',
      confirmColor: '#d32f2f',
      confirmText: '确定注销',
      success: async (res) => {
        if (res.confirm) {
          wx.showModal({
            title: '最后确认',
            content: '此操作不可撤销！确定要永久注销账号吗？',
            confirmColor: '#d32f2f',
            success: async (res2) => {
              if (res2.confirm) {
                wx.showLoading({ title: '注销中...', mask: true })
                const success = await app.deleteAccount()
                wx.hideLoading()
                if (success) {
                  wx.clearStorageSync()
                  app.resetSession()
                  wx.showToast({ title: '账号已注销', icon: 'none' })
                  setTimeout(() => {
                    wx.reLaunch({ url: '/pages/login/login' })
                  }, 1500)
                }
              }
            }
          })
        }
      }
    })
  },

  onClearData() {
    wx.showModal({
      title: '清除缓存',
      content: '仅清除本地缓存，不影响云端数据。',
      confirmColor: '#426089',
      success: (res) => {
        if (res.confirm) {
          wx.clearStorageSync()
          wx.showToast({ title: '缓存已清除', icon: 'none' })
        }
      }
    })
  }
})
