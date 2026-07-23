// pages/follow/follow.js - 关注与粉丝列表
// 云数据库驱动

const app = getApp()

function safeOptionText(value) {
  if (typeof value !== 'string') return ''
  if (value === 'undefined' || value === 'null') return ''
  return value
}

function decodeSafe(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (err) {
    return value
  }
}

/** 发现页搜索：统一成安全字符串，杜绝页面出现字面量 "undefined" */
function coerceDiscoverQuery(v) {
  if (v == null) return ''
  const s = String(v)
  if (s === 'undefined' || s === 'null' || s === '[object Object]') return ''
  return s
}

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
    discoverUserQuery: '',
    mode: '',
    shareType: '',
    shareId: '',
    autoShare: '',
    shareAuthorCard: null,
    recentChatList: [],
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
      // 聊天选择默认停留在关注页，避免必须先搜索。
      if (options.mode === 'chat' && options.tab === undefined) {
        nextData.currentTab = 0
      }
    }
    if (options.shareType) nextData.shareType = options.shareType
    if (options.shareId) nextData.shareId = options.shareId
    if (options.autoShare) nextData.autoShare = options.autoShare
    const rawAuthorOpenid = safeOptionText(options.authorOpenid)
    const rawAuthorNickname = safeOptionText(options.authorNickname)
    this._shareAuthorFromOptions = {
      openid: decodeSafe(rawAuthorOpenid),
      nickname: decodeSafe(rawAuthorNickname)
    }
    if (Object.keys(nextData).length) {
      this.setData(nextData)
    }
    this._followFirstShow = true
    this._bootFollow()
  },

  onShow() {
    if (this.data.currentTab === 2) {
      const q = coerceDiscoverQuery(this.data.discoverUserQuery)
      if (q !== this.data.discoverUserQuery) {
        this.setData({ discoverUserQuery: q })
      }
    }
    // 首次 onShow 紧跟 onLoad，由 _bootFollow 已发起请求；后续 onShow 才走 refresh
    if (this._followFirstShow) {
      this._followFirstShow = false
      return
    }
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
      const searchKw = coerceDiscoverQuery(this.data.discoverUserQuery).trim()
      const [followingList, followerList, searchList, conversations] = await Promise.all([
        app.getFollowingList(),
        app.getFollowerList(),
        app.searchUsers(searchKw),
        this.data.mode === 'chat' ? app.getConversationList() : Promise.resolve([])
      ])

      const [resolvedFollowing, resolvedFollower, resolvedSearch, resolvedRecent] = await Promise.all([
        resolveUserListMedia(followingList || []),
        resolveUserListMedia(followerList || []),
        resolveUserListMedia(searchList || []),
        this.resolveConversationUsers(conversations || [])
      ])

      const shareAuthorCard = await this.resolveShareAuthorCard()

      this.setData({
        followingList: resolvedFollowing,
        followerList: resolvedFollower,
        searchList: resolvedSearch,
        recentChatList: resolvedRecent,
        shareAuthorCard,
        loading: false
      })
    } catch (err) {
      this.setData({ loading: false, searchLoading: false })
      wx.showToast({ title: '列表加载失败，请下拉重试', icon: 'none' })
    }
  },

  onTabChange(e) {
    this.setData({ currentTab: parseInt(e.currentTarget.dataset.index, 10) || 0 })
  },

  onDiscoverSearchChange(e) {
    const raw = e && e.detail && e.detail.value != null ? String(e.detail.value) : ''
    const keyword = coerceDiscoverQuery(raw)
    this.setData({ discoverUserQuery: keyword, searchLoading: true })

    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }

    const requestKeyword = keyword
    this.searchTimer = setTimeout(async () => {
      try {
        const searchList = await app.searchUsers(requestKeyword)
        const resolvedSearch = await resolveUserListMedia(searchList || [])
        if (this._unloaded || requestKeyword !== this.data.discoverUserQuery) return
        this.setData({ searchList: resolvedSearch, searchLoading: false })
      } catch (err) {
        if (this._unloaded || requestKeyword !== this.data.discoverUserQuery) return
        this.setData({ searchLoading: false })
        wx.showToast({ title: '搜索失败，请稍后重试', icon: 'none' })
      }
    }, keyword.trim() ? 250 : 0)
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
    if (!openid) return
    if (this.data.mode === 'chat') {
      const nickname = e.currentTarget.dataset.nickname || ''
      const extra = this.data.shareType && this.data.shareId
        ? `&shareType=${encodeURIComponent(this.data.shareType)}&shareId=${encodeURIComponent(this.data.shareId)}&autoShare=${encodeURIComponent(this.data.autoShare || '')}`
        : ''
      wx.navigateTo({
        url: `/pages/chat/chat?openid=${encodeURIComponent(openid)}&nickname=${encodeURIComponent(nickname)}${extra}`
      })
    } else {
      wx.navigateTo({ url: `/pages/profile/profile?openid=${encodeURIComponent(openid)}` })
    }
  },

  onChatTap(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    const nickname = e.currentTarget.dataset.nickname || ''
    const extra = this.data.shareType && this.data.shareId
      ? `&shareType=${encodeURIComponent(this.data.shareType)}&shareId=${encodeURIComponent(this.data.shareId)}&autoShare=${encodeURIComponent(this.data.autoShare || '')}`
      : ''
    wx.navigateTo({
      url: `/pages/chat/chat?openid=${encodeURIComponent(openid)}&nickname=${encodeURIComponent(nickname)}${extra}`
    })
  },

  async resolveConversationUsers(conversations = []) {
    if (!Array.isArray(conversations) || conversations.length === 0) return []
    const deduped = []
    const seen = new Set()
    conversations.forEach((item) => {
      const openid = item && item.targetOpenid
      if (!openid || seen.has(openid)) return
      seen.add(openid)
      const nick =
        item.targetNickName ||
        item.targetNickname ||
        item.target_nickname ||
        '同学'
      deduped.push({
        _openid: openid,
        nickName: nick,
        college: '最近私信',
        avatarUrl: item.targetAvatar || '/images/avatar_default.png'
      })
    })
    return resolveUserListMedia(deduped.slice(0, 8))
  },

  async resolveShareAuthorCard() {
    if (this.data.mode !== 'chat' || this.data.shareType !== 'post') return null
    let authorOpenid = this._shareAuthorFromOptions && this._shareAuthorFromOptions.openid
    let authorNickname = this._shareAuthorFromOptions && this._shareAuthorFromOptions.nickname

    if (!authorOpenid && this.data.shareId) {
      const post = await app.getPostById(this.data.shareId).catch(() => null)
      if (post && post._openid) {
        authorOpenid = post._openid
        authorNickname = authorNickname || post.nickname || ''
      }
    }
    if (!authorOpenid || authorOpenid === app.globalData.openid) return null

    const author = await app.getUserInfo(authorOpenid).catch(() => null)
    const merged = {
      _openid: authorOpenid,
      nickName: (author && author.nickName) || authorNickname || '帖子作者',
      college: (author && author.college) || '帖子作者',
      avatarUrl: (author && author.avatarUrl) || '/images/avatar_default.png'
    }
    const [resolved] = await resolveUserListMedia([merged])
    return resolved || merged
  },

  onQuickChatTap(e) {
    const openid = e.currentTarget.dataset.openid
    const nickname = e.currentTarget.dataset.nickname || ''
    if (!openid) return
    const extra = this.data.shareType && this.data.shareId
      ? `&shareType=${encodeURIComponent(this.data.shareType)}&shareId=${encodeURIComponent(this.data.shareId)}&autoShare=${encodeURIComponent(this.data.autoShare || '')}`
      : ''
    wx.navigateTo({
      url: `/pages/chat/chat?openid=${encodeURIComponent(openid)}&nickname=${encodeURIComponent(nickname)}${extra}`
    })
  }
})
