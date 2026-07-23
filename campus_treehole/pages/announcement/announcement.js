const app = getApp()

Page({
  data: {
    list: [],
    loading: false,
    hasMore: true,
    page: 1
  },

  onLoad() {
    this.loadList(1)
  },

  async loadList(page = 1) {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const rows = await app.getAnnouncementList(page, 20)
      const merged = page === 1 ? rows : [...this.data.list, ...rows]
      this.setData({
        list: merged,
        page,
        hasMore: rows.length >= 20,
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  async onTapItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    await app.markAnnouncementRead(id)
    const idx = this.data.list.findIndex((x) => x._id === id)
    if (idx !== -1 && !this.data.list[idx]._readMarked) {
      this.setData({
        [`list[${idx}]._readMarked`]: true
      })
    }
  },

  onPullDownRefresh() {
    this.loadList(1).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.loadList(this.data.page + 1)
  }
})
