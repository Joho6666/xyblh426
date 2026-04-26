// pages/market-detail/market-detail.js - 商品详情
const app = getApp()

Page({
  data: {
    goodsId: '',
    goods: null,
    isFavored: false,
    isOwner: false,
    loadError: '',
    comments: [],
    commentCount: 0,
    commentText: '',
    sendingComment: false,
    replyTarget: null,
    inputPlaceholder: '说说你对这个商品的看法...',
    showShareSheet: false,
    shareImageUrl: '/images/icon_share.png'
  },

  preventMove() {},

  noop() {},

  onOpenShareSheet() {
    this.setData({ showShareSheet: true })
  },

  onCloseShareSheet() {
    this.setData({ showShareSheet: false })
  },

  onSheetChatWithGoods() {
    this.setData({ showShareSheet: false })
    this.onChat()
  },

  /** 本人上架：选择好友，将商品卡片发到对方私信（与帖子「分享到私信」一致） */
  onSheetShareGoodsToPm() {
    this.setData({ showShareSheet: false })
    if (!app.requestComplianceForAction()) return
    wx.navigateTo({
      url: `/pages/follow/follow?mode=chat&shareType=goods&shareId=${this.data.goodsId}&autoShare=1`
    })
  },

  onLoad(options) {
    if (!options.id) {
      wx.showToast({ title: '商品参数缺失', icon: 'none' })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 800)
      return
    }
    this.setData({ goodsId: options.id })
    app.waitForLogin(() => { this.loadDetailData(options.id) })
  },

  async loadDetailData(id) {
    await Promise.all([
      this.loadGoods(id),
      this.loadComments(id)
    ])
  },

  async loadGoods(id) {
    try {
      this.setData({ loadError: '' })
      const result = await app.callDB('getMarketGoodsById', { goodsId: id })
      let goods = result.data
      if (!goods || !goods._id) {
        this.setData({ goods: null, loadError: '商品不存在或已下架' })
        return
      }
      if (app.globalData.cloudReady) {
        goods = await app.resolvePostMedia(goods)
      }
      goods = { ...goods, timeStr: app.formatTime(goods.createTime) }
      const shareImageUrl = await app.computeShareImageUrl(goods)
      this.setData({
        goods,
        isFavored: !!result.isFavored,
        isOwner: goods._openid === app.globalData.openid,
        shareImageUrl
      })
    } catch (err) {
      console.error('加载商品失败:', err)
      this.setData({
        goods: null,
        loadError: (err && (err.msg || err.message)) || '加载失败，请稍后重试',
        shareImageUrl: '/images/icon_share.png'
      })
    }
  },

  onRetryLoad() {
    if (!this.data.goodsId) return
    this.loadDetailData(this.data.goodsId)
  },

  async loadComments(goodsId = this.data.goodsId) {
    const comments = await app.getMarketComments(goodsId)
    let formattedComments = comments.map((item) => ({
      ...item,
      timeStr: app.formatTime(item.createTime)
    }))

    if (app.globalData.cloudReady && formattedComments.length) {
      const avatarMap = await app.resolveFileUrlsMap(formattedComments.map((item) => item.avatar))
      formattedComments = formattedComments.map((item) => ({
        ...item,
        avatar: avatarMap[item.avatar] || item.avatar || '/images/avatar_default.png'
      }))
    }

    const commentMap = {}
    formattedComments.forEach((item) => {
      commentMap[item._id] = {
        ...item,
        replies: []
      }
    })

    const topLevelComments = []
    formattedComments.forEach((item) => {
      const current = commentMap[item._id]
      const parentId = item.replyTo && item.replyTo.commentId
      if (parentId && commentMap[parentId]) {
        commentMap[parentId].replies.push(current)
      } else {
        topLevelComments.push(current)
      }
    })

    this.setData({
      comments: topLevelComments,
      commentCount: formattedComments.length
    })
  },

  onPreviewImage(e) {
    const urls = this.data.goods && this.data.goods.images
    if (!urls || !urls.length) return
    const idx = e.currentTarget.dataset.index || 0
    wx.previewImage({ current: urls[idx], urls })
  },

  onSellerTap() {
    if (this.data.goods && this.data.goods._openid) {
      wx.navigateTo({ url: `/pages/profile/profile?openid=${this.data.goods._openid}` })
    }
  },

  async onFavor() {
    if (this._favorBusy) return
    if (!app.requestComplianceForAction()) return
    this._favorBusy = true
    try {
      const result = await app.callDB('toggleFavorGoods', { goodsId: this.data.goodsId })
      if (result && result.code === 0) {
        this.setData({ isFavored: result.data.isFavored })
        wx.showToast({ title: result.data.isFavored ? '已收藏' : '取消收藏', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this._favorBusy = false
    }
  },

  async onWant() {
    if (this._wantBusy) return
    if (!app.requestComplianceForAction()) return
    this._wantBusy = true
    try {
      await app.callDB('wantMarketGoods', { goodsId: this.data.goodsId })
      wx.showToast({ title: '已标记想要', icon: 'success' })
      await this.loadGoods(this.data.goodsId)
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this._wantBusy = false
    }
  },

  onChat() {
    if (!app.requestComplianceForAction()) return
    if (this.data.isOwner) {
      wx.showToast({ title: '这是您发布的商品', icon: 'none' })
      return
    }
    if (this.data.goods) {
      const g = this.data.goods
      wx.navigateTo({
        url: `/pages/chat/chat?openid=${g._openid}&nickname=${encodeURIComponent(g.nickname || '卖家')}&shareType=goods&shareId=${this.data.goodsId}&autoShare=1`
      })
    }
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value })
  },

  onReplyComment(e) {
    const commentId = e.currentTarget.dataset.id
    let comment = null
    ;(this.data.comments || []).some((item) => {
      if (item._id === commentId) {
        comment = item
        return true
      }
      const child = (item.replies || []).find((reply) => reply._id === commentId)
      if (child) {
        comment = child
        return true
      }
      return false
    })
    if (!comment) return

    this.setData({
      replyTarget: {
        commentId: comment._id,
        nickname: comment.nickname || '用户'
      },
      inputPlaceholder: `回复 @${comment.nickname || '用户'}...`
    })
  },

  onCancelReply() {
    this.setData({
      replyTarget: null,
      inputPlaceholder: '说说你对这个商品的看法...'
    })
  },

  async onSendComment() {
    if (this.data.sendingComment) return
    if (!app.requestComplianceForAction()) return
    const content = (this.data.commentText || '').trim()
    if (!content) {
      wx.showToast({ title: '请输入评论内容', icon: 'none' })
      return
    }

    const check = app.checkContent(content)
    if (!check.pass) {
      wx.showModal({
        title: '内容审核未通过',
        content: `评论包含违规内容"${check.word}"，请修改。`,
        showCancel: false,
        confirmColor: '#426089'
      })
      return
    }

    this.setData({ sendingComment: true })
    try {
      const result = await app.addMarketComment(
        this.data.goodsId,
        content,
        this.data.replyTarget
      )
      if (result) {
        this.setData({
          commentText: '',
          replyTarget: null,
          inputPlaceholder: '说说你对这个商品的看法...'
        })
        wx.showToast({ title: '评论成功', icon: 'none' })
        await this.loadComments(this.data.goodsId)
      }
    } catch (err) {
      wx.showToast({ title: '评论发送失败，请重试', icon: 'none' })
    } finally {
      this.setData({ sendingComment: false })
    }
  },

  onDeleteGoods() {
    wx.showModal({
      title: '下架商品',
      content: '下架后商品将不再对外展示，确定继续吗？',
      confirmColor: '#d32f2f',
      success: async (res) => {
        if (!res.confirm) return
        const success = await app.deleteMarketGoodsById(this.data.goodsId)
        if (success) {
          wx.showToast({ title: '商品已下架', icon: 'none' })
          setTimeout(() => { wx.navigateBack() }, 1200)
        }
      }
    })
  },

  onShareAppMessage() {
    const g = this.data.goods
    return {
      title: g ? `¥${g.price} ${g.title}` : '校园集市好物',
      path: `/pages/market-detail/market-detail?id=${this.data.goodsId}`,
      imageUrl: this.data.shareImageUrl || '/images/icon_share.png'
    }
  }
})
