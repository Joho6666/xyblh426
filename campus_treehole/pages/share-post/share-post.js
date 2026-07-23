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

async function resolveUserListMedia(list = []) {
  const avatarMap = await app.resolveFileUrlsMap(list.map(item => item.avatarUrl))
  return list.map(item => ({
    ...item,
    avatarUrl: avatarMap[item.avatarUrl] || item.avatarUrl || '/images/avatar_default.png'
  }))
}

Page({
  data: {
    shareType: '',
    shareId: '',
    autoShare: '',
    shareAuthorCard: null,
    recentChatList: [],
    filteredChatList: [],
    searchKeyword: '',
    loading: false
  },

  onLoad(options) {
    this._shareAuthorFromOptions = {
      openid: decodeSafe(safeOptionText(options.authorOpenid)),
      nickname: decodeSafe(safeOptionText(options.authorNickname))
    }
    this.setData({
      shareType: safeOptionText(options.shareType),
      shareId: safeOptionText(options.shareId),
      autoShare: safeOptionText(options.autoShare)
    })
    this.bootPage()
  },

  onShow() {
    if (app.globalData.isLoggedIn) {
      this.refreshData()
    }
  },

  bootPage() {
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
      const [conversations, shareAuthorCard] = await Promise.all([
        app.getConversationList(),
        this.resolveShareAuthorCard()
      ])
      const recentChatList = await this.resolveConversationUsers(conversations || [])
      this.setData({
        shareAuthorCard,
        recentChatList,
        filteredChatList: this.filterRecentChats(recentChatList, this.data.searchKeyword),
        loading: false
      })
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' })
    }
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => wx.stopPullDownRefresh())
  },

  onSearchInput(e) {
    const keyword = typeof (e && e.detail && e.detail.value) === 'string' ? e.detail.value : ''
    this.setData({
      searchKeyword: keyword,
      filteredChatList: this.filterRecentChats(this.data.recentChatList, keyword)
    })
  },

  onClearSearch() {
    this.setData({
      searchKeyword: '',
      filteredChatList: this.filterRecentChats(this.data.recentChatList, '')
    })
  },

  filterRecentChats(list = [], keyword = '') {
    const cleanKeyword = (keyword || '').trim().toLowerCase()
    if (!cleanKeyword) return list
    return list.filter((item) => {
      const name = (item.nickName || '').toLowerCase()
      const college = (item.college || '').toLowerCase()
      return name.includes(cleanKeyword) || college.includes(cleanKeyword)
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
    return resolveUserListMedia(deduped)
  },

  async resolveShareAuthorCard() {
    if (this.data.shareType !== 'post') return null
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

  onShareTargetTap(e) {
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
