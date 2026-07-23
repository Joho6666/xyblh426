const app = getApp()

async function resolveListAvatars(list = []) {
  const avatarMap = await app.resolveFileUrlsMap(list.map((item) => item.avatarUrl))
  return list.map((item) => ({
    ...item,
    avatarUrl: avatarMap[item.avatarUrl] || item.avatarUrl || '/images/avatar_default.png'
  }))
}

Page({
  data: {
    list: [],
    loading: true
  },

  onLoad() {
    app.waitForLogin((u) => {
      if (u) this.refresh()
    })
  },

  onShow() {
    if (app.globalData.isLoggedIn) this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  async refresh() {
    this.setData({ loading: true })
    try {
      const raw = await app.getBlockedUsersList(1, 100)
      const list = await resolveListAvatars(raw || [])
      this.setData({ list, loading: false })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  onOpenProfile(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.navigateTo({ url: `/pages/profile/profile?openid=${encodeURIComponent(openid)}` })
  },

  onUnblock(e) {
    const openid = e.currentTarget.dataset.openid
    const nickname = e.currentTarget.dataset.nickname || '该用户'
    if (!openid) return
    wx.showModal({
      title: '解除拉黑',
      content: `确定解除对「${nickname}」的拉黑吗？解除后如需关注请重新点关注。`,
      confirmText: '解除',
      confirmColor: '#426089',
      success: async (res) => {
        if (!res.confirm) return
        const payload = await app.toggleUserBlock(openid)
        if (!payload) return
        wx.showToast({ title: '已解除拉黑', icon: 'none' })
        await this.refresh()
      }
    })
  }
})
