const app = getApp()

Page({
  data: {
    editNickName: '',
    editAvatarUrl: '',
    editCoverImage: '',
    editBio: '',
    editTags: [],
    tagInput: '',
    saving: false
  },

  onLoad() {
    const userInfo = app.globalData.userInfo || {}
    this.setData({
      editNickName: userInfo.nickName || '',
      editAvatarUrl: userInfo.avatarUrl || '/images/avatar_default.png',
      editCoverImage: userInfo.coverImage || '',
      editBio: userInfo.bio || '',
      editTags: Array.isArray(userInfo.tags) ? userInfo.tags.slice(0, 20) : []
    })
  },

  onNickNameInput(e) {
    this.setData({ editNickName: e.detail.value })
  },

  onBioInput(e) {
    this.setData({ editBio: e.detail.value })
  },

  onTagInput(e) {
    this.setData({ tagInput: e.detail.value })
  },

  onAddTag() {
    const raw = (this.data.tagInput || '').trim()
    if (!raw) return
    const normalized = raw.slice(0, 12)
    if (this.data.editTags.includes(normalized)) {
      wx.showToast({ title: '该兴趣已添加', icon: 'none' })
      return
    }
    if (this.data.editTags.length >= 20) {
      wx.showToast({ title: '最多添加20个兴趣', icon: 'none' })
      return
    }
    this.setData({
      editTags: [...this.data.editTags, normalized],
      tagInput: ''
    })
  },

  onDeleteTag(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index) || index < 0) return
    const tags = this.data.editTags.slice()
    tags.splice(index, 1)
    this.setData({ editTags: tags })
  },

  async onChooseAvatar() {
    const filePath = await this.pickImage('请选择头像图片')
    if (!filePath) return
    const check = await app.checkImageContent(filePath)
    if (!check || !check.pass) {
      wx.showToast({ title: (check && check.errMsg) || '头像未通过审核', icon: 'none' })
      return
    }
    this.setData({ editAvatarUrl: filePath })
  },

  async onChooseCover() {
    const filePath = await this.pickImage('请选择背景图片')
    if (!filePath) return
    const check = await app.checkImageContent(filePath)
    if (!check || !check.pass) {
      wx.showToast({ title: (check && check.errMsg) || '背景图未通过审核', icon: 'none' })
      return
    }
    this.setData({ editCoverImage: filePath })
  },

  pickImage() {
    return new Promise((resolve) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        success: (res) => {
          const temp = res && res.tempFiles && res.tempFiles[0] ? res.tempFiles[0].tempFilePath : ''
          resolve(temp || '')
        },
        fail: () => resolve('')
      })
    })
  },

  async uploadIfLocal(url, dir) {
    const raw = String(url || '').trim()
    if (!raw) return ''
    if (raw.startsWith('cloud://')) return raw
    if (!raw.startsWith('wxfile://') && !raw.startsWith('http://tmp/')) return raw
    const ext = raw.includes('.png') ? 'png' : 'jpg'
    const cloudPath = `${dir}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath: raw })
    return (uploadRes && uploadRes.fileID) || ''
  },

  async onSave() {
    if (this.data.saving) return

    const nickName = (this.data.editNickName || '').trim()
    const bio = (this.data.editBio || '').trim()
    const tags = (this.data.editTags || [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)

    if (!nickName) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    const nameCheck = app.checkContent(nickName)
    if (!nameCheck.pass) {
      wx.showToast({ title: '昵称包含违规内容', icon: 'none' })
      return
    }

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
      const avatarUrl = await this.uploadIfLocal(this.data.editAvatarUrl, 'avatars')
      const coverImage = await this.uploadIfLocal(this.data.editCoverImage, 'covers')
      result = await app.updateProfile({
        nickName,
        avatarUrl,
        coverImage,
        bio,
        tags
      })
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
