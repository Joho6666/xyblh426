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
    isAdmin: false
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
      this.setData({ isMe, isAdmin })
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
      const rawUser = await app.getUserInfo(targetOpenid)
      if (!rawUser) {
        wx.showToast({ title: '用户不存在', icon: 'none' })
        return
      }

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
          user,
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
          user,
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
    const user = this.data.user
    wx.navigateTo({
      url: `/pages/chat/chat?openid=${this.data.targetOpenid}&nickname=${encodeURIComponent(user.nickName || '')}`
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
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },

  goToGoodsDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${id}` })
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
