// pages/detail/detail.js - 帖子详情页逻辑
// 云数据库驱动：帖子详情、点赞、评论、举报、管理员操作

const app = getApp()

Page({
  data: {
    post: {},
    postId: '',
    isLiked: false,
    isFavored: false,
    sortBy: 'hot',
    commentText: '',
    comments: [],
    replyTarget: null,
    inputPlaceholder: '说点什么吧...',
    isOwner: false,
    isAdmin: false,
    loadError: '',
    loading: true,
    commentInputFocus: false,
    showShareChatSheet: false,
    shareImageUrl: '/images/icon_share.png',
    detailImgLoaded: {}
  },

  preventMove() {},

  noop() {},

  onOpenShareChatSheet() {
    this.setData({ showShareChatSheet: true })
  },

  onCloseShareChatSheet() {
    this.setData({ showShareChatSheet: false })
  },

  onDetailImgLoad(e) {
    const idx = e.currentTarget.dataset.idx
    if (idx == null || this.data.detailImgLoaded[idx]) return
    this.setData({ [`detailImgLoaded.${idx}`]: true })
  },

  onSheetPrivateMsg() {
    this.setData({ showShareChatSheet: false })
    this.onSendToChat()
  },

  onLoad(options) {
    const postId = options.id
    if (!postId) {
      wx.showToast({ title: '帖子参数缺失', icon: 'none' })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 800)
      return
    }
    // 避免 onLoad 与首次 onShow 各拉一次详情（首屏双倍请求）
    this._detailFirstShow = true
    this.setData({ postId })
    app.waitForLogin(() => {
      this.loadPostData(postId)
    })
  },

  onShow() {
    if (!this.data.postId || !app.globalData.isLoggedIn) return
    if (this._detailFirstShow) {
      this._detailFirstShow = false
      return
    }
    this.loadPostData(this.data.postId)
  },

  // 加载帖子数据（从云数据库）
  async loadPostData(postId) {
    // 特殊页面（横幅等）
    if (postId === 'banner') {
      this.setData({
        post: {
          _id: postId,
          nickname: '校园便利盒官方',
          avatar: '/images/avatar_default.png',
          college: '校园便利盒',
          time: '今天',
          category: '公告',
          content: '本学期图书馆延时开放公告：为迎接期末周，图书馆将延时开放至晚上11点。',
          image: '/images/banner_library.png',
          likes: 0, images: [], videos: []
        },
        comments: [], isLiked: false, loadError: '', loading: false,
        shareImageUrl: '/images/banner_library.png'
      })
      return
    }

    this.setData({ loading: true, loadError: '', detailImgLoaded: {} })

    try {
      const postData = await app.getPostById(postId)
      if (!postData) {
        this.setData({
          loading: false,
          loadError: '帖子不存在、已删除，或暂时无法加载'
        })
        return
      }

      const resolvedPost = app.globalData.cloudReady
        ? await app.resolvePostMedia(postData)
        : postData

      // 加载评论（解析 cloud:// 头像）
      const comments = await app.getComments(postId, this.data.sortBy)
      let formattedComments = comments.map((c) => ({
        ...c,
        time: app.formatTime(c.createTime)
      }))
      if (app.globalData.cloudReady && formattedComments.length) {
        const avMap = await app.resolveFileUrlsMap(formattedComments.map((c) => c.avatar))
        formattedComments = formattedComments.map((c) => ({
          ...c,
          avatar: avMap[c.avatar] || c.avatar || '/images/avatar_default.png'
        }))
      }

      const isAdmin = app.globalData.userInfo && app.globalData.userInfo.role === 'admin'
      const isOwner = resolvedPost._openid === app.globalData.openid

      const shareImageUrl = await app.computeShareImageUrl(resolvedPost)

      let postForView = { ...resolvedPost, time: app.formatTime(resolvedPost.createTime) }
      if (postForView.isAnonymous === true && !isOwner) {
        postForView = { ...postForView, _openid: '', userId: '' }
      }

      this.setData({
        post: postForView,
        isLiked: resolvedPost.isLiked || false,
        isFavored: resolvedPost.isFavored || false,
        comments: formattedComments,
        isOwner,
        isAdmin,
        loadError: '',
        loading: false,
        shareImageUrl
      })
    } catch (err) {
      console.error('加载帖子详情失败:', err)
      this.setData({
        loading: false,
        loadError: '加载失败，请下拉或点击重试'
      })
    }
  },

  onRetryLoad() {
    if (!this.data.postId) return
    this.loadPostData(this.data.postId)
  },

  async onLikeTap() {
    if (this._likeBusy) return
    if (!app.requestComplianceForAction()) return
    this._likeBusy = true
    try {
      const result = await app.toggleLikePost(this.data.postId)
      if (result) {
        const curLikes = this.data.post.likes || 0
        this.setData({
          isLiked: result.isLiked,
          'post.likes': Math.max(0, curLikes + (result.isLiked ? 1 : -1))
        })
        wx.showToast({ title: result.isLiked ? '已点赞' : '取消点赞', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this._likeBusy = false
    }
  },

  onShareTap() {},

  onSendToChat() {
    if (!app.requestComplianceForAction()) return
    wx.navigateTo({
      url: `/pages/follow/follow?mode=chat&shareType=post&shareId=${this.data.postId}&autoShare=1`
    })
  },

  onShareAppMessage() {
    const content = this.data.post.content || ''
    const title = content.length > 30 ? content.substring(0, 30) + '...' : (content || '校园便利盒')
    return {
      title,
      path: `/pages/detail/detail?id=${this.data.postId}`,
      imageUrl: this.data.shareImageUrl || '/images/icon_share.png'
    }
  },

  // 举报（真实写入数据库）
  onReportTap() {
    if (!app.requestComplianceForAction()) return
    wx.showActionSheet({
      itemList: ['内容不适', '垃圾广告', '虚假信息', '其他原因'],
      success: async (res) => {
        const reasons = ['内容不适', '垃圾广告', '虚假信息', '其他原因']
        const reason = reasons[res.tapIndex]
        const result = await app.reportContent(this.data.postId, 'post', reason)
        if (result) {
          wx.showToast({ title: '举报已提交，感谢反馈', icon: 'none' })
        }
      }
    })
  },

  async onFavorTap() {
    if (this._favorBusy) return
    if (!app.requestComplianceForAction()) return
    this._favorBusy = true
    try {
      const isFavored = await app.toggleFavorPost(this.data.postId)
      if (isFavored !== null) {
        this.setData({ isFavored })
        wx.showToast({ title: isFavored ? '已收藏' : '取消收藏', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this._favorBusy = false
    }
  },

  // 管理员：置顶
  async onAdminTopPost() {
    const isTop = await app.toggleTopPost(this.data.postId)
    if (isTop !== null) {
      this.setData({ 'post.isTop': isTop })
      wx.showToast({ title: isTop ? '已置顶' : '已取消置顶', icon: 'success' })
    }
  },

  // 管理员：删帖
  onAdminDeletePost() {
    wx.showModal({
      title: '管理员操作',
      content: '确定要永久删除该帖子吗？',
      confirmColor: '#d32f2f',
      success: async (res) => {
        if (res.confirm) {
          const success = await app.deletePostById(this.data.postId)
          if (success) {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => { wx.navigateBack() }, 1500)
          }
        }
      }
    })
  },

  onOwnerDeletePost() {
    wx.showModal({
      title: '删除帖子',
      content: '删除后帖子将无法继续查看，确定删除吗？',
      confirmColor: '#d32f2f',
      success: async (res) => {
        if (!res.confirm) return
        const success = await app.deletePostById(this.data.postId)
        if (success) {
          wx.showToast({ title: '帖子已删除', icon: 'none' })
          setTimeout(() => { wx.navigateBack() }, 1200)
        }
      }
    })
  },

  onOwnerEditPost() {
    wx.navigateTo({ url: `/pages/post-editor/post-editor?mode=edit&id=${this.data.postId}` })
  },

  async onSortChange(e) {
    const sortBy = e.currentTarget.dataset.sort
    if (sortBy === this.data.sortBy) return
    this.setData({ sortBy })
    try {
      const comments = await app.getComments(this.data.postId, sortBy)
      let formatted = comments.map(c => ({ ...c, time: app.formatTime(c.createTime) }))
      if (app.globalData.cloudReady && formatted.length) {
        const avMap = await app.resolveFileUrlsMap(formatted.map(c => c.avatar))
        formatted = formatted.map(c => ({
          ...c,
          avatar: avMap[c.avatar] || c.avatar || '/images/avatar_default.png'
        }))
      }
      this.setData({ comments: formatted })
    } catch (err) {
      wx.showToast({ title: '加载评论失败', icon: 'none' })
    }
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value })
  },

  async onSendComment() {
    if (this._submitting) return
    if (!app.requestComplianceForAction()) return
    if (!this.data.commentText.trim()) {
      wx.showToast({ title: '请输入评论内容', icon: 'none' })
      return
    }

    const check = app.checkContent(this.data.commentText)
    if (!check.pass) {
      wx.showModal({
        title: '内容审核未通过',
        content: `评论包含违规内容"${check.word}"，请修改。`,
        showCancel: false, confirmColor: '#426089'
      })
      return
    }

    this._submitting = true
    const content = this.data.commentText.trim()
    const replyTo = this.data.replyTarget ? {
      nickname: this.data.replyTarget.nickname,
      commentId: this.data.replyTarget._id
    } : null

    try {
      const newComment = await app.addComment(this.data.postId, content, replyTo)
      if (newComment) {
        this.setData({
          commentText: '',
          replyTarget: null,
          inputPlaceholder: '说点什么吧...'
        })
        wx.showToast({ title: '评论成功', icon: 'none' })
        this.loadPostData(this.data.postId)
      }
    } catch (err) {
      wx.showToast({ title: '评论发送失败，请重试', icon: 'none' })
    } finally {
      this._submitting = false
    }
  },

  async onCommentLike(e) {
    const commentId = e.currentTarget.dataset.id
    if (this._commentLikeBusy) return
    if (!app.requestComplianceForAction()) return
    this._commentLikeBusy = true
    try {
      const result = await app.toggleLikeComment(commentId)
      if (result) {
        const comments = this.data.comments.map(c => {
          if (c._id !== commentId) return c
          return {
            ...c,
            isLiked: result.isLiked,
            likes: Math.max(0, (c.likes || 0) + (result.isLiked ? 1 : -1))
          }
        })
        this.setData({ comments })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      this._commentLikeBusy = false
    }
  },

  onReplyTap(e) {
    const commentId = e.currentTarget.dataset.id
    const comment = this.data.comments.find(c => c._id === commentId)
    if (comment) {
      this.setData({
        replyTarget: comment,
        inputPlaceholder: `回复 @${comment.nickname}...`,
        commentInputFocus: true
      })
    }
  },

  // 点击头像（匿名帖：非作者、非管理员不可进入发帖人主页）
  onAvatarTap(e) {
    const post = this.data.post || {}
    const { isOwner, isAdmin } = this.data
    if (post.isAnonymous === true && !isOwner && !isAdmin) {
      wx.showToast({ title: '匿名帖子无法查看主页', icon: 'none' })
      return
    }
    const openid = e.currentTarget.dataset.openid
    if (!openid) {
      if (post.isAnonymous === true && !isAdmin) {
        wx.showToast({ title: '匿名帖子无法查看主页', icon: 'none' })
      }
      return
    }
    wx.navigateTo({ url: `/pages/profile/profile?openid=${encodeURIComponent(openid)}` })
  },

  onCommentFocus() {
    this.setData({ commentInputFocus: true })
  },

  onCommentInputBlur() {
    if (this.data.commentInputFocus) {
      this.setData({ commentInputFocus: false })
    }
  },

  onPreviewImage(e) {
    const post = this.data.post
    const index = e.currentTarget.dataset.index || 0
    const urls = post.images && post.images.length > 0 ? post.images : (post.image ? [post.image] : [])
    if (urls.length > 0) {
      wx.previewImage({ current: urls[index], urls })
    }
  },

  onShareTimeline() {
    const content = this.data.post.content || ''
    const title = content.length > 20 ? content.substring(0, 20) + '...' : (content || '校园便利盒')
    return {
      title,
      query: `id=${this.data.postId}`,
      imageUrl: this.data.shareImageUrl || '/images/icon_share.png'
    }
  }
})
