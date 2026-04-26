const app = getApp()

function formatInteractionText(item) {
  const name = item.actorNickname || '有人'
  const title = item.itemTitle ? `《${item.itemTitle}》` : ''
  switch (item.type) {
    case 'post_comment':
      return `${name} 评论了你的帖子 ${title}`
    case 'comment_reply':
      return `${name} 回复了你的评论 ${title}`
    case 'post_like':
      return `${name} 点赞了你的帖子 ${title}`
    case 'comment_like':
      return `${name} 点赞了你的评论`
    case 'post_favorite':
      return `${name} 收藏了你的帖子 ${title}`
    case 'user_follow':
      return `${name} 关注了你`
    case 'goods_comment':
      return `${name} 评论了你的商品 ${title}`
    case 'goods_reply':
      return `${name} 回复了你在商品下的评论 ${title}`
    case 'goods_favorite':
      return `${name} 收藏了你的商品 ${title}`
    case 'goods_want':
      return `${name} 对你的商品点了想要 ${title}`
    default:
      return `${name} 和你有新的互动`
  }
}

function formatInteractionTypeLabel(type) {
  switch (type) {
    case 'post_comment':
    case 'goods_comment':
      return '评论'
    case 'comment_reply':
    case 'goods_reply':
      return '回复'
    case 'post_like':
    case 'comment_like':
      return '点赞'
    case 'post_favorite':
    case 'goods_favorite':
      return '收藏'
    case 'goods_want':
      return '想要'
    case 'user_follow':
      return '关注'
    default:
      return '互动'
  }
}

Page({
  data: {
    currentTab: 'chat',
    conversations: [],
    interactions: [],
    totalUnread: 0,
    interactionUnread: 0,
    loadError: '',
    interactionLoadError: '',
    loading: false,
    interactionLoading: false
  },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar) {
      tabBar.setData({ selected: 3 })
    }
    if (!app.ensureComplianceOnTabShow()) return
    setTimeout(() => {
      if (app.globalData.isLoggedIn) {
        this.bootstrapMessagePage()
      } else {
        app.waitForLogin((userInfo) => {
          if (userInfo) this.bootstrapMessagePage()
        })
      }
    }, 0)
  },

  onHide() {
    this.stopRefreshTimer()
  },

  onUnload() {
    this.stopRefreshTimer()
  },

  bootstrapMessagePage() {
    this.loadAllData()
    this.startRefreshTimer()
  },

  startRefreshTimer() {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      this.loadAllData({ silent: true })
    }, 15000)
  },

  stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  },

  async loadAllData({ silent = false } = {}) {
    const shouldAutoMarkInteractionRead = this.data.currentTab === 'interaction'
    const now = Date.now()
    const shouldFetchConversations = this.data.currentTab === 'chat' ||
      !this._lastConversationFetchAt ||
      now - this._lastConversationFetchAt > 30000
    const shouldFetchInteractions = shouldAutoMarkInteractionRead ||
      !this._lastInteractionFetchAt ||
      now - this._lastInteractionFetchAt > 30000

    const [chatUnread, interactionUnread] = await Promise.all([
      shouldFetchConversations
        ? this.loadConversations({ silent })
        : Promise.resolve(this.data.totalUnread || 0),
      shouldFetchInteractions
        ? this.loadInteractions({ silent, autoMarkRead: shouldAutoMarkInteractionRead })
        : Promise.resolve(this.data.interactionUnread || 0)
    ])

    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    app.setMessageBadgeCount((chatUnread || 0) + (interactionUnread || 0), tabBar)
  },

  async loadConversations({ silent = false } = {}) {
    if (!silent) {
      this.setData({ loading: true, loadError: '' })
    } else if (this.data.loadError) {
      this.setData({ loadError: '' })
    }
    try {
      const conversations = await app.getConversationList()
      const avatarMap = await app.resolveFileUrlsMap(conversations.map(item => item.targetAvatar))
      const formatted = conversations.map((c, index) => ({
        ...c,
        targetAvatar: avatarMap[c.targetAvatar] || c.targetAvatar || '/images/avatar_default.png',
        timeStr: app.formatTime(c.lastTime),
        isUnread: (c.unreadCount || 0) > 0,
        isLatest: index === 0
      }))
      const totalUnread = formatted.reduce((sum, item) => sum + (item.unreadCount || 0), 0)
      this.setData({ conversations: formatted, totalUnread, loading: false })
      this._lastConversationFetchAt = Date.now()
      return totalUnread
    } catch (err) {
      this.setData({ loading: false, loadError: '私信加载失败' })
      return this.data.totalUnread || 0
    }
  },

  async loadInteractions({ silent = false, autoMarkRead = false } = {}) {
    if (!silent) {
      this.setData({ interactionLoading: true, interactionLoadError: '' })
    } else if (this.data.interactionLoadError) {
      this.setData({ interactionLoadError: '' })
    }
    try {
      const list = await app.getInteractionNotifications()
      const avatarMap = await app.resolveFileUrlsMap(list.map(item => item.actorAvatar).concat(list.map(item => item.itemImage)))
      const formatted = list.map((item) => ({
        ...item,
        actorAvatar: avatarMap[item.actorAvatar] || item.actorAvatar || '/images/avatar_default.png',
        itemImage: avatarMap[item.itemImage] || item.itemImage || '',
        timeStr: app.formatTime(item.createTime),
        summaryText: formatInteractionText(item),
        typeLabel: formatInteractionTypeLabel(item.type)
      }))
      const interactionUnread = formatted.reduce((sum, item) => sum + (item.isRead ? 0 : 1), 0)
      let finalInteractionUnread = interactionUnread
      this.setData({
        interactions: formatted,
        interactionUnread,
        interactionLoading: false
      })

      if (autoMarkRead && formatted.length > 0) {
        const unreadIds = formatted.filter(item => !item.isRead).map(item => item._id)
        if (unreadIds.length > 0) {
          await app.markInteractionNotificationsRead(unreadIds)
          app.invalidateCacheByPrefix('unread:')
          finalInteractionUnread = 0
          this.setData({
            interactionUnread: 0,
            interactions: formatted.map(item => ({ ...item, isRead: true }))
          })
        }
      }
      this._lastInteractionFetchAt = Date.now()
      return finalInteractionUnread
    } catch (err) {
      this.setData({ interactionLoading: false, interactionLoadError: '互动消息加载失败' })
      return this.data.interactionUnread || 0
    }
  },

  onTabChange(e) {
    const nextTab = e.currentTarget.dataset.tab
    if (!nextTab || nextTab === this.data.currentTab) return
    this.setData({ currentTab: nextTab })
    if (nextTab === 'chat') {
      this.loadConversations({ silent: true }).then((chatUnread) => {
        const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
        app.setMessageBadgeCount((chatUnread || 0) + (this.data.interactionUnread || 0), tabBar)
      })
      return
    }
    if (nextTab === 'interaction') {
      this.loadInteractions({ silent: true, autoMarkRead: true }).then((interactionUnread) => {
        const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
        app.setMessageBadgeCount((this.data.totalUnread || 0) + (interactionUnread || 0), tabBar)
      })
    }
  },

  onChatTap(e) {
    const openid = e.currentTarget.dataset.openid
    const nickname = e.currentTarget.dataset.nickname || ''
    wx.navigateTo({
      url: `/pages/chat/chat?openid=${openid}&nickname=${encodeURIComponent(nickname)}`
    })
  },

  onNotificationTap(e) {
    const { targetType, targetId, postId, goodsId, fromOpenid } = e.currentTarget.dataset
    if (!targetType) return
    if (targetType === 'user' && fromOpenid) {
      wx.navigateTo({ url: `/pages/profile/profile?openid=${fromOpenid}` })
      return
    }
    if (targetType === 'goods' && (goodsId || targetId)) {
      wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${goodsId || targetId}` })
      return
    }
    if (targetType === 'comment' && postId) {
      wx.navigateTo({ url: `/pages/detail/detail?id=${postId}` })
      return
    }
    if (targetType === 'post' && (postId || targetId)) {
      wx.navigateTo({ url: `/pages/detail/detail?id=${postId || targetId}` })
    }
  },

  onNewChat() {
    wx.navigateTo({ url: '/pages/follow/follow?mode=chat' })
  },

  onRetryLoad() {
    this.loadAllData()
  },

  onPullDownRefresh() {
    wx.showLoading({ title: '刷新中', mask: false })
    this.loadAllData({ silent: true })
      .finally(() => {
        wx.stopPullDownRefresh()
        wx.hideLoading()
      })
  }
})
