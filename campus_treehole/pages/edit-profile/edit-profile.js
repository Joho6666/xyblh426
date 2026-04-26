const app = getApp()

Page({
  data: {
    editBio: '',
    editTags: '',
    saving: false
  },

  onLoad() {
    const userInfo = app.globalData.userInfo || {}
    this.setData({
      editBio: userInfo.bio || '',
      editTags: (userInfo.tags || []).join('、')
    })
  },

  onBioInput(e) {
    this.setData({ editBio: e.detail.value })
  },

  onTagsInput(e) {
    this.setData({ editTags: e.detail.value })
  },

  async onSave() {
    if (this.data.saving) return

    const bio = (this.data.editBio || '').trim()
    const tags = (this.data.editTags || '')
      .split(/[、,，\s]+/)
      .filter((t) => t.trim())
      .map((t) => t.trim())

    const bioCheck = app.checkContent(bio)
    if (!bioCheck.pass) {
      wx.showToast({ title: '简介包含违规内容', icon: 'none' })
      return
    }

    const tagsCheck = app.checkContent(tags.join(' '))
    if (!tagsCheck.pass) {
      wx.showToast({ title: '标签包含违规内容', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...' })

    let result = null
    try {
      result = await app.updateProfile({ bio, tags })
    } catch (err) {
      console.error('保存资料失败:', err)
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }

    if (!result) {
      wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
      return
    }

    app.globalData.mineNeedsRefresh = true
    wx.showToast({ title: '资料已保存', icon: 'success' })
    setTimeout(() => {
      wx.navigateBack()
    }, 500)
  }
})
