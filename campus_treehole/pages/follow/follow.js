// pages/follow/follow.js - 关注与粉丝列表
// 云数据库驱动

const app = getApp()

async function resolveUserListMedia(list = []) {
  const avatarMap = await app.resolveFileUrlsMap(list.map(item => item.avatarUrl))
  return list.map(item => ({
    ...item,
    avatarUrl: avatarMap[item.avatarUrl] || item.avatarUrl || '/images/avatar_default.png'
  }))
}

Page({
  data: {
    currentTab: 0,
    tabs: ['关注', '粉丝', '发现'],
    followingList: [],
    followerList: [],
    searchList: [],
    searchKeyword: '',
    mode: '',
    shareType: '',
    shareId: '',
    autoShare: '',
    searchLoading: false,
    loading: false
  },

  onLoad(options) {
    const nextData = {}
    if (options.tab !== undefined) {
      nextData.currentTab = parseInt(options.tab, 10) || 0
    }
    if (options.mode) {
      nextData.mode = options.mode
      // 从“新建聊天”进入时，默认落在可搜索用户的发现页。
      if (options.mode === 'chat' && options.tab === undefined) {
        nextData.currentTab = 2
      }
    }
    if (options.shareType) nextData.shareType = options.shareType
    if (options.shareId) nextData.shareId = options.shareId
    if (options.autoShare) nextData.autoShare = options.autoShare
    if (Object.keys(nextData).length) {
      this.setData(nextData)
    }
    this._bootFollow()
  },

  onShow() {
    if (app.globalData.isLoggedIn) {
      this.refreshData()
    }
  },

  onUnload() {
    this._unloaded = true
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
  },

  _bootFollow() {
    if (app.globalData.isLoggedIn) {
      this.refreshData()
      return
    }
    app.waitForLogin((userInfo) => {
      if (userInfo) this.refreshData()
    })
  },

  async refreshData() {
    this.setData({ loading: true })
    try {
      const [followingList, followerList, searchList] = await Promise.all([
        app.getFollowingList(),
        app.getFollowerList(),
        app.searchUsers('')
      ])

      const [resolvedFollowing, resolvedFollower, resolvedSearch] = await Promise.all([
        resolveUserListMedia(followingList || []),
        resolveUserListMedia(followerList || []),
        resolveUserListMedia(searchList || [])
      ])

      this.setData({
        followingList: resolvedFollowing,
        followerList: resolvedFollower,
        searchList: resolvedSearch,
        loading: false
      })
    } catch (err) {
      this.setData({ loading: false, searchLoading: false })
      wx.showToast({ title: '列表加载失败，请下拉重试', icon: 'none' })
    }
  },

  onTabChange(e) {
    this.setData({ currentTab: e.currentTarget.dataset.index })
  },

  async onSearchInput(e) {
    const keyword = e.detail.value
    this.setData({ searchKeyword: keyword, searchLoading: true })
    const requestKeyword = keyword

    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }

    this.searchTimer = setTimeout(async () => {
      try {
        const searchList = await app.searchUsers(requestKeyword)
        const resolvedSearch = await resolveUserListMedia(searchList || [])
        if (this._unloaded || requestKeyword !== this.data.searchKeyword) {
          return
        }
        this.setData({
          searchList: resolvedSearch,
          searchLoading: false
        })
      } catch (err) {
        if (this._unloaded || requestKeyword !== this.data.searchKeyword) {
          return
        }
        this.setData({ searchLoading: false })
        wx.showToast({ title: '搜索失败，请稍后重试', icon: 'none' })
      }
    }, keyword.trim() ? 250 : 0)
  },

  onClearSearch() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    this.setData({
      searchKeyword: '',
      searchLoading: true
    })
    this.onSearchInput({ detail: { value: '' } })
  },

  async onToggleFollow(e) {
    const targetOpenid = e.currentTarget.dataset.openid
    const isFollowing = await app.toggleFollow(targetOpenid)
    if (isFollowing !== null) {
      wx.showToast({ title: isFollowing ? '已关注' : '取消关注', icon: 'none' })
      this.refreshData()
    }
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  onUserTap(e) {
    const openid = e.currentTarget.dataset.openid
    if (this.data.mode === 'chat') {
      const nickname = e.currentTarget.dataset.nickname || ''
      const extra = this.data.shareType && this.data.shareId
        ? `&shareType=${this.data.shareType}&shareId=${this.data.shareId}&autoShare=${this.data.autoShare || ''}`
        : ''
      wx.navigateTo({
        url: `/pages/chat/chat?openid=${openid}&nickname=${encodeURIComponent(nickname)}${extra}`
      })
    } else {
      wx.navigateTo({ url: `/pages/profile/profile?openid=${openid}` })
    }
  },

  onChatTap(e) {
    const openid = e.currentTarget.dataset.openid
    const nickname = e.currentTarget.dataset.nickname || ''
    const extra = this.data.shareType && this.data.shareId
      ? `&shareType=${this.data.shareType}&shareId=${this.data.shareId}&autoShare=${this.data.autoShare || ''}`
      : ''
    wx.navigateTo({
      url: `/pages/chat/chat?openid=${openid}&nickname=${encodeURIComponent(nickname)}${extra}`
    })
  }
})
