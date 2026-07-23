const app = getApp()
const { CAMPUSES } = require('../../utils/campuses.js')

Page({
  data: {
    id: '',
    saving: false,
    title: '',
    content: '',
    priority: 'normal',
    pinTop: false,
    campusIds: [],
    campusOptions: CAMPUSES.map((c) => ({ ...c, selected: false })),
    imageItems: []
  },

  onLoad(options) {
    const id = String((options && options.id) || '').trim()
    if (!id) {
      wx.showToast({ title: '缺少公告ID', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.setData({ id })
    this.loadDetail()
  },

  _syncCampusOptions(campusIds) {
    const selectedSet = new Set(Array.isArray(campusIds) ? campusIds : [])
    const options = CAMPUSES.map((c) => ({
      ...c,
      selected: selectedSet.has(c.id)
    }))
    this.setData({ campusIds: Array.from(selectedSet), campusOptions: options })
  },

  async loadDetail() {
    wx.showLoading({ title: '加载中...' })
    let item = null
    try {
      const result = await app.callDB('getAnnouncementDetail', { announcementId: this.data.id })
      item = result && result.data ? result.data : null
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '获取公告失败', icon: 'none' })
      return
    }
    wx.hideLoading()
    if (!item) return
    const campusIds = Array.isArray(item.campusIds)
      ? (item.campusIds.includes('all') ? CAMPUSES.map((c) => c.id) : item.campusIds)
      : []
    const rawImages = Array.isArray(item.images) ? item.images.filter(Boolean) : []
    const urlMap = rawImages.length ? await app.resolveFileUrlsMap(rawImages) : {}
    const imageItems = rawImages.map((fileID) => ({
      fileID,
      src: urlMap[fileID] || fileID,
      isNew: false
    }))
    this._syncCampusOptions(campusIds)
    this.setData({
      title: item.title || '',
      content: item.content || '',
      priority: item.priority || 'normal',
      pinTop: !!item.pinTop,
      imageItems
    })
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

  onSelectAllCampuses() {
    this._syncCampusOptions(CAMPUSES.map((c) => c.id))
  },

  onClearAllCampuses() {
    this._syncCampusOptions([])
  },

  onToggleCampus(e) {
    const id = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!id) return
    const next = Array.isArray(this.data.campusIds) ? this.data.campusIds.slice() : []
    const i = next.indexOf(id)
    if (i >= 0) next.splice(i, 1)
    else next.push(id)
    this._syncCampusOptions(next)
  },

  onChooseImages() {
    const remain = 10 - (this.data.imageItems || []).length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传10张图片', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const list = (res.tempFiles || []).map((f) => ({
          filePath: f.tempFilePath,
          src: f.tempFilePath,
          isNew: true
        }))
        this.setData({ imageItems: [...this.data.imageItems, ...list] })
      }
    })
  },

  onRemoveImage(e) {
    const idx = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(idx)) return
    const next = [...(this.data.imageItems || [])]
    next.splice(idx, 1)
    this.setData({ imageItems: next })
  },

  async _uploadNewImages() {
    const newItems = (this.data.imageItems || []).filter((x) => x && x.isNew && x.filePath)
    if (!newItems.length) return []
    const localPaths = newItems.map((x) => x.filePath)
    const mediaCheck = await app.checkAllMedia(localPaths, [])
    if (!mediaCheck.pass) {
      wx.showToast({ title: mediaCheck.errMsg || '图片未通过审核', icon: 'none' })
      return null
    }
    const uploaded = []
    for (let i = 0; i < localPaths.length; i++) {
      const path = localPaths[i]
      const ext = (path.split('.').pop() || 'jpg').split('?')[0]
      const cloudPath = `announcements/${Date.now()}_edit_${i}.${ext}`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: path })
      if (up && up.fileID) uploaded.push(up.fileID)
    }
    return uploaded
  },

  async onSave() {
    if (this.data.saving) return
    const title = String(this.data.title || '').trim()
    const content = String(this.data.content || '').trim()
    if (!title || !content) {
      wx.showToast({ title: '请填写标题和内容', icon: 'none' })
      return
    }
    if (!this.data.campusIds.length) {
      wx.showToast({ title: '请至少选择一个校区', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    let uploaded = []
    try {
      const up = await this._uploadNewImages()
      if (up === null) {
        this.setData({ saving: false })
        return
      }
      uploaded = up
    } catch (e) {
      wx.showToast({ title: '图片上传失败', icon: 'none' })
      this.setData({ saving: false })
      return
    }
    const existed = (this.data.imageItems || [])
      .filter((x) => x && !x.isNew && x.fileID && String(x.fileID).startsWith('cloud://'))
      .map((x) => x.fileID)
    const images = [...existed, ...uploaded]
    const campusIds = this.data.campusIds.length === CAMPUSES.length ? ['all'] : this.data.campusIds
    const ok = await app.updateAnnouncement(this.data.id, {
      title,
      content,
      priority: this.data.priority,
      pinTop: this.data.pinTop,
      campusIds,
      images
    })
    this.setData({ saving: false })
    if (!ok) return
    wx.showToast({ title: '保存成功', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 400)
  }
})
