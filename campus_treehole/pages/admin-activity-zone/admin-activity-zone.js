const app = getApp()
const { CAMPUSES } = require('../../utils/campuses.js')

function emptySlide() {
  return {
    image: '',
    localPath: '',
    previewUrl: '',
    uploading: false,
    title: '',
    subtitle: '',
    content: '',
    activityTime: '',
    participation: '',
    rewards: '',
    ctaText: '了解详情'
  }
}

Page({
  data: {
    enabled: false,
    campusIds: [],
    campusOptions: CAMPUSES.map((c) => ({ ...c, selected: false })),
    slides: [emptySlide()],
    saving: false,
    ending: false,
    activityRunning: false,
    activePostCount: 0,
    roundId: '',
    endAtDate: '',
    endAtTime: '',
    lastEndedAt: ''
  },

  _syncCampusOptions(campusIds) {
    const selectedSet = new Set(Array.isArray(campusIds) ? campusIds : [])
    const options = CAMPUSES.map((c) => ({
      ...c,
      selected: selectedSet.has(c.id)
    }))
    this.setData({ campusIds: Array.from(selectedSet), campusOptions: options })
  },

  async onShow() {
    const u = app.globalData.userInfo
    if (!u || u.role !== 'admin') {
      wx.showToast({ title: '仅管理员可用', icon: 'none' })
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/mine/mine' }) })
      return
    }
    await this.loadConfig()
  },

  async loadConfig() {
    const data = await app.getActivityZoneAdmin()
    const slidesRaw = Array.isArray(data.slides) && data.slides.length
      ? data.slides.map((s) => ({
        image: String(s.image || ''),
        localPath: '',
        previewUrl: '',
        uploading: false,
        title: s.title || '',
        subtitle: s.subtitle || '',
        content: s.content || '',
        activityTime: s.activityTime || '',
        participation: s.participation || '',
        rewards: s.rewards || '',
        ctaText: s.ctaText || '了解详情'
      }))
      : [emptySlide()]

    const ids = slidesRaw.map((s) => s.image).filter((x) => typeof x === 'string' && x.startsWith('cloud://'))
    const map = ids.length ? await app.resolveFileUrlsMap(ids) : {}
    slidesRaw.forEach((s) => {
      if (s.image && map[s.image]) s.previewUrl = map[s.image]
      else if (s.image) s.previewUrl = s.image
    })

    this._syncCampusOptions(Array.isArray(data.campusIds) ? data.campusIds : [])
    const endParts = this._splitEndAt(data.endAt)
    this.setData({
      enabled: !!data.enabled,
      slides: slidesRaw,
      activityRunning: !!data.activityRunning,
      activePostCount: Number(data.activePostCount) || 0,
      roundId: data.roundId || '',
      endAtDate: endParts.date,
      endAtTime: endParts.time,
      lastEndedAt: data.lastEndedAt ? this._formatEndedAt(data.lastEndedAt) : ''
    })
  },

  _splitEndAt(iso) {
    if (!iso) return { date: '', time: '' }
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return { date: '', time: '' }
    const pad = (n) => String(n).padStart(2, '0')
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
  },

  _formatEndedAt(raw) {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return String(raw || '')
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  },

  _buildEndAtIso() {
    const date = String(this.data.endAtDate || '').trim()
    const time = String(this.data.endAtTime || '23:59').trim() || '23:59'
    if (!date) return null
    const iso = new Date(`${date}T${time}:00`)
    return Number.isNaN(iso.getTime()) ? null : iso.toISOString()
  },

  onEndAtDateChange(e) {
    this.setData({ endAtDate: (e.detail && e.detail.value) || '' })
  },

  onEndAtTimeChange(e) {
    this.setData({ endAtTime: (e.detail && e.detail.value) || '' })
  },

  onClearEndAt() {
    this.setData({ endAtDate: '', endAtTime: '' })
  },

  onSwitchEnabled(e) {
    this.setData({ enabled: !!e.detail.value })
  },

  onSelectAllCampuses() {
    this._syncCampusOptions(CAMPUSES.map((c) => c.id))
  },

  onClearAllCampuses() {
    this._syncCampusOptions([])
  },

  onToggleCampus(e) {
    const id = String((e.currentTarget.dataset || {}).id || '').trim()
    if (!id) return
    const current = Array.isArray(this.data.campusIds) ? this.data.campusIds.slice() : []
    const idx = current.indexOf(id)
    if (idx !== -1) current.splice(idx, 1)
    else current.push(id)
    this._syncCampusOptions(current)
  },

  onSlideInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    if (Number.isNaN(index) || !field) return
    const value = (e.detail && e.detail.value) || ''
    this.setData({ [`slides[${index}].${field}`]: value })
  },

  onChooseSlideImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index)) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f || !f.tempFilePath) return
        this._startSlideUpload(index, f.tempFilePath)
      },
      fail: (err) => {
        if (err && err.errMsg && String(err.errMsg).includes('cancel')) return
        console.error('[chooseMedia]', err)
        wx.showToast({ title: '选择图片失败', icon: 'none' })
      }
    })
  },

  _quickValidateImage(filePath) {
    return new Promise((resolve) => {
      wx.getFileSystemManager().getFileInfo({
        filePath,
        success: (fi) => {
          if (fi.size > 10 * 1024 * 1024) {
            resolve({ pass: false, errMsg: '图片过大（最大 10MB）' })
            return
          }
          resolve({ pass: true })
        },
        fail: () => resolve({ pass: false, errMsg: '无法读取图片' })
      })
    })
  },

  async _quickBannerFile(filePath) {
    try {
      const TARGET_RATIO = 16 / 9
      const info = await new Promise((resolve, reject) => {
        wx.getImageInfo({ src: filePath, success: resolve, fail: reject })
      })
      const srcW = Number(info.width) || 0
      const srcH = Number(info.height) || 0
      if (!srcW || !srcH) return filePath

      if (srcH > srcW) {
        return await this._cropToBanner(filePath, 720)
      }
      const ratio = srcW / srcH
      if (Math.abs(ratio - TARGET_RATIO) < 0.03) {
        return await this._prepareCropSource(filePath)
      }
      if (srcW >= srcH) {
        return await this._cropToBanner(filePath, 720)
      }
      return await this._prepareCropSource(filePath)
    } catch (e) {
      console.warn('[quickBanner] use original file', e)
      return filePath
    }
  },

  async _startSlideUpload(index, tempFilePath) {
    this.setData({
      [`slides[${index}].localPath`]: tempFilePath,
      [`slides[${index}].previewUrl`]: tempFilePath,
      [`slides[${index}].image`]: '',
      [`slides[${index}].uploading`]: true
    })
    try {
      const toUpload = await this._quickBannerFile(tempFilePath)
      const v = await this._quickValidateImage(toUpload)
      if (!v.pass) throw new Error(v.errMsg || '图片校验未通过')
      const fileID = await this._uploadLocal(toUpload)
      if (!fileID) throw new Error('上传失败')
      const map = await app.resolveFileUrlsMap([fileID])
      const previewUrl = map[fileID] || tempFilePath
      this.setData({
        [`slides[${index}].image`]: fileID,
        [`slides[${index}].localPath`]: '',
        [`slides[${index}].previewUrl`]: previewUrl,
        [`slides[${index}].uploading`]: false
      })
      wx.showToast({ title: '已上传', icon: 'success', duration: 1200 })
    } catch (err) {
      console.error('[slide upload]', err)
      const msg =
        (err && err.errMsg) ||
        (err && err.message) ||
        (typeof err === 'string' ? err : '') ||
        '上传失败'
      this.setData({
        [`slides[${index}].uploading`]: false,
        [`slides[${index}].localPath`]: '',
        [`slides[${index}].previewUrl`]: '',
        [`slides[${index}].image`]: ''
      })
      wx.showToast({ title: msg.length > 40 ? '上传失败，请重试' : msg, icon: 'none' })
    }
  },

  async _cropToBanner(filePath, outW = 720) {
    const TARGET_RATIO = 16 / 9
    const srcPath = await this._prepareCropSource(filePath)
    const imageInfo = await new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: srcPath,
        success: resolve,
        fail: reject
      })
    })
    const srcW = Number(imageInfo.width) || 0
    const srcH = Number(imageInfo.height) || 0
    if (!srcW || !srcH) return srcPath

    // 已经是接近 16:9 的横图，直接复用，避免重复裁图耗时
    const ratio = srcW / srcH
    if (srcW >= srcH && Math.abs(ratio - TARGET_RATIO) < 0.03) {
      return srcPath
    }

    let cropW = srcW
    let cropH = srcH
    if (srcW / srcH > TARGET_RATIO) {
      cropW = Math.round(srcH * TARGET_RATIO)
      cropH = srcH
    } else {
      cropW = srcW
      cropH = Math.round(srcW / TARGET_RATIO)
    }
    const sx = Math.max(0, Math.floor((srcW - cropW) / 2))
    const sy = Math.max(0, Math.floor((srcH - cropH) / 2))

    const outH = Math.round(outW / TARGET_RATIO)
    const ctx = wx.createCanvasContext('bannerCropCanvas', this)
    ctx.clearRect(0, 0, outW, outH)
    ctx.drawImage(srcPath, sx, sy, cropW, cropH, 0, 0, outW, outH)

    await new Promise((resolve) => ctx.draw(false, resolve))

    try {
      const temp = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvasId: 'bannerCropCanvas',
          x: 0,
          y: 0,
          width: outW,
          height: outH,
          destWidth: outW,
          destHeight: outH,
          fileType: 'jpg',
          quality: 0.82,
          success: resolve,
          fail: reject
        }, this)
      })
      return (temp && temp.tempFilePath) || srcPath
    } catch (e) {
      console.warn('[banner crop] canvasToTempFilePath failed, fallback', e)
      return srcPath
    }
  },

  async _prepareCropSource(filePath) {
    const info = await new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: filePath,
        success: resolve,
        fail: reject
      })
    })
    const width = Number(info.width) || 0
    const height = Number(info.height) || 0
    const maxSide = Math.max(width, height)
    if (maxSide <= 2200) return filePath

    try {
      const compressed = await new Promise((resolve, reject) => {
        wx.compressImage({
          src: filePath,
          quality: 75,
          success: resolve,
          fail: reject
        })
      })
      return (compressed && compressed.tempFilePath) || filePath
    } catch (err) {
      return filePath
    }
  },

  onRemoveSlide(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index) || this.data.slides.length <= 1) return
    const next = this.data.slides.filter((_, i) => i !== index)
    this.setData({ slides: next.length ? next : [emptySlide()] })
  },

  onAddSlide() {
    if (this.data.slides.length >= 10) return
    this.setData({ slides: [...this.data.slides, emptySlide()] })
  },

  async _uploadLocal(path) {
    if (!path || !app.globalData.cloudReady) {
      if (!app.globalData.cloudReady) {
        throw new Error('云开发未就绪，请重启小程序')
      }
      throw new Error('无效的图片路径')
    }
    const ext = (path.split('.').pop() || 'jpg').split('?')[0].toLowerCase()
    const safeExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg'
    const cloudPath = `activity_zone/${Date.now()}_${Math.random().toString(36).slice(2)}.${safeExt}`
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath: path,
        success: (res) => resolve((res && res.fileID) || ''),
        fail: (err) => reject(err || new Error('uploadFile 失败'))
      })
    })
  },

  async onSave() {
    if (this.data.saving) return
    if (!Array.isArray(this.data.campusIds) || this.data.campusIds.length === 0) {
      wx.showToast({ title: '请至少选择一个校区', icon: 'none' })
      return
    }

    const slides = this.data.slides || []
    if (slides.some((s) => s.uploading)) {
      wx.showToast({ title: '图片正在上传，请稍候', icon: 'none' })
      return
    }

    let slidesPayload = []
    try {
      slidesPayload = await Promise.all(slides.map(async (s) => {
        let image = String(s.image || '').trim()
        if (!image && s.localPath) {
          const toUpload = await this._quickBannerFile(s.localPath)
          const v = await this._quickValidateImage(toUpload)
          if (!v.pass) throw new Error(v.errMsg || '图片校验未通过')
          image = await this._uploadLocal(toUpload)
          if (!image) throw new Error('图片上传失败')
        }
        return {
          image,
          title: s.title || '',
          subtitle: s.subtitle || '',
          content: s.content || '',
          activityTime: s.activityTime || '',
          participation: s.participation || '',
          rewards: s.rewards || '',
          ctaText: s.ctaText || '了解详情'
        }
      }))
    } catch (err) {
      wx.showToast({ title: err.message || '图片上传失败', icon: 'none' })
      return
    }

    const filled = slidesPayload.filter((s) => s.image || s.title)
    if (this.data.enabled && filled.length === 0) {
      wx.showToast({ title: '启用时请至少填写一张横幅（图或标题）', icon: 'none' })
      return
    }

    const campusIds = this.data.campusIds.length === CAMPUSES.length ? ['all'] : this.data.campusIds

    this.setData({ saving: true })
    const ok = await app.saveActivityZone({
      enabled: this.data.enabled,
      campusIds,
      slides: filled,
      endAt: this._buildEndAtIso(),
      startNewRound: !!this.data.startNewRoundOnSave
    })
    this.setData({ saving: false, startNewRoundOnSave: false })
    if (ok) {
      wx.showToast({ title: '已保存', icon: 'success' })
      await this.loadConfig()
    }
  },

  onStartNewRoundSave() {
    this.setData({ startNewRoundOnSave: true })
    this.onSave()
  },

  onEndActivityZone() {
    if (this.data.ending) return
    wx.showModal({
      title: '结束本期活动',
      content: '将把所有本期活动帖转为普通帖（校园生活），并清空活动专区横幅，确定继续？',
      confirmText: '结束',
      confirmColor: '#c62828',
      success: async (res) => {
        if (!res.confirm) return
        this.setData({ ending: true })
        const data = await app.endActivityZone()
        this.setData({ ending: false })
        if (data) await this.loadConfig()
      }
    })
  }
})
