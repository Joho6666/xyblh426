// pages/mine/mine.js - 我的页面逻辑
// 云数据库驱动：个人信息、帖子列表（分页）、账号操作

const app = getApp()
const LIST_PAGE_SIZE = 15
/** 退出登录后写入，登录页读取以预填昵称/头像 */
const LOGIN_PREFILL_KEY = 'login_prefill_v1'

Page({
  data: {
    userInfo: {},
    postCount: 0,
    totalLikes: 0,
    followingCount: 0,
    followerCount: 0,
    currentTab: 0,
    tabs: ['我的发布', '我的闲置', '我的点赞', '我的收藏'],
    myPosts: [],
    myGoods: [],
    likedPosts: [],
    favoredPosts: [],
    myPostsHasMore: true,
    myGoodsHasMore: true,
    likedPostsHasMore: true,
    favoredPostsHasMore: true,
    myPostsLoadingMore: false,
    myGoodsLoadingMore: false,
    likedPostsLoadingMore: false,
    favoredPostsLoadingMore: false,
    loading: false
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
      time: app.formatTime(p.createTime)
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
        time: app.formatTime(g.createTime)
      }))
      return { list, hasMore: rawGoods.length >= LIST_PAGE_SIZE }
    } catch (e) {
      return { list: [], hasMore: false }
    }
  },

  async refreshData() {
    this.setData({ loading: true })

    try {
      const [rawMyPosts, rawLiked, rawFavored, rawUserInfo] = await Promise.all([
        app.getMyPosts(1, LIST_PAGE_SIZE),
        app.getLikedPosts(1, LIST_PAGE_SIZE),
        app.getFavoredPosts(1, LIST_PAGE_SIZE),
        app.getUserInfo(app.globalData.openid)
      ])

      const userInfo = await app.resolveUserMedia(rawUserInfo || {})
      const [formattedMyPosts, formattedLiked, formattedFavored, goodsFirst] = await Promise.all([
        this._formatPostRows(rawMyPosts),
        this._formatPostRows(rawLiked),
        this._formatPostRows(rawFavored),
        this._fetchMyGoodsSlice(1)
      ])

      const totalLikes = formattedMyPosts.reduce(
        (sum, p) => sum + (p.likes || 0),
        0
      )
      const postCountDisplay =
        userInfo && typeof userInfo.postCount === 'number'
          ? userInfo.postCount
          : formattedMyPosts.length

      this.setData({
        postCount: postCountDisplay,
        totalLikes,
        followingCount: userInfo ? userInfo.followingCount || 0 : 0,
        followerCount: userInfo ? userInfo.followerCount || 0 : 0,
        myPosts: formattedMyPosts,
        myGoods: goodsFirst.list,
        likedPosts: formattedLiked,
        favoredPosts: formattedFavored,
        myPostsHasMore: rawMyPosts.length >= LIST_PAGE_SIZE,
        myGoodsHasMore: goodsFirst.hasMore,
        likedPostsHasMore: rawLiked.length >= LIST_PAGE_SIZE,
        favoredPostsHasMore: rawFavored.length >= LIST_PAGE_SIZE,
        userInfo,
        loading: false
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
    if (tab === 0) this.loadMoreMyPosts()
    else if (tab === 1) this.loadMoreMyGoods()
    else if (tab === 2) this.loadMoreLikedPosts()
    else if (tab === 3) this.loadMoreFavoredPosts()
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
      this.setData({
        myPosts: merged,
        myPostsHasMore: raw.length >= LIST_PAGE_SIZE,
        myPostsLoadingMore: false,
        totalLikes
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
      this.setData({
        myGoods: [...this.data.myGoods, ...list],
        myGoodsHasMore: hasMore,
        myGoodsLoadingMore: false
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
      this.setData({
        likedPosts: [...this.data.likedPosts, ...rows],
        likedPostsHasMore: raw.length >= LIST_PAGE_SIZE,
        likedPostsLoadingMore: false
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
      this.setData({
        favoredPosts: [...this.data.favoredPosts, ...rows],
        favoredPostsHasMore: raw.length >= LIST_PAGE_SIZE,
        favoredPostsLoadingMore: false
      })
    } catch (e) {
      this.setData({ favoredPostsLoadingMore: false })
    }
  },

  onTabChange(e) {
    this.setData({ currentTab: e.currentTarget.dataset.index })
  },

  onStatsTap(e) {
    const type = e.currentTarget.dataset.type
    if (type === 'posts') this.setData({ currentTab: 0 })
    else if (type === 'likes') this.setData({ currentTab: 2 })
    else if (type === 'favored') this.setData({ currentTab: 3 })
  },

  onFollowingTap() {
    wx.navigateTo({ url: '/pages/follow/follow?tab=0' })
  },

  onFollowerTap() {
    wx.navigateTo({ url: '/pages/follow/follow?tab=1' })
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },

  goToMarketDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${id}` })
  },

  onViewMyProfile() {
    wx.navigateTo({ url: `/pages/profile/profile?openid=${app.globalData.openid}` })
  },

  onEditProfile() {
    wx.navigateTo({ url: '/pages/edit-profile/edit-profile' })
  },

  onChangeCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: async (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
        try {
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `covers/${Date.now()}.jpg`,
            filePath
          })
          const result = await app.updateProfile({ coverImage: uploadRes.fileID })
          if (!result) {
            wx.hideLoading()
            return
          }
          await this._setUserInfoResolved()
          wx.hideLoading()
          wx.showToast({ title: '封面已更新', icon: 'none' })
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: '上传失败', icon: 'none' })
        }
      }
    })
  },

  onChangeAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: async (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
        try {
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `avatars/${Date.now()}.jpg`,
            filePath
          })
          const result = await app.updateProfile({ avatarUrl: uploadRes.fileID })
          if (!result) {
            wx.hideLoading()
            return
          }
          await this._setUserInfoResolved()
          wx.hideLoading()
          wx.showToast({ title: '头像已更新', icon: 'success' })
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: '上传失败', icon: 'none' })
        }
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

  onMenuTap(e) {
    const page = e.currentTarget.dataset.page
    if (page === 'adminReferral') {
      wx.navigateTo({ url: '/pages/admin-referral/admin-referral' })
    } else if (page === 'editProfile') {
      this.onEditProfile()
    } else if (page === 'searchUser') {
      wx.navigateTo({ url: '/pages/follow/follow?tab=2' })
    } else if (page === 'contact') {
      wx.showToast({ title: '请通过微信公众平台联系客服', icon: 'none' })
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
                    wx.reLaunch({ url: '/pages/index/index' })
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
