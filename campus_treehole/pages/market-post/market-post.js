// pages/market-post/market-post.js - 发布闲置商品
const app = getApp()
const { MARKET_PUBLISH_CATEGORIES, normalizePublishCategory } = require('../../utils/marketCategories')
const MARKET_DRAFT_KEY = 'market_post_draft_v1'

Page({
  data: {
    selectedImages: [],
    title: '',
    description: '',
    price: '',
    originalPrice: '',
    selectedCategory: '',
    condition: '',
    tradeMethod: '',
    bargain: null,
    publishing: false,
    showCategoryPicker: false,
    draftStatus: '',
    categoryList: MARKET_PUBLISH_CATEGORIES
  },

  _buildDraftPayload() {
    return {
      selectedImages: this.data.selectedImages,
      title: this.data.title,
      description: this.data.description,
      price: this.data.price,
      originalPrice: this.data.originalPrice,
      selectedCategory: this.data.selectedCategory,
      condition: this.data.condition,
      tradeMethod: this.data.tradeMethod,
      bargain: this.data.bargain,
      savedAt: Date.now()
    }
  },

  _hasDraftContent() {
    return !!(
      this.data.selectedImages.length ||
      this.data.title.trim() ||
      this.data.description.trim() ||
      this.data.price ||
      this.data.originalPrice ||
      this.data.selectedCategory
    )
  },

  _setDraftStatus(text) {
    this.setData({ draftStatus: text })
    if (this.draftStatusTimer) {
      clearTimeout(this.draftStatusTimer)
    }
    if (!text) return
    this.draftStatusTimer = setTimeout(() => {
      this.setData({ draftStatus: '' })
    }, 2000)
  },

  saveDraft({ silent = false } = {}) {
    if (!this._hasDraftContent()) {
      wx.removeStorageSync(MARKET_DRAFT_KEY)
      if (!silent) {
        wx.showToast({ title: '没有可保存的内容', icon: 'none' })
      }
      return false
    }
    wx.setStorageSync(MARKET_DRAFT_KEY, this._buildDraftPayload())
    if (silent) {
      this._setDraftStatus('已自动保存草稿')
    } else {
      wx.showToast({ title: '草稿已保存', icon: 'none' })
      this._setDraftStatus('草稿已保存')
    }
    return true
  },

  _filterValidDraftImages(images) {
    const fs = wx.getFileSystemManager()
    return (images || []).filter((item) => {
      if (!item) return false
      if (item.fileId) return true
      const filePath = item.path
      if (!filePath) return false
      if (/^(https?:|cloud:\/\/)/.test(filePath)) return true
      try {
        fs.accessSync(filePath)
        return true
      } catch (e) {
        return false
      }
    })
  },

  onLoad() {
    const draft = wx.getStorageSync(MARKET_DRAFT_KEY)
    if (!draft) return
    wx.showModal({
      title: '发现草稿',
      content: '是否恢复上次未发布的闲置信息？',
      confirmColor: '#ff2442',
      success: (res) => {
        if (res.confirm) {
          const validImages = this._filterValidDraftImages(draft.selectedImages)
          const lostCount = (draft.selectedImages || []).length - validImages.length
          this.setData({
            selectedImages: validImages,
            title: draft.title || '',
            description: draft.description || '',
            price: draft.price || '',
            originalPrice: draft.originalPrice || '',
            selectedCategory: normalizePublishCategory(draft.selectedCategory || ''),
            condition: draft.condition || '',
            tradeMethod: draft.tradeMethod || '',
            bargain: draft.bargain !== undefined ? draft.bargain : null
          })
          if (lostCount > 0) {
            this._setDraftStatus(`已恢复草稿（${lostCount}张图片已过期）`)
          } else {
            this._setDraftStatus('已恢复上次草稿')
          }
        } else {
          wx.removeStorageSync(MARKET_DRAFT_KEY)
        }
      }
    })
  },

  onHide() {
    if (!this.data.publishing) {
      this.saveDraft({ silent: true })
    }
  },

  onUnload() {
    if (!this.data.publishing) {
      this.saveDraft({ silent: true })
    }
    if (this.draftStatusTimer) {
      clearTimeout(this.draftStatusTimer)
      this.draftStatusTimer = null
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  // 选择图片
  onChooseImage() {
    const remaining = 9 - this.data.selectedImages.length
    if (remaining <= 0) return
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newImages = res.tempFiles.map(f => ({ path: f.tempFilePath, size: f.size }))
        this.setData({ selectedImages: [...this.data.selectedImages, ...newImages] })
      }
    })
  },

  onRemoveImage(e) {
    const images = [...this.data.selectedImages]
    images.splice(e.currentTarget.dataset.index, 1)
    this.setData({ selectedImages: images })
  },

  onPreviewImage(e) {
    const urls = this.data.selectedImages.map(i => i.path)
    wx.previewImage({ current: urls[e.currentTarget.dataset.index], urls })
  },

  onCondition(e) { this.setData({ condition: e.currentTarget.dataset.val }) },
  onTrade(e) { this.setData({ tradeMethod: e.currentTarget.dataset.val }) },
  onBargain(e) { this.setData({ bargain: e.currentTarget.dataset.val === 'true' }) },

  onShowCategoryPicker() { this.setData({ showCategoryPicker: true }) },
  onHideCategoryPicker() { this.setData({ showCategoryPicker: false }) },
  onPickCategory(e) {
    this.setData({ selectedCategory: e.currentTarget.dataset.name, showCategoryPicker: false })
  },

  // 上传图片到云存储
  async _compressImageIfNeeded(filePath) {
    try {
      const info = await wx.getImageInfo({ src: filePath })
      const width = info && info.width ? Number(info.width) : 0
      const height = info && info.height ? Number(info.height) : 0
      const longSide = Math.max(width, height)
      if (!longSide || longSide <= 1600) return filePath
      const quality = longSide > 2200 ? 55 : 65
      const compressed = await wx.compressImage({ src: filePath, quality })
      return (compressed && compressed.tempFilePath) || filePath
    } catch (e) {
      return filePath
    }
  },

  async _uploadImages(imagePaths) {
    const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
    const stamp = Date.now()
    const tasks = imagePaths.map(async (rawPath, i) => {
      const uploadPath = await this._compressImageIfNeeded(rawPath)
      let ext = (rawPath.split('.').pop() || 'jpg').split('?')[0].toLowerCase()
      if (ext.length > 5 || !ALLOWED_EXTS.includes(ext)) ext = 'jpg'
      const cloudPath = `market/${stamp}_${i}_${Math.random().toString(36).slice(2, 9)}.${ext}`
      try {
        const res = await wx.cloud.uploadFile({ cloudPath, filePath: uploadPath })
        if (!res || !res.fileID) {
          throw new Error(`第${i + 1}张图片上传失败`)
        }
        return { i, fileID: res.fileID }
      } catch (err) {
        console.error(`[market-post] 图片 ${i + 1} 上传失败:`, err)
        throw new Error(`第${i + 1}张图片上传失败，请检查网络后重试`)
      }
    })
    const rows = await Promise.all(tasks)
    rows.sort((a, b) => a.i - b.i)
    return rows.map((r) => r.fileID)
  },

  // 发布
  async onPublish() {
    if (this.data.publishing) return

    // 校验
    if (this.data.selectedImages.length === 0) {
      wx.showToast({ title: '请至少上传一张图片', icon: 'none' }); return
    }
    if (!this.data.title.trim()) {
      wx.showToast({ title: '请填写标题', icon: 'none' }); return
    }
    if (!this.data.price || isNaN(parseFloat(this.data.price)) || parseFloat(this.data.price) <= 0) {
      wx.showToast({ title: '请填写有效的价格', icon: 'none' }); return
    }
    if (!this.data.selectedCategory) {
      wx.showToast({ title: '请选择分类', icon: 'none' }); return
    }

    // 前端内容审核
    const titleCheck = app.checkContent(this.data.title)
    if (!titleCheck.pass) {
      wx.showModal({ title: '内容审核未通过', content: `标题包含违规内容"${titleCheck.word}"`, showCancel: false }); return
    }
    if (this.data.description) {
      const descCheck = app.checkContent(this.data.description)
      if (!descCheck.pass) {
        wx.showModal({ title: '内容审核未通过', content: `描述包含违规内容"${descCheck.word}"`, showCancel: false }); return
      }
    }
    if (this.data.originalPrice && (isNaN(parseFloat(this.data.originalPrice)) || parseFloat(this.data.originalPrice) <= 0)) {
      wx.showToast({ title: '原价需要大于 0', icon: 'none' }); return
    }
    if (this.data.originalPrice && parseFloat(this.data.originalPrice) < parseFloat(this.data.price)) {
      wx.showToast({ title: '原价不能低于现价', icon: 'none' }); return
    }

    this.setData({ publishing: true })
    wx.showLoading({ title: '上传图片...', mask: true })

    try {
      const imagePaths = this.data.selectedImages.map(i => i.path)
      // 图片安全仅由 addMarketGoods 内 wxImageBatchCheck 执行一次，避免此前「临时上传+contentCheck」再正式上传的双倍耗时
      const cloudImages = await this._uploadImages(imagePaths)

      wx.showLoading({ title: '审核并发布...', mask: true })
      const result = await app.callDB('addMarketGoods', {
        title: this.data.title,
        description: this.data.description,
        price: parseFloat(this.data.price),
        originalPrice: this.data.originalPrice ? parseFloat(this.data.originalPrice) : null,
        images: cloudImages,
        category: normalizePublishCategory(this.data.selectedCategory),
        condition: this.data.condition || '未说明',
        tradeMethod: this.data.tradeMethod || '均可',
        bargain: this.data.bargain !== null ? this.data.bargain : true,
        campusId: app.getSelectedCampusId()
      })

      wx.hideLoading()

      if (result && result.code === 0) {
        app.globalData.marketNeedsRefresh = true
        app.globalData.mineNeedsRefresh = true
        wx.removeStorageSync(MARKET_DRAFT_KEY)
        this.setData({ draftStatus: '' })
        wx.showToast({ title: '发布成功', icon: 'success', duration: 1500 })
        setTimeout(() => { wx.navigateBack() }, 1500)
      } else {
        this.setData({ publishing: false })
        wx.showToast({ title: (result && result.msg) || '发布失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ publishing: false })
      wx.showToast({ title: err.msg || err.message || '系统繁忙，发布失败', icon: 'none' })
    }
  },

  onSaveDraft() {
    this.saveDraft()
  }
})
