// pages/detail/detail.js - 帖子详情页逻辑
// 云数据库驱动：帖子详情、点赞、评论、举报、管理员操作

const app = getApp()
const { resolvePostIdFromPageOptions } = require('../../utils/shareEntry')

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
    detailImgLoaded: {},
    isFollowingAuthor: false,
    showFollowAuthorBtn: false,
    currentImageIndex: 0
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

  onImageSwiperChange(e) {
    const current = e && e.detail ? e.detail.current : 0
    this.setData({ currentImageIndex: Number(current) || 0 })
  },

  onSheetPrivateMsg() {
    this.setData({ showShareChatSheet: false })
    this.onSendToChat()
  },

  async onToggleFollowAuthor() {
    if (!app.requestComplianceForAction()) return
    const targetOpenid = this.data.post && this.data.post._openid
    if (!targetOpenid) return
    const isFollowing = await app.toggleFollow(targetOpenid)
    if (isFollowing !== null) {
      this.setData({ isFollowingAuthor: !!isFollowing })
      wx.showToast({ title: isFollowing ? '已关注作者' : '已取消关注', icon: 'none' })
    }
  },

  onLoad(options) {
    const postId = resolvePostIdFromPageOptions(options)
    if (!postId) {
      this.setData({
        loading: false,
        loadError: '分享链接无效，请让对方重新分享'
      })
      return
    }
    // 避免 onLoad 与首次 onShow 各拉一次详情（首屏双倍请求）
    this._detailFirstShow = true
    this.setData({ postId })
    this._startPostLoad(postId)
  },

  /** 朋友圈单页/冷启动：云就绪即拉帖，登录在后台静默进行 */
  _startPostLoad(postId) {
    const run = () => {
      if (this._postLoadStarted || !postId) return false
      if (!app.globalData.cloudReady) return false
      this._postLoadStarted = true
      this.loadPostData(postId)
      return true
    }
    if (run()) return
    const timer = setInterval(() => {
      if (run()) clearInterval(timer)
    }, 80)
    setTimeout(() => clearInterval(timer), 10000)
    if (!app.globalData.isLoggedIn && !app.globalData.loggingIn) {
      app.doLogin({ silent: true })
    }
  },

  onShow() {
    if (!this.data.postId) return
    if (!app.globalData.isLoggedIn) {
      if (!this._postLoadStarted && app.globalData.cloudReady) {
        this._startPostLoad(this.data.postId)
      }
      return
    }
    // 首次 onShow 若已在登录态完成首屏加载，则跳过；
    // 但若首屏是匿名加载（_loadedWhileLoggedIn=false），则强制以登录态再拉一次，刷新 isLiked/isFavored 等
    if (this._detailFirstShow) {
      this._detailFirstShow = false
      if (this._loadedWhileLoggedIn) {
        return
      }
    }
    const force = typeof app.consumeDetailNeedsRefresh === 'function'
      && app.consumeDetailNeedsRefresh(this.data.postId)
    const now = Date.now()
    if (!force && this._lastDetailReloadAt && (now - this._lastDetailReloadAt) < 12000) {
      return
    }
    this._lastDetailReloadAt = now
    this.loadPostData(this.data.postId)
  },

  async _formatCommentsForView(comments) {
    let formattedComments = (comments || []).map((c) => ({
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
    return formattedComments
  },

  /** 仅刷新评论列表（发帖互动后避免整页重拉） */
  async refreshCommentsOnly(postId) {
    if (!postId) return
    try {
      const comments = await app.fetchCommentsForShare(postId, this.data.sortBy)
      const formattedComments = await this._formatCommentsForView(comments)
      this.setData({ comments: formattedComments })
    } catch (err) {
      console.warn('refreshCommentsOnly', err)
    }
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

    this.setData({ loading: true, loadError: '', detailImgLoaded: {}, currentImageIndex: 0 })

    try {
      const sortBy = this.data.sortBy
      const postData = await app.fetchPostForShare(postId)
      if (!postData) {
        const isDev = typeof __wxConfig !== 'undefined' && __wxConfig.envVersion === 'develop'
        this.setData({
          loading: false,
          loadError: isDev
            ? '加载失败。开发版分享到朋友圈仅项目成员可访问云端，请上传体验版后再试'
            : '帖子不存在、已删除，或暂时无法加载'
        })
        return
      }

      let comments = []
      try {
        comments = await app.fetchCommentsForShare(postId, sortBy)
      } catch (commentErr) {
        console.warn('加载评论失败（不影响正文）', commentErr)
      }

      const resolvedPost = app.globalData.cloudReady
        ? await app.resolvePostMedia(postData)
        : postData

      const [formattedComments, shareImageUrl] = await Promise.all([
        this._formatCommentsForView(comments),
        app.computeShareImageUrl(resolvedPost)
      ])

      const isAdmin = app.globalData.userInfo && app.globalData.userInfo.role === 'admin'
      const isOwner = resolvedPost._openid === app.globalData.openid

      let postForView = { ...resolvedPost, time: app.formatTime(resolvedPost.createTime) }
      if (postForView.isAnonymous === true && !isOwner) {
        postForView = { ...postForView, _openid: '', userId: '' }
      }
      const showFollowAuthorBtn = !!(postForView._openid && !isOwner)

      this.setData({
        post: postForView,
        isLiked: resolvedPost.isLiked || false,
        isFavored: resolvedPost.isFavored || false,
        comments: formattedComments,
        isOwner,
        isAdmin,
        showFollowAuthorBtn,
        isFollowingAuthor: false,
        loadError: '',
        loading: false,
        shareImageUrl
      })
      // 标记本次加载是否在登录态完成，供 onShow 决定是否需要再次以登录态刷新
      this._loadedWhileLoggedIn = !!app.globalData.isLoggedIn

      if (showFollowAuthorBtn) {
        try {
          const authorInfo = await app.getUserInfo(postForView._openid)
          const isFollowingAuthor = !!(authorInfo && authorInfo.isFollowing)
          this.setData({ isFollowingAuthor })
        } catch (e) {}
      }
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
    this._lastDetailReloadAt = 0
    this._postLoadStarted = false
    this._startPostLoad(this.data.postId)
  },

  async onLikeTap() {
    if (this._likeBusy) return
    if (!app.requestComplianceForAction()) return
    const prevLiked = this.data.isLiked
    const prevCount = this.data.post.likes || 0
    const optimisticLiked = !prevLiked
    const optimisticCount = Math.max(0, prevCount + (optimisticLiked ? 1 : -1))
    this.setData({ isLiked: optimisticLiked, 'post.likes': optimisticCount })
    this._likeBusy = true
    try {
      const result = await app.toggleLikePost(this.data.postId)
      if (result) {
        const wasLiked = !!prevLiked
        const nowLiked = !!result.isLiked
        const likes = wasLiked === nowLiked ? prevCount : Math.max(0, prevCount + (nowLiked ? 1 : -1))
        this.setData({
          isLiked: nowLiked,
          'post.likes': likes
        })
        wx.showToast({ title: nowLiked ? '已点赞' : '取消点赞', icon: 'none' })
      } else {
        this.setData({ isLiked: prevLiked, 'post.likes': prevCount })
      }
    } catch (err) {
      this.setData({ isLiked: prevLiked, 'post.likes': prevCount })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this._likeBusy = false
    }
  },

  onShareTap() {},

  onSendToChat() {
    if (!app.requestComplianceForAction()) return
    const authorOpenid = encodeURIComponent((this.data.post && this.data.post._openid) || '')
    const authorNickname = encodeURIComponent((this.data.post && this.data.post.nickname) || '')
    wx.navigateTo({
      url: `/pages/share-post/share-post?shareType=post&shareId=${encodeURIComponent(this.data.postId)}&autoShare=1&authorOpenid=${authorOpenid}&authorNickname=${authorNickname}`
    })
  },

  onShareAppMessage() {
    const content = this.data.post.content || ''
    const title = content.length > 30 ? content.substring(0, 30) + '...' : (content || '校园便利盒')
    const qid = encodeURIComponent(this.data.postId || '')
    return {
      title,
      path: `/pages/detail/detail?id=${qid}`,
      imageUrl: this.data.shareImageUrl || '/images/icon_share.png'
    }
  },

  // 举报（真实写入数据库）
  onReportTap() {
    if (!app.requestComplianceForAction()) return
    wx.showActionSheet({
      itemList: ['内容不适', '垃圾广告', '虚假信息', '其他原因'],
      success: (res) => {
        const reasons = ['内容不适', '垃圾广告', '虚假信息', '其他原因']
        const reason = reasons[res.tapIndex]
        if (!reason) return
        ;(async () => {
          try {
            const result = await app.reportContent(this.data.postId, 'post', reason)
            if (result) {
              wx.showToast({ title: '举报已提交，感谢反馈', icon: 'none' })
            }
          } catch (err) {
            console.warn('[detail.onReportTap] 举报失败', err)
            wx.showToast({ title: '举报失败，请稍后再试', icon: 'none' })
          }
        })()
      }
    })
  },

  async onFavorTap() {
    if (this._favorBusy) return
    if (!app.requestComplianceForAction()) return
    const prevFavored = this.data.isFavored
    this.setData({ isFavored: !prevFavored })
    this._favorBusy = true
    try {
      const isFavored = await app.toggleFavorPost(this.data.postId)
      if (isFavored !== null) {
        this.setData({ isFavored })
        wx.showToast({ title: isFavored ? '已收藏' : '取消收藏', icon: 'none' })
      } else {
        this.setData({ isFavored: prevFavored })
      }
    } catch (err) {
      this.setData({ isFavored: prevFavored })
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
    const pid = this.data.postId
    if (!pid) return
    wx.navigateTo({
      url: `/pages/post-editor/post-editor?mode=edit&id=${encodeURIComponent(pid)}`
    })
  },

  async onSortChange(e) {
    const sortBy = e.currentTarget.dataset.sort
    if (sortBy === this.data.sortBy) return
    this.setData({ sortBy })
    try {
      const comments = await app.fetchCommentsForShare(this.data.postId, sortBy)
      const formatted = await this._formatCommentsForView(comments)
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
        const cur = this.data.post.comments
        if (typeof cur === 'number' && !Number.isNaN(cur)) {
          this.setData({ 'post.comments': cur + 1 })
        }
        await this.refreshCommentsOnly(this.data.postId)
      }
    } catch (err) {
      wx.showToast({ title: '评论发送失败，请重试', icon: 'none' })
    } finally {
      this._submitting = false
    }
  },

  async onCommentLike(e) {
    const commentId = e.currentTarget.dataset.id
    if (!commentId) return
    this._commentLikeBusyMap = this._commentLikeBusyMap || {}
    if (this._commentLikeBusyMap[commentId]) return
    if (!app.requestComplianceForAction()) return

    const prevRow = (this.data.comments || []).find((c) => c._id === commentId)
    const snapshot = prevRow
      ? { likes: prevRow.likes || 0, isLiked: !!prevRow.isLiked }
      : null

    this._commentLikeBusyMap[commentId] = true
    if (snapshot) {
      const optimisticLiked = !snapshot.isLiked
      const optimisticLikes = Math.max(0, snapshot.likes + (optimisticLiked ? 1 : -1))
      const comments = this.data.comments.map((c) =>
        (c._id !== commentId ? c : { ...c, isLiked: optimisticLiked, likes: optimisticLikes })
      )
      this.setData({ comments })
    }

    try {
      const result = await app.toggleLikeComment(commentId)
      if (result && snapshot) {
        let newLikes = snapshot.likes
        if (result.isLiked && !snapshot.isLiked) newLikes = snapshot.likes + 1
        else if (!result.isLiked && snapshot.isLiked) newLikes = Math.max(0, snapshot.likes - 1)
        const comments = this.data.comments.map((c) =>
          (c._id !== commentId ? c : { ...c, isLiked: result.isLiked, likes: newLikes })
        )
        this.setData({ comments })
      } else if (result && !snapshot) {
        const comments = this.data.comments.map((c) => {
          if (c._id !== commentId) return c
          const base = c.likes || 0
          const was = !!c.isLiked
          let likes = base
          if (result.isLiked && !was) likes = base + 1
          else if (!result.isLiked && was) likes = Math.max(0, base - 1)
          return { ...c, isLiked: result.isLiked, likes }
        })
        this.setData({ comments })
      } else if (snapshot) {
        const comments = this.data.comments.map((c) =>
          (c._id !== commentId ? c : { ...c, isLiked: snapshot.isLiked, likes: snapshot.likes })
        )
        this.setData({ comments })
      }
    } catch (err) {
      if (snapshot) {
        const comments = this.data.comments.map((c) =>
          (c._id !== commentId ? c : { ...c, isLiked: snapshot.isLiked, likes: snapshot.likes })
        )
        this.setData({ comments })
      }
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      delete this._commentLikeBusyMap[commentId]
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
    const id = this.data.postId || (this.data.post && this.data.post._id) || ''
    return {
      title,
      query: id ? `id=${encodeURIComponent(id)}` : '',
      imageUrl: this.data.shareImageUrl || '/images/icon_share.png'
    }
  }
})
