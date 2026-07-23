// pages/profile/profile.js - 用户主页（动态 + 闲置，分页）

const app = getApp()
const LIST_PAGE_SIZE = 15

Page({
  data: {
    user: {},
    targetOpenid: '',
    isMe: false,
    isFollowing: false,
    profileTab: 'posts',
    posts: [],
    postsHasMore: true,
    postsLoadingMore: false,
    postStatTotal: 0,
    goods: [],
    goodsHasMore: true,
    goodsLoadingMore: false,
    goodsStatTotal: 0,
    followingCount: 0,
    followerCount: 0,
    isAdmin: false,
    profileAccessDenied: false,
    denyMessage: '',
    iBlockedThem: false
  },

  async onLoad(options) {
    const targetOpenid = options.openid || options.userId || ''
    this.setData({ targetOpenid })

    const boot = async () => {
      const resolvedTargetOpenid = this.data.targetOpenid || app.globalData.openid
      if (!resolvedTargetOpenid) {
        wx.showToast({ title: '用户信息加载失败', icon: 'none' })
        return
      }
      if (resolvedTargetOpenid !== this.data.targetOpenid) {
        this.setData({ targetOpenid: resolvedTargetOpenid })
      }
      const isMe = resolvedTargetOpenid === app.globalData.openid
      const isAdmin =
        app.globalData.userInfo && app.globalData.userInfo.role === 'admin'
      this.setData({
        isMe,
        isAdmin,
        profileAccessDenied: false,
        denyMessage: '',
        iBlockedThem: false
      })
      await this.loadUserData(resolvedTargetOpenid, { reset: true })
    }

    if (app.globalData.isLoggedIn) {
      await boot()
    } else {
      app.waitForLogin((userInfo) => {
        if (userInfo) boot()
      })
    }
  },

  onProfileTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.profileTab) return
    this.setData({ profileTab: tab })
  },

  async loadUserData(targetOpenid, { reset = true } = {}) {
    try {
      let rawUser = null
      try {
        const result = await app.callDB('getUserInfo', { targetOpenid })
        rawUser = result.data
      } catch (err) {
        const msg = (err && err.msg) || '无法查看该用户'
        this.setData({
          profileAccessDenied: true,
          denyMessage: msg,
          posts: [],
          goods: [],
          postsHasMore: false,
          goodsHasMore: false,
          postStatTotal: 0,
          goodsStatTotal: 0,
          user: {},
          iBlockedThem: false,
          isFollowing: false
        })
        wx.setNavigationBarTitle({ title: '用户主页' })
        return
      }

      if (!rawUser) {
        wx.showToast({ title: '用户不存在', icon: 'none' })
        return
      }

      const iBlockedThem = !!rawUser.iBlockedThem
      const user = await app.resolveUserMedia(rawUser)

      if (reset) {
        const [postsRaw, goodsPack] = await Promise.all([
          app.getUserPosts(targetOpenid, 1, LIST_PAGE_SIZE),
          app.getUserMarketGoods(targetOpenid, 1, LIST_PAGE_SIZE)
        ])

        const safePostsRaw = Array.isArray(postsRaw) ? postsRaw : []
        const postsResolved =
          app.globalData.cloudReady && safePostsRaw.length
            ? await app.resolvePostsMedia(safePostsRaw)
            : safePostsRaw
        const formattedPosts = postsResolved.map((p) => ({
          ...p,
          coverUrl:
            (Array.isArray(p.images) && p.images[0]) || p.image || '',
          time: app.formatTime(p.createTime)
        }))

        const safeGoodsPack = goodsPack || {}
        const goodsRaw = Array.isArray(safeGoodsPack.list) ? safeGoodsPack.list : []
        const goodsResolved =
          app.globalData.cloudReady && goodsRaw.length
            ? await app.resolvePostsMedia(goodsRaw)
            : goodsRaw
        const formattedGoods = goodsResolved.map((g) => ({
          ...g,
          coverUrl:
            (Array.isArray(g.images) && g.images[0]) ? g.images[0] : '',
          time: app.formatTime(g.createTime)
        }))

        const postStatTotal =
          typeof user.postCount === 'number'
            ? user.postCount
            : formattedPosts.length

        this.setData({
          profileAccessDenied: false,
          denyMessage: '',
          user,
          iBlockedThem,
          posts: formattedPosts,
          postsHasMore: safePostsRaw.length >= LIST_PAGE_SIZE,
          postsLoadingMore: false,
          postStatTotal,
          goods: formattedGoods,
          goodsHasMore: goodsRaw.length >= LIST_PAGE_SIZE,
          goodsLoadingMore: false,
          goodsStatTotal: safeGoodsPack.total || 0,
          followingCount: user.followingCount || 0,
          followerCount: user.followerCount || 0,
          isFollowing: !!user.isFollowing
        })
      } else {
        this.setData({
          profileAccessDenied: false,
          denyMessage: '',
          user,
          iBlockedThem,
          followingCount: user.followingCount || 0,
          followerCount: user.followerCount || 0,
          isFollowing: !!user.isFollowing
        })
      }

      wx.setNavigationBarTitle({ title: user.nickName || '用户主页' })
    } catch (err) {
      console.error('加载用户数据失败:', err)
      this.setData({ postsLoadingMore: false, goodsLoadingMore: false })
      wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' })
    }
  },

  onReachBottom() {
    if (this.data.profileTab === 'posts') {
      this.loadMorePosts()
    } else {
      this.loadMoreGoods()
    }
  },

  onPullDownRefresh() {
    if (!this.data.targetOpenid) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadUserData(this.data.targetOpenid, { reset: true }).finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  async loadMorePosts() {
    if (
      !this.data.postsHasMore ||
      this.data.postsLoadingMore ||
      !this.data.targetOpenid
    ) {
      return
    }
    this.setData({ postsLoadingMore: true })
    const page =
      Math.floor(this.data.posts.length / LIST_PAGE_SIZE) + 1
    try {
      const raw = await app.getUserPosts(
        this.data.targetOpenid,
        page,
        LIST_PAGE_SIZE
      )
      const resolved =
        app.globalData.cloudReady && raw.length
          ? await app.resolvePostsMedia(raw)
          : raw
      const rows = resolved.map((p) => ({
        ...p,
        coverUrl:
          (Array.isArray(p.images) && p.images[0]) || p.image || '',
        time: app.formatTime(p.createTime)
      }))
      this.setData({
        posts: [...this.data.posts, ...rows],
        postsHasMore: raw.length >= LIST_PAGE_SIZE,
        postsLoadingMore: false
      })
    } catch (e) {
      this.setData({ postsLoadingMore: false })
    }
  },

  async loadMoreGoods() {
    if (
      !this.data.goodsHasMore ||
      this.data.goodsLoadingMore ||
      !this.data.targetOpenid
    ) {
      return
    }
    this.setData({ goodsLoadingMore: true })
    const page =
      Math.floor(this.data.goods.length / LIST_PAGE_SIZE) + 1
    try {
      const pack = await app.getUserMarketGoods(
        this.data.targetOpenid,
        page,
        LIST_PAGE_SIZE
      )
      const raw = pack.list || []
      const resolved =
        app.globalData.cloudReady && raw.length
          ? await app.resolvePostsMedia(raw)
          : raw
      const rows = resolved.map((g) => ({
        ...g,
        coverUrl:
          (Array.isArray(g.images) && g.images[0]) ? g.images[0] : '',
        time: app.formatTime(g.createTime)
      }))
      this.setData({
        goods: [...this.data.goods, ...rows],
        goodsHasMore: raw.length >= LIST_PAGE_SIZE,
        goodsLoadingMore: false
      })
    } catch (e) {
      this.setData({ goodsLoadingMore: false })
    }
  },

  async onToggleFollow() {
    if (this.data.iBlockedThem) {
      wx.showToast({ title: '请先解除拉黑后再关注', icon: 'none' })
      return
    }
    const isFollowing = await app.toggleFollow(this.data.targetOpenid)
    if (isFollowing !== null) {
      this.setData({ isFollowing })
      wx.showToast({
        title: isFollowing ? '已关注' : '取消关注',
        icon: 'none'
      })
      await this.loadUserData(this.data.targetOpenid, { reset: false })
    }
  },

  onSendMessage() {
    if (this.data.iBlockedThem) {
      wx.showToast({ title: '请先解除拉黑后再私信', icon: 'none' })
      return
    }
    const user = this.data.user
    wx.navigateTo({
      url: `/pages/chat/chat?openid=${encodeURIComponent(this.data.targetOpenid)}&nickname=${encodeURIComponent(user.nickName || '')}`
    })
  },

  async onToggleUserBlock() {
    const nick = (this.data.user && this.data.user.nickName) || '该用户'
    const currentlyBlocked = this.data.iBlockedThem
    wx.showModal({
      title: currentlyBlocked ? '解除拉黑' : '拉黑用户',
      content: currentlyBlocked
        ? `解除后双方可正常浏览主页与动态（若对方仍拉黑你，则以对方为准）。关注关系不会自动恢复，需要时可重新点「关注」；也可在「我的 → 黑名单」集中管理。`
        : `拉黑后对方无法查看你的主页、帖子和闲置，也无法向你发私信；双方信息流中互不展示对方内容。你可随时点「解除拉黑」或在「我的 → 黑名单」恢复。`,
      confirmText: currentlyBlocked ? '解除' : '确认拉黑',
      confirmColor: currentlyBlocked ? '#426089' : '#b3261e',
      success: async (res) => {
        if (!res.confirm) return
        const payload = await app.toggleUserBlock(this.data.targetOpenid)
        if (!payload) return
        wx.showToast({
          title: payload.blocked ? '已拉黑' : '已解除拉黑',
          icon: 'none'
        })
        await this.loadUserData(this.data.targetOpenid, { reset: true })
      }
    })
  },

  onFollowingTap() {
    if (this.data.isMe) {
      wx.navigateTo({ url: '/pages/follow/follow?tab=0' })
    } else {
      wx.showToast({ title: '暂不支持查看对方关注列表', icon: 'none' })
    }
  },

  onFollowerTap() {
    if (this.data.isMe) {
      wx.navigateTo({ url: '/pages/follow/follow?tab=1' })
    } else {
      wx.showToast({ title: '暂不支持查看对方粉丝列表', icon: 'none' })
    }
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  goToGoodsDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${encodeURIComponent(id)}` })
  },

  onAdminBanUser() {
    wx.showModal({
      title: '管理员操作',
      content: `确定要封禁【${this.data.user.nickName}】吗？其所有内容将被隐藏。`,
      confirmColor: '#d32f2f',
      success: async (res) => {
        if (res.confirm) {
          const success = await app.banUser(this.data.targetOpenid)
          if (success) {
            wx.showToast({ title: '已封禁', icon: 'success' })
            setTimeout(() => {
              wx.navigateBack()
            }, 1500)
          }
        }
      }
    })
  }
})
