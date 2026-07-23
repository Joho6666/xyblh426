const app = getApp()
const { CAMPUSES } = require('../../utils/campuses.js')

Page({
  data: {
    list: [],
    loading: false,
    creating: false,
    title: '',
    content: '',
    priority: 'normal',
    pinTop: false,
    sendNotify: true,
    campusIds: [],
    campusOptions: CAMPUSES.map((c) => ({ ...c, selected: false })),
    selectedImages: []
  },

  _campusTextFromIds(ids) {
    const list = Array.isArray(ids) ? ids : []
    if (!list.length) return '未设置校区'
    if (list.includes('all')) return '全部校区'
    const map = CAMPUSES.reduce((acc, c) => {
      acc[c.id] = c.name
      return acc
    }, {})
    return list.map((id) => map[id] || id).join('、')
  },

  _syncCampusOptions(campusIds) {
    const selectedSet = new Set(Array.isArray(campusIds) ? campusIds : [])
    const options = CAMPUSES.map((c) => ({
      ...c,
      selected: selectedSet.has(c.id)
    }))
    this.setData({ campusIds: Array.from(selectedSet), campusOptions: options })
  },

  onShow() {
    const u = app.globalData.userInfo
    if (!u || u.role !== 'admin') {
      wx.showToast({ title: '仅管理员可用', icon: 'none' })
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/mine/mine' }) })
      return
    }
    // 每次进入页面默认不勾选校区，按管理员意图手动选择投放范围
    this._syncCampusOptions([])
    this.loadList()
  },

  async loadList() {
    this.setData({ loading: true })
    try {
      const rawList = await app.getAdminAnnouncementList(1, 50)
      const list = (rawList || []).map((item) => ({
        ...item,
        _campusText: this._campusTextFromIds(item.campusIds)
      }))
      this.setData({ list, loading: false })
    } catch (err) {
      console.error('[admin-announcement.loadList] 加载失败', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载公告列表失败，请重试', icon: 'none' })
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: (e.detail && e.detail.value) || '' })
  },

  onPickPriority(e) {
    const v = ['normal', 'important', 'urgent'][Number(e.detail.value) || 0] || 'normal'
    this.setData({ priority: v })
  },

  onSwitchPin(e) {
    this.setData({ pinTop: !!e.detail.value })
  },

  onSwitchNotify(e) {
    this.setData({ sendNotify: !!e.detail.value })
  },

  onSelectAllCampuses() {
    this._syncCampusOptions(CAMPUSES.map((c) => c.id))
  },

  onClearAllCampuses() {
    this._syncCampusOptions([])
  },

  onToggleCampus(e) {
    const ds = (e.currentTarget && e.currentTarget.dataset) || (e.target && e.target.dataset) || {}
    const id = String(ds.id || '').trim()
    if (!id) return
    const current = Array.isArray(this.data.campusIds) ? this.data.campusIds.slice() : []
    const idx = current.indexOf(id)
    if (idx !== -1) {
      current.splice(idx, 1)
    } else {
      current.push(id)
    }
    this._syncCampusOptions(current)
  },

  onChooseImages() {
    const remain = 10 - (this.data.selectedImages || []).length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传10张图片', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const list = (res.tempFiles || []).map((f) => ({ path: f.tempFilePath, size: f.size || 0 }))
        this.setData({ selectedImages: [...this.data.selectedImages, ...list] })
      }
    })
  },

  onRemoveImage(e) {
    const idx = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(idx)) return
    const next = [...this.data.selectedImages]
    next.splice(idx, 1)
    this.setData({ selectedImages: next })
  },

  async _uploadImagesForAnnouncement() {
    const imgs = this.data.selectedImages || []
    if (!imgs.length) return []
    const localPaths = imgs.map((x) => x.path).filter(Boolean)
    const mediaCheck = await app.checkAllMedia(localPaths, [])
    if (!mediaCheck.pass) {
      wx.showToast({ title: mediaCheck.errMsg || '图片未通过审核', icon: 'none' })
      return null
    }
    const uploaded = []
    for (let i = 0; i < localPaths.length; i++) {
      const path = localPaths[i]
      const ext = (path.split('.').pop() || 'jpg').split('?')[0]
      const cloudPath = `announcements/${Date.now()}_${i}.${ext}`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: path })
      if (up && up.fileID) uploaded.push(up.fileID)
    }
    return uploaded
  },

  onEditAnnouncement(e) {
    const id = String(e.currentTarget.dataset.id || '').trim()
    if (!id) return
    wx.navigateTo({
      url: `/pages/admin-announcement-edit/admin-announcement-edit?id=${encodeURIComponent(id)}`
    })
  },

  async onSubmit() {
    if (this.data.creating) return
    const title = String(this.data.title || '').trim()
    const content = String(this.data.content || '').trim()
    if (!title || !content) {
      wx.showToast({ title: '请填写标题和内容', icon: 'none' })
      return
    }
    if (!Array.isArray(this.data.campusIds) || this.data.campusIds.length === 0) {
      wx.showToast({ title: '请至少选择一个校区', icon: 'none' })
      return
    }
    this.setData({ creating: true })
    let images = []
    try {
      const uploaded = await this._uploadImagesForAnnouncement()
      if (uploaded === null) {
        this.setData({ creating: false })
        return
      }
      images = uploaded
    } catch (e) {
      wx.showToast({ title: '图片上传失败', icon: 'none' })
      this.setData({ creating: false })
      return
    }
    const campusIds = this.data.campusIds.length === CAMPUSES.length ? ['all'] : this.data.campusIds
    const created = await app.createAnnouncement({
      title,
      content,
      images,
      campusIds,
      priority: this.data.priority,
      pinTop: this.data.pinTop,
      status: 'draft'
    })
    if (!created || !created.data || !created.data._id) {
      this.setData({ creating: false })
      return
    }
    const publishRes = await app.publishAnnouncement(created.data._id, this.data.sendNotify)
    if (publishRes) {
      wx.showToast({ title: '公告已发布', icon: 'success' })
      this.setData({
        title: '',
        content: '',
        priority: 'normal',
        pinTop: false,
        sendNotify: true,
        campusIds: [],
        campusOptions: CAMPUSES.map((c) => ({ ...c, selected: false })),
        selectedImages: []
      })
      await this.loadList()
    }
    this.setData({ creating: false })
  },

  async onRevoke(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const res = await app.revokeAnnouncement(id)
    if (res) {
      wx.showToast({ title: '已撤回', icon: 'none' })
      this.loadList()
    }
  }
})
