// pages/post/post.js - 发帖页逻辑
// 云数据库驱动：图片视频上传到云存储，帖子写入数据库

const app = getApp()
const feature = require('../../utils/feature.js')
const POST_DRAFT_KEY = 'post_draft_v2'

function clampPostCategoryIndex(raw, categoryList) {
  const len = Array.isArray(categoryList) && categoryList.length ? categoryList.length : 1
  const n = Number(raw)
  const idx = Number.isFinite(n) ? Math.floor(n) : 0
  return Math.max(0, Math.min(idx, len - 1))
}

Page({
  data: {
    allowPostVideo: feature.allowPostVideo,
    isAdmin: false,
    canPostVideo: false,
    editMode: false,
    editingPostId: '',
    pageTitle: '发布动态',
    publishButtonText: '立即发布',
    draftButtonText: '存草稿',
    currentCategory: 0,
    categoryList: [
      { name: '树洞', icon: '/images/cat_treehole.png' },
      { name: '求助', icon: '/images/cat_job.png' },
      { name: '找搭子', icon: '/images/cat_team.png' },
      { name: '校园生活', icon: '/images/cat_campus.png' },
      { name: '学术交流', icon: '/images/cat_study.png' },
      { name: '失物招领', icon: '/images/cat_emotion.png' },
      { name: '社团活动', icon: '/images/cat_help.png' },
      { name: '校园活动', icon: '/images/cat_team.png' },
      { name: '其他', icon: '/images/cat_trade.png' }
    ],
    title: '',
    content: '',
    selectedImages: [],
    selectedVideos: [],
    showEmojiPanel: false,
    emojiList: [
      '😀', '😂', '🤣', '😍', '🥰', '😘', '😋', '😎',
      '🤔', '😴', '🥳', '😭', '😱', '🤗', '😏', '🙄',
      '👍', '👎', '❤️', '🔥', '⭐', '🎉', '💪', '🙏',
      '😊', '😁', '😆', '😅', '🤪', '😜', '😝', '🤑',
      '🥺', '😤', '😡', '🤯', '😰', '😨', '😩', '😫',
      '🎵', '🎶', '📚', '💻', '🏀', '⚽', '🎮', '🍕'
    ],
    draftStatus: '',
    publishing: false
  },

  getDraftKey() {
    return this.data.editMode && this.data.editingPostId
      ? `post_edit_draft_${this.data.editingPostId}`
      : POST_DRAFT_KEY
  },

  _buildDraftPayload() {
    return {
      editMode: this.data.editMode,
      editingPostId: this.data.editingPostId,
      title: this.data.title,
      content: this.data.content,
      currentCategory: this.data.currentCategory,
      showEmojiPanel: false,
      selectedImages: this.data.selectedImages,
      selectedVideos: this.data.selectedVideos,
      savedAt: Date.now()
    }
  },

  _hasDraftContent() {
    return !!(
      this.data.title.trim() ||
      this.data.content.trim() ||
      this.data.selectedImages.length ||
      this.data.selectedVideos.length
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
      wx.removeStorageSync(this.getDraftKey())
      if (!silent) {
        wx.showToast({ title: '没有可保存的内容', icon: 'none' })
      }
      return false
    }
    wx.setStorageSync(this.getDraftKey(), this._buildDraftPayload())
    if (silent) {
      this._setDraftStatus('已自动保存草稿')
    } else {
      wx.showToast({ title: '草稿已保存', icon: 'none' })
      this._setDraftStatus('草稿已保存')
    }
    return true
  },

  onSelectCategory(e) {
    this.setData({ currentCategory: e.currentTarget.dataset.index })
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value })
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value })
  },

  // 选择图片
  onChooseImage() {
    const remaining = 9 - this.data.selectedImages.length
    if (remaining <= 0) {
      wx.showToast({ title: '最多选择9张图片', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newImages = res.tempFiles.map(file => ({
          path: file.tempFilePath,
          type: 'image',
          size: file.size
        }))
        this.setData({
          selectedImages: [...this.data.selectedImages, ...newImages]
        })
      }
    })
  },

  onRemoveImage(e) {
    const index = e.currentTarget.dataset.index
    const images = [...this.data.selectedImages]
    images.splice(index, 1)
    this.setData({ selectedImages: images })
  },

  onPreviewImage(e) {
    const index = e.currentTarget.dataset.index
    const urls = this.data.selectedImages.map(img => img.path)
    wx.previewImage({ current: urls[index], urls })
  },

  // 选择视频（功能关闭时仅提示，避免未完成审核链路）
  onChooseVideo() {
    if (!feature.allowPostVideo) {
      wx.showToast({ title: '视频发布功能升级中，当前仅支持图片', icon: 'none' })
      return
    }
    if (!this.data.canPostVideo) {
      wx.showToast({ title: '仅管理员可发布视频', icon: 'none' })
      return
    }
    if (this.data.selectedVideos.length >= 1) {
      wx.showToast({ title: '最多上传1个视频', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: 60,
      success: (res) => {
        const file = res.tempFiles[0]
        this.setData({
          selectedVideos: [{
            path: file.tempFilePath,
            thumbPath: file.thumbTempFilePath || '',
            duration: file.duration || 0,
            size: file.size
          }]
        })
      }
    })
  },

  onRemoveVideo(e) {
    const index = e.currentTarget.dataset.index
    const videos = [...this.data.selectedVideos]
    videos.splice(index, 1)
    this.setData({ selectedVideos: videos })
  },

  toggleEmojiPanel() {
    this.setData({ showEmojiPanel: !this.data.showEmojiPanel })
  },

  onSelectEmoji(e) {
    this.setData({ content: this.data.content + e.currentTarget.dataset.emoji })
  },

  // 草稿功能
  onSaveDraft() {
    this.saveDraft()
  },

  onShow() {
    if (!app.ensureComplianceOnTabShow()) return
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  _filterValidTempFiles(files) {
    const fs = wx.getFileSystemManager()
    return (files || []).filter((item) => {
      if (item.fileId) return true
      const filePath = item.path || item.thumbPath
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

  async onLoad(options) {
    const editMode = options.mode === 'edit' && !!options.id
    const nextData = editMode
      ? {
          editMode: true,
          editingPostId: options.id,
          pageTitle: '编辑帖子',
          publishButtonText: '保存更新',
          draftButtonText: '存编辑稿'
        }
      : {
          editMode: false,
          editingPostId: '',
          pageTitle: '发布动态',
          publishButtonText: '立即发布',
          draftButtonText: '存草稿'
        }
    this.setData(nextData)
    wx.setNavigationBarTitle({ title: nextData.pageTitle })

    const boot = async () => {
      const isAdmin = !!(app.globalData.userInfo && app.globalData.userInfo.role === 'admin')
      this.setData({
        isAdmin,
        canPostVideo: !!(feature.allowPostVideo && isAdmin)
      })
      if (this.data.editMode) {
        await this.loadEditingPost(this.data.editingPostId)
      }
      this.tryRestoreDraft()
    }

    if (app.globalData.isLoggedIn) {
      await boot()
    } else {
      app.waitForLogin((userInfo) => {
        if (userInfo) {
          boot()
        }
      })
    }
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

  // 上传图片到云存储
  async _prepareUploadImage(localPath) {
    if (!localPath || /^(https?:|cloud:\/\/)/.test(localPath)) return localPath
    try {
      const info = await wx.getImageInfo({ src: localPath })
      const width = info && info.width ? Number(info.width) : 0
      const height = info && info.height ? Number(info.height) : 0
      const longSide = Math.max(width, height)
      if (!longSide || longSide <= 1600) return localPath
      const quality = longSide > 2200 ? 55 : 65
      const res = await wx.compressImage({ src: localPath, quality })
      return (res && res.tempFilePath) || localPath
    } catch (err) {
      return localPath
    }
  },

  async _uploadImages(imagePaths) {
    const n = imagePaths.length
    if (n === 0) return []
    const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
    const cloudPaths = new Array(n)
    // 并发过高易触发 uploadFile 失败；且勿与缩略图流程同时对同一路径 compressImage
    const concurrency = Math.min(3, n)
    let cursor = 0
    const worker = async () => {
      while (true) {
        const i = cursor++
        if (i >= n) break
        const uploadPath = await this._prepareUploadImage(imagePaths[i])
        let ext = (imagePaths[i].split('.').pop() || 'jpg').split('?')[0].toLowerCase()
        if (ext.length > 5 || !ALLOWED_EXTS.includes(ext)) ext = 'jpg'
        const cloudPath = `posts/${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        try {
          const res = await wx.cloud.uploadFile({
            cloudPath,
            filePath: uploadPath
          })
          cloudPaths[i] = res.fileID
        } catch (err) {
          console.error('图片上传失败:', err)
          throw new Error(`第${i + 1}张图片上传失败`)
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return cloudPaths
  },

  async _makeImageThumb(localPath) {
    if (!localPath || /^(https?:|cloud:\/\/)/.test(localPath)) return localPath
    try {
      const res = await new Promise((resolve, reject) => {
        wx.compressImage({
          src: localPath,
          quality: 45,
          success: resolve,
          fail: reject
        })
      })
      return res.tempFilePath || localPath
    } catch (err) {
      console.warn('生成缩略图失败，回退原图:', err)
      return localPath
    }
  },

  async _uploadThumbImages(imagePaths) {
    const n = imagePaths.length
    if (n === 0) return []
    const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
    const cloudPaths = new Array(n)
    const concurrency = Math.min(3, n)
    let cursor = 0
    const worker = async () => {
      while (true) {
        const i = cursor++
        if (i >= n) break
        const thumbPath = await this._makeImageThumb(imagePaths[i])
        let ext = (thumbPath.split('.').pop() || 'jpg').split('?')[0].toLowerCase()
        if (ext.length > 5 || !ALLOWED_EXTS.includes(ext)) ext = 'jpg'
        const cloudPath = `posts/thumb_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        try {
          const res = await wx.cloud.uploadFile({
            cloudPath,
            filePath: thumbPath
          })
          cloudPaths[i] = res.fileID
        } catch (err) {
          console.error('缩略图上传失败:', err)
          cloudPaths[i] = ''
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return cloudPaths
  },

  // 上传视频到云存储
  async _uploadVideos(videoPaths) {
    const cloudPaths = []
    for (let i = 0; i < videoPaths.length; i++) {
      let ext = videoPaths[i].split('.').pop() || 'mp4'
      // 特殊情况：有的手机路径可能获取不到后缀名，或者带有参数
      ext = ext.split('?')[0].toLowerCase()
      if(ext.length > 5 || !['mp4','mov','m4v','3gp','avi','flv','mkv'].includes(ext)) ext = 'mp4';
      const cloudPath = `posts/${Date.now()}_video_${i}.${ext}`
      try {
        const res = await wx.cloud.uploadFile({
          cloudPath,
          filePath: videoPaths[i]
        })
        cloudPaths.push(res.fileID)
      } catch (err) {
        console.error('视频上传失败:', err)
        throw new Error('视频上传失败')
      }
    }
    return cloudPaths
  },

  async loadEditingPost(postId) {
    const post = await app.getPostById(postId)
    if (!post) {
      wx.showToast({ title: '帖子不存在或已删除', icon: 'none' })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1000)
      return
    }
    if (post._openid !== app.globalData.openid) {
      wx.showToast({ title: '只能编辑自己发布的帖子', icon: 'none' })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1000)
      return
    }

    const resolvedPost = app.globalData.cloudReady
      ? await app.resolvePostMedia(post)
      : post
    const categoryIndex = this.data.categoryList.findIndex((item) => item.name === post.category)

    this.setData({
      title: post.title || '',
      content: post.content || '',
      currentCategory: clampPostCategoryIndex(categoryIndex >= 0 ? categoryIndex : 0, this.data.categoryList),
      selectedImages: (resolvedPost.images || []).map((url, index) => ({
        path: url,
        fileId: (post.images || [])[index] || '',
        thumbFileId: (post.thumbImages || [])[index] || '',
        type: 'image'
      })),
      selectedVideos: (resolvedPost.videos || []).map((url, index) => ({
        path: url,
        fileId: (post.videos || [])[index] || '',
        thumbPath: '',
        duration: 0
      }))
    })
  },

  tryRestoreDraft() {
    const draft = wx.getStorageSync(this.getDraftKey())
    if (!draft) return

    const modalTitle = this.data.editMode ? '发现编辑草稿' : '发现草稿'
    const modalContent = this.data.editMode
      ? '是否恢复上次未保存的编辑内容？'
      : '是否恢复上次未发布的内容？'

    wx.showModal({
      title: modalTitle,
      content: modalContent,
      confirmColor: '#426089',
      success: (res) => {
        if (res.confirm) {
          const validImages = this._filterValidTempFiles(draft.selectedImages)
          const validVideos = this._filterValidTempFiles(draft.selectedVideos)
          const lostCount = ((draft.selectedImages || []).length - validImages.length)
            + ((draft.selectedVideos || []).length - validVideos.length)

          this.setData({
            title: draft.title || '',
            content: draft.content || '',
            currentCategory: clampPostCategoryIndex(draft.currentCategory, this.data.categoryList),
            selectedImages: validImages,
            selectedVideos: validVideos
          })
          if (lostCount > 0) {
            this._setDraftStatus(`已恢复草稿（${lostCount}个媒体文件已过期）`)
          } else {
            this._setDraftStatus(this.data.editMode ? '已恢复上次编辑稿' : '已恢复上次草稿')
          }
        } else {
          wx.removeStorageSync(this.getDraftKey())
        }
      }
    })
  },

  async _prepareImageFileIds() {
    const retained = this.data.selectedImages
      .filter((item) => item.fileId)
      .map((item) => item.fileId)
    const locals = this.data.selectedImages
      .filter((item) => !item.fileId)
      .map((item) => item.path)
    const uploaded = locals.length > 0 ? await this._uploadImages(locals) : []
    return [...retained, ...uploaded]
  },

  async _prepareThumbImageFileIds() {
    const retained = this.data.selectedImages
      .filter((item) => item.fileId)
      .map((item) => item.thumbFileId || item.fileId)
    const locals = this.data.selectedImages
      .filter((item) => !item.fileId)
      .map((item) => item.path)
    const uploaded = locals.length > 0 ? await this._uploadThumbImages(locals) : []
    return [...retained, ...uploaded]
  },

  async _prepareVideoFileIds() {
    const retained = this.data.selectedVideos
      .filter((item) => item.fileId)
      .map((item) => item.fileId)
    const locals = this.data.selectedVideos
      .filter((item) => !item.fileId)
      .map((item) => item.path)
    const uploaded = locals.length > 0 ? await this._uploadVideos(locals) : []
    return [...retained, ...uploaded]
  },

  async onPublish() {
    if (this.data.publishing) return
    this.setData({ publishing: true })
    if (!this.data.content.trim()) {
      this.setData({ publishing: false })
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }

    // 前端违禁词预检
    if (this.data.title.trim()) {
      const titleCheck = app.checkContent(this.data.title)
      if (!titleCheck.pass) {
        this.setData({ publishing: false })
        wx.showModal({
          title: '内容审核未通过',
          content: `标题包含违规内容"${titleCheck.word}"，请修改后重新提交。`,
          showCancel: false, confirmColor: '#426089'
        })
        return
      }
    }

    const contentCheck = app.checkContent(this.data.content)
    if (!contentCheck.pass) {
      this.setData({ publishing: false })
      wx.showModal({
        title: '内容审核未通过',
        content: `正文包含违规内容"${contentCheck.word}"，请修改后重新提交。`,
        showCancel: false, confirmColor: '#426089'
      })
      return
    }

    if (this.data.selectedVideos.length > 0 && !this.data.canPostVideo) {
      this.setData({ publishing: false })
      wx.showToast({ title: '仅管理员可发布视频', icon: 'none' })
      return
    }

    // 图片安全由 addPost/updatePost 内 wxImageBatchCheck 执行一次；视频链路仍为 pending/人工（checkAllMedia 对视频本就不做同步审）
    wx.showLoading({ title: '上传媒体...', mask: true })

    try {
      const videoTask = (this.data.canPostVideo || (this.data.editMode && this.data.selectedVideos.length === 0))
        ? this._prepareVideoFileIds()
        : Promise.resolve([])
      const [mediaBundle, cloudVideos] = await Promise.all([
        (async () => {
          const cloudImages = await this._prepareImageFileIds()
          const cloudThumbImages = await this._prepareThumbImageFileIds()
          return { cloudImages, cloudThumbImages }
        })(),
        videoTask
      ])
      const { cloudImages, cloudThumbImages } = mediaBundle
      wx.showLoading({ title: this.data.editMode ? '保存中...' : '发布中...', mask: true })
      const catIdx = clampPostCategoryIndex(this.data.currentCategory, this.data.categoryList)
      const categoryName = this.data.categoryList[catIdx].name
      const payload = {
        title: this.data.title,
        content: this.data.content,
        category: categoryName,
        images: cloudImages,
        thumbImages: cloudThumbImages,
        videos: cloudVideos
      }
      const result = this.data.editMode
        ? await app.updatePost(this.data.editingPostId, payload)
        : await app.addPost(payload)

      wx.hideLoading()

      if (result) {
        app.globalData.indexFeedNeedsRefresh = true
        app.globalData.mineNeedsRefresh = true
        if (this.data.editMode && this.data.editingPostId && typeof app.markDetailNeedsRefresh === 'function') {
          app.markDetailNeedsRefresh(this.data.editingPostId)
        }
        wx.removeStorageSync(this.getDraftKey())
        this.setData({
          title: '', content: '', selectedImages: [], selectedVideos: [],
          showEmojiPanel: false, draftStatus: '', publishing: false
        })
        wx.showToast({
          title: this.data.editMode ? '更新成功' : '发布成功',
          icon: 'success',
          duration: 1200
        })
        setTimeout(() => {
          if (this.data.editMode) {
            wx.navigateBack({ delta: 1 })
          } else {
            wx.switchTab({ url: '/pages/index/index' })
          }
        }, 1200)
      } else {
        this.setData({ publishing: false })
      }
    } catch (err) {
      console.error('发布帖子失败:', err)
      wx.hideLoading()
      this.setData({ publishing: false })
      wx.showToast({ title: err.msg || err.message || '系统繁忙，发布失败', icon: 'none' })
    }
  }
})
