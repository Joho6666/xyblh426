const app = getApp()
const CHAT_DRAFT_KEY_PREFIX = 'chat_input_draft_'

const recorderManager = wx.getRecorderManager()

function formatVoiceSeconds(duration) {
  const seconds = Math.max(1, Math.round((duration || 0) / 1000))
  return `${seconds}"`
}

function getVoiceWidth(duration) {
  const seconds = Math.max(1, Math.round((duration || 0) / 1000))
  return `${Math.min(360, 132 + seconds * 34)}rpx`
}

function inferVoiceExt(msg) {
  const candidates = [msg && msg.fileId, msg && msg.content, msg && msg.mediaUrl]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const matched = candidate.match(/\.([a-zA-Z0-9]+)(?:[\?#]|$)/)
    if (matched && matched[1]) {
      return matched[1].toLowerCase()
    }
  }
  return 'aac'
}

function inferLocalFileExt(filePath, fallback = 'mp3') {
  if (typeof filePath !== 'string') return fallback
  const matched = filePath.match(/\.([a-zA-Z0-9]+)(?:[\?#]|$)/)
  return matched && matched[1] ? matched[1].toLowerCase() : fallback
}

function decodeNickname(raw) {
  if (!raw) return '聊天'
  try {
    return decodeURIComponent(raw)
  } catch (err) {
    return raw
  }
}

/** 录音浮层时间 0:05 */
function formatRecordingClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

/** 上滑取消阈值（px，约等于 100rpx@2x） */
const CANCEL_SWIPE_PX = 72

Page({
  data: {
    targetOpenid: '',
    targetUser: {},
    messages: [],
    pendingShare: null,
    inputText: '',
    loading: true,
    loadError: '',
    sending: false,
    composerStatus: '',
    showEmojiPanel: false,
    showActionPanel: false,
    voiceMode: false,
    isRecording: false,
    recordingDuration: 0,
    recordingTimeStr: '0:00',
    recordingCancelHint: false,
    recordingWaveLevels: [22, 38, 55, 42, 28, 48, 33],
    scrollToMsg: '',
    playingId: '',
    myAvatarUrl: '/images/avatar_default.png',
    emojis: ['😀', '😄', '😆', '😉', '🥹', '😍', '🤔', '😭', '😡', '🥳', '👍', '👏', '🙏', '❤️', '💔', '🎉']
  },

  getDraftKey() {
    return `${CHAT_DRAFT_KEY_PREFIX}${this.data.targetOpenid || ''}`
  },

  setComposerStatus(text) {
    this.setData({ composerStatus: text })
    if (this.composerStatusTimer) {
      clearTimeout(this.composerStatusTimer)
    }
    if (!text) return
    this.composerStatusTimer = setTimeout(() => {
      this.setData({ composerStatus: '' })
    }, 1800)
  },

  scrollToBottom(delay = 0) {
    const run = () => {
      const messages = this.data.messages || []
      if (messages.length > 0) {
        this.setData({ scrollToMsg: `msg-${messages[messages.length - 1]._id}` })
      }
    }
    if (delay > 0) {
      setTimeout(run, delay)
    } else {
      run()
    }
  },

  saveInputDraft({ silent = true } = {}) {
    if (!this.data.targetOpenid) return
    const key = this.getDraftKey()
    const value = (this.data.inputText || '').trim()
    if (!value) {
      wx.removeStorageSync(key)
      return
    }
    wx.setStorageSync(key, {
      inputText: this.data.inputText,
      savedAt: Date.now()
    })
    this.setComposerStatus(silent ? '已自动保存输入内容' : '输入内容已保存')
  },

  restoreInputDraft() {
    const key = this.getDraftKey()
    const draft = wx.getStorageSync(key)
    if (draft && draft.inputText) {
      this.setData({ inputText: draft.inputText })
      this.setComposerStatus('已恢复上次未发送内容')
    }
  },

  clearInputDraft() {
    if (!this.data.targetOpenid) return
    wx.removeStorageSync(this.getDraftKey())
  },

  async onLoad(options) {
    const targetOpenid = options.openid || options.userId || ''
    const initialTitle = decodeNickname(options.nickname)
    this.shareOptions = {
      shareType: options.shareType || '',
      shareId: options.shareId || '',
      autoShare: options.autoShare === '1'
    }
    this.setData({ targetOpenid })
    wx.setNavigationBarTitle({ title: initialTitle || '聊天' })

    this.isLoadingMessages = false
    this.recordWillCancel = false
    this.voiceFileCache = {}
    this.voiceFallbackCache = {}

    if (wx.setInnerAudioOption) {
      wx.setInnerAudioOption({ obeyMuteSwitch: false })
    }
    /** 不在此挂全局 InnerAudio：此前 onStop 会在每次 play 前 stop() 时误清空 playingId，导致无法播放 */

    this.handleRecorderStop = async (res) => {
      this._stopRecordingTimer()
      this._stopWaveAnimation()
      const cancelled = this.recordWillCancel
      this.recordWillCancel = false
      this.setData({
        isRecording: false,
        recordingDuration: 0,
        recordingTimeStr: '0:00',
        recordingCancelHint: false
      })

      if (cancelled) {
        wx.showToast({ title: '已取消录音', icon: 'none' })
        return
      }

      if (!res.tempFilePath || res.duration < 800) {
        wx.showToast({ title: '录音时间太短', icon: 'none' })
        return
      }

      try {
        this.setData({ sending: true })
        wx.showLoading({ title: '发送中', mask: true })
        const ext = inferLocalFileExt(res.tempFilePath, 'mp3')
        const cloudPath = `chat/voice/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath,
          filePath: res.tempFilePath
        })

        const msg = await app.sendMessage(this.data.targetOpenid, uploadRes.fileID, 'voice', {
          fileId: uploadRes.fileID,
          duration: res.duration
        })
        if (!msg) return

        this.setData({ showEmojiPanel: false, showActionPanel: false })
        this.setComposerStatus('语音已发送')
        await this.loadMessages()
      } catch (err) {
        wx.showToast({ title: '语音发送失败', icon: 'none' })
      } finally {
        this.setData({ sending: false })
        wx.hideLoading()
      }
    }

    this.handleRecorderError = () => {
      this._stopRecordingTimer()
      this._stopWaveAnimation()
      this.recordWillCancel = false
      this.setData({
        isRecording: false,
        recordingDuration: 0,
        recordingTimeStr: '0:00',
        recordingCancelHint: false
      })
      wx.showToast({ title: '录音不可用，请检查权限', icon: 'none' })
    }

    recorderManager.onStop(this.handleRecorderStop)
    recorderManager.onError(this.handleRecorderError)

    if (targetOpenid) {
      const selfMedia = await app.resolveUserMedia(app.globalData.userInfo || {})
      const targetUser = await app.getUserInfo(targetOpenid)
      if (targetUser) {
        const resolvedTargetUser = await app.resolveUserMedia(targetUser)
        this.setData({
          targetUser: resolvedTargetUser,
          myAvatarUrl: selfMedia.avatarUrl || '/images/avatar_default.png'
        })
        wx.setNavigationBarTitle({ title: targetUser.nickName || initialTitle || '聊天' })
      }

      await this.preparePendingShare()
      this.restoreInputDraft()
      await this.loadMessages()
      app.syncMessageBadge(typeof this.getTabBar === 'function' ? this.getTabBar() : null)
    }
  },

  onShow() {
    this.startRefreshTimer()
  },

  onHide() {
    this.stopRefreshTimer()
    this._destroyVoicePlayer()
    if (!this.data.sending) {
      this.saveInputDraft({ silent: true })
    }
    if (this.data.isRecording) {
      this._stopRecordingTimer()
      this._stopWaveAnimation()
      this.recordWillCancel = true
      recorderManager.stop()
    }
  },

  onUnload() {
    this.stopRefreshTimer()
    this._stopWaveAnimation()
    if (this.composerStatusTimer) {
      clearTimeout(this.composerStatusTimer)
      this.composerStatusTimer = null
    }
    if (this.handleRecorderStop && recorderManager.offStop) {
      recorderManager.offStop(this.handleRecorderStop)
    }
    if (this.handleRecorderError && recorderManager.offError) {
      recorderManager.offError(this.handleRecorderError)
    }
    this._destroyVoicePlayer()
    this.voiceFileCache = {}
    this.voiceFallbackCache = {}
  },

  _destroyVoicePlayer() {
    if (this._voicePlayer) {
      try {
        this._voicePlayer.stop()
      } catch (e) {}
      try {
        this._voicePlayer.destroy()
      } catch (e) {}
      this._voicePlayer = null
    }
  },

  startRefreshTimer() {
    if (!this.data.targetOpenid || this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      this.loadMessages({ silent: true })
    }, 6000)
  },

  stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  },

  async loadMessages({ silent = false } = {}) {
    if (!this.data.targetOpenid || this.isLoadingMessages) return

    this.isLoadingMessages = true
    if (this._loadMsgTimeout) clearTimeout(this._loadMsgTimeout)
    this._loadMsgTimeout = setTimeout(() => { this.isLoadingMessages = false }, 15000)
    try {
      if (!silent || this.data.messages.length === 0) {
        this.setData({ loading: true, loadError: '' })
      } else if (this.data.loadError) {
        this.setData({ loadError: '' })
      }
      const toMs = (value) => {
        if (!value) return 0
        if (value instanceof Date) return value.getTime()
        const num = Number(value)
        if (Number.isFinite(num) && num > 0) return num
        const parsed = new Date(value).getTime()
        return Number.isFinite(parsed) ? parsed : 0
      }

      const currentMessages = this.data.messages || []
      let sinceTime = 0
      if (silent && currentMessages.length > 0) {
        const latest = currentMessages[currentMessages.length - 1]
        const latestMs = toMs(latest && latest.createTime)
        if (latestMs > 0) {
          sinceTime = Math.max(0, latestMs - 1)
        }
      }

      const reqData = { targetOpenid: this.data.targetOpenid }
      if (sinceTime > 0) {
        reqData.sinceTime = sinceTime
      }
      const result = await app.callDB('getMessages', reqData)
      const rawMessages = result.data || []
      const myOpenid = app.globalData.openid
      const hasUnreadIncoming = rawMessages.some(
        (m) => m && m.toOpenid === myOpenid && !m.isRead
      )
      if (hasUnreadIncoming) {
        app.invalidateCacheByPrefix('unread:')
      }

      // 静默轮询增量模式：只追加新消息，不重算整页媒体
      if (sinceTime > 0) {
        if (rawMessages.length === 0) {
          return
        }
        const withCoverIds = await this.resolveShareCardCoverIds(rawMessages)
        const incoming = await this.resolveMediaMessages(withCoverIds)
        const existingIds = new Set(currentMessages.map((m) => String(m._id || '')))
        const merged = currentMessages.slice()

        incoming.forEach((message) => {
          const msgId = String(message._id || '')
          if (msgId && existingIds.has(msgId)) return
          if (msgId) existingIds.add(msgId)
          const previous = merged[merged.length - 1]
          const isMine = message.fromOpenid === myOpenid
          const avatar = isMine
            ? (this.data.myAvatarUrl || '/images/avatar_default.png')
            : (this.data.targetUser.avatarUrl || '/images/avatar_default.png')
          const timeStr = app.formatTime(message.createTime)
          const previousTimeStr = previous ? (previous.timeStr || app.formatTime(previous.createTime)) : ''
          merged.push({
            ...message,
            isMine,
            avatar,
            timeStr,
            showTime: !previous || timeStr !== previousTimeStr,
            voiceSeconds: formatVoiceSeconds(message.duration),
            voiceWidth: getVoiceWidth(message.duration)
          })
        })

        if (merged.length === currentMessages.length) {
          return
        }
        const latestItem = merged[merged.length - 1]
        this.setData({
          messages: merged,
          loading: false,
          loadError: '',
          scrollToMsg: latestItem && latestItem._id ? `msg-${latestItem._id}` : this.data.scrollToMsg
        })
        this.scrollToBottom()
        app.syncMessageBadge(
          typeof this.getTabBar === 'function' ? this.getTabBar() : null,
          { minIntervalMs: 15000 }
        )
        return
      }

      const withCoverIds = await this.resolveShareCardCoverIds(rawMessages)
      const messages = await this.resolveMediaMessages(withCoverIds)

      const formatted = messages.map((message, index) => {
        const isMine = message.fromOpenid === myOpenid
        const avatar = isMine
          ? (this.data.myAvatarUrl || '/images/avatar_default.png')
          : (this.data.targetUser.avatarUrl || '/images/avatar_default.png')
        const timeStr = app.formatTime(message.createTime)
        const previous = messages[index - 1]
        const previousTimeStr = previous ? app.formatTime(previous.createTime) : ''

        return {
          ...message,
          isMine,
          avatar,
          timeStr,
          showTime: index === 0 || timeStr !== previousTimeStr,
          voiceSeconds: formatVoiceSeconds(message.duration),
          voiceWidth: getVoiceWidth(message.duration)
        }
      })

      const nextState = {
        messages: formatted,
        loading: false,
        loadError: ''
      }
      if (formatted.length > 0) {
        nextState.scrollToMsg = `msg-${formatted[formatted.length - 1]._id}`
      }
      this.setData(nextState)
      this.scrollToBottom()
      app.syncMessageBadge(
        typeof this.getTabBar === 'function' ? this.getTabBar() : null,
        { minIntervalMs: 15000 }
      )
    } catch (err) {
      this.setData({
        loading: false,
        loadError: err.msg || '消息加载失败'
      })
    } finally {
      this.isLoadingMessages = false
      if (this._loadMsgTimeout) {
        clearTimeout(this._loadMsgTimeout)
        this._loadMsgTimeout = null
      }
    }
  },

  /**
   * 私信卡片里历史数据可能存的是已过期的临时 HTTPS，或非 cloud 值；按帖子/商品 id 从库中补全 cloud:// 封面
   */
  async resolveShareCardCoverIds(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages

    const postIds = new Set()
    const goodsIds = new Set()

    messages.forEach((m) => {
      if (!m.shareData || !m.shareData.id) return
      const imgStr = typeof m.shareData.image === 'string' ? m.shareData.image : ''
      if (imgStr.startsWith('cloud://')) return
      if (imgStr.startsWith('/') && imgStr.length > 1) return
      if (m.type === 'post_share') postIds.add(m.shareData.id)
      else if (m.type === 'goods_share') goodsIds.add(m.shareData.id)
    })

    const postCover = {}
    await Promise.all([...postIds].map(async (id) => {
      try {
        const p = await app.getPostById(id)
        if (p) {
          postCover[id] = (Array.isArray(p.images) && p.images.length ? p.images[0] : p.image) || ''
        }
      } catch (e) {
        console.warn('[resolveShareCardCoverIds] post', id, e)
      }
    }))

    const goodsCover = {}
    await Promise.all([...goodsIds].map(async (id) => {
      try {
        const r = await app.callDB('getMarketGoodsById', { goodsId: id })
        const g = r && r.data
        if (g) {
          goodsCover[id] = (Array.isArray(g.images) && g.images.length ? g.images[0] : '') || ''
        }
      } catch (e) {
        console.warn('[resolveShareCardCoverIds] goods', id, e)
      }
    }))

    const placeholder = '/images/icon_share.png'

    return messages.map((m) => {
      if ((m.type !== 'post_share' && m.type !== 'goods_share') || !m.shareData || !m.shareData.id) {
        return m
      }
      const imgStr = typeof m.shareData.image === 'string' ? m.shareData.image : ''
      if (imgStr.startsWith('cloud://')) return m
      if (imgStr.startsWith('/') && imgStr.length > 1) return m

      const fid = m.type === 'post_share' ? postCover[m.shareData.id] : goodsCover[m.shareData.id]
      if (typeof fid === 'string' && fid.startsWith('cloud://')) {
        return { ...m, shareData: { ...m.shareData, image: fid } }
      }
      return { ...m, shareData: { ...m.shareData, image: imgStr || placeholder } }
    })
  },

  async resolveMediaMessages(messages) {
    const fileIdSet = new Set()
    const placeholder = '/images/icon_share.png'

    messages.forEach((message) => {
      const candidate = message.fileId || message.content
      if ((message.type === 'image' || message.type === 'voice') && typeof candidate === 'string' && candidate.startsWith('cloud://')) {
        fileIdSet.add(candidate)
      }
      if ((message.type === 'post_share' || message.type === 'goods_share') && message.shareData && typeof message.shareData.image === 'string' && message.shareData.image.startsWith('cloud://')) {
        fileIdSet.add(message.shareData.image)
      }
    })

    let fileMap = {}
    if (fileIdSet.size > 0) {
      const tempFiles = await app.getTempFileUrls(Array.from(fileIdSet))
      fileMap = tempFiles.reduce((map, item) => {
        const fid = item.fileID || item.FileID
        const fileUrl = item.tempFileURL || item.TempFileURL || item.download_url || item.download_URL
        if (fid && fileUrl) {
          map[fid] = fileUrl
        }
        return map
      }, {})
    }

    return messages.map((message) => {
      if (message.type !== 'image' && message.type !== 'voice') {
        if ((message.type === 'post_share' || message.type === 'goods_share') && message.shareData) {
          const raw = typeof message.shareData.image === 'string' ? message.shareData.image : ''
          let image = raw
          if (raw.startsWith('cloud://')) {
            image = fileMap[raw] || ''
            if (!image) image = placeholder
          } else if (raw && !raw.startsWith('/')) {
            image = placeholder
          }
          return {
            ...message,
            shareData: {
              ...message.shareData,
              image
            }
          }
        }
        return message
      }

      const fileId = message.fileId || message.content
      return {
        ...message,
        fileId,
        mediaUrl: fileMap[fileId] || fileId || message.content
      }
    })
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value })
  },

  onInputFocus() {
    if (this.data.showEmojiPanel || this.data.showActionPanel) {
      this.setData({
        showEmojiPanel: false,
        showActionPanel: false
      })
    }
    this.scrollToBottom(120)
  },

  onBodyTap() {
    if (!this.data.showEmojiPanel && !this.data.showActionPanel) return
    this.setData({
      showEmojiPanel: false,
      showActionPanel: false
    })
  },

  onRecordingOverlayMove() {},

  async onSend() {
    if (this.data.sending) return
    const text = this.data.inputText.trim()
    if (!text) return

    const check = app.checkContent(text)
    if (!check.pass) {
      wx.showModal({
        title: '内容审核未通过',
        content: `消息包含违规内容“${check.word}”，请修改后重试。`,
        showCancel: false,
        confirmColor: '#426089'
      })
      return
    }

    this.setData({ sending: true })
    try {
      const msg = await app.sendMessage(this.data.targetOpenid, text, 'text')
      if (!msg) {
        wx.showToast({ title: '发送失败，请重试', icon: 'none' })
        return
      }
      this.clearInputDraft()
      this.setData({
        inputText: '',
        showEmojiPanel: false,
        showActionPanel: false
      })
      this.setComposerStatus('发送成功')
      await this.loadMessages()
    } catch (err) {
      wx.showToast({ title: '发送失败，请检查网络', icon: 'none' })
    } finally {
      this.setData({ sending: false })
    }
  },

  async preparePendingShare() {
    const { shareType, shareId, autoShare } = this.shareOptions || {}
    if (!shareType || !shareId) return

    let pendingShare = null
    if (shareType === 'post') {
      const post = await app.getPostById(shareId)
      if (post) {
        const persistImage = Array.isArray(post.images) && post.images.length
          ? post.images[0]
          : (post.image || '')
        const resolved = await app.resolvePostMedia({ ...post })
        const displayImage = Array.isArray(resolved.images) && resolved.images.length
          ? resolved.images[0]
          : (resolved.image || '')
        pendingShare = {
          type: 'post',
          id: resolved._id,
          title: resolved.title || '帖子',
          summary: (resolved.content || '').trim(),
          image: persistImage,
          displayImage: displayImage || persistImage,
          category: resolved.category || ''
        }
      }
    } else if (shareType === 'goods') {
      const result = await app.callDB('getMarketGoodsById', { goodsId: shareId }).catch(() => null)
      const goods = result && result.data
      if (goods) {
        const persistImage = Array.isArray(goods.images) && goods.images.length ? goods.images[0] : ''
        const resolved = await app.resolvePostMedia({ ...goods })
        const displayImage = Array.isArray(resolved.images) && resolved.images.length ? resolved.images[0] : ''
        pendingShare = {
          type: 'goods',
          id: resolved._id,
          title: resolved.title || '商品',
          summary: (resolved.description || '').trim(),
          image: persistImage,
          displayImage: displayImage || persistImage,
          price: resolved.price
        }
      }
    }

    if (!pendingShare) return
    this.setData({ pendingShare })
    if (autoShare && !this._autoSharedOnce) {
      this._autoSharedOnce = true
      await this.onSendShareCard()
    }
  },

  async onSendShareCard() {
    const share = this.data.pendingShare
    if (!share || this.data.sending) return
    this.setData({ sending: true })
    try {
      let msg = null
      if (share.type === 'post') {
        msg = await app.sendPostCardMessage(this.data.targetOpenid, {
          _id: share.id, title: share.title, content: share.summary,
          image: share.image, images: share.image ? [share.image] : [],
          category: share.category
        })
      } else if (share.type === 'goods') {
        msg = await app.sendGoodsCardMessage(this.data.targetOpenid, {
          _id: share.id, title: share.title, description: share.summary,
          images: share.image ? [share.image] : [], price: share.price
        })
      }
      if (!msg) {
        wx.showToast({ title: '发送失败，请重试', icon: 'none' })
        return
      }
      this.setData({ pendingShare: null })
      this.setComposerStatus('内容卡片已发送')
      await this.loadMessages()
    } catch (err) {
      wx.showToast({ title: '发送失败，请检查网络', icon: 'none' })
    } finally {
      this.setData({ sending: false })
    }
  },

  onOpenShareCard(e) {
    const type = e.currentTarget.dataset.type
    const id = e.currentTarget.dataset.id
    if (!type || !id) return
    if (type === 'post') {
      wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
      return
    }
    if (type === 'goods') {
      wx.navigateTo({ url: `/pages/market-detail/market-detail?id=${id}` })
    }
  },

  onToggleEmoji() {
    this.setData({
      showEmojiPanel: !this.data.showEmojiPanel,
      showActionPanel: false
    })
    this.scrollToBottom(120)
  },

  onToggleActions() {
    this.setData({
      showActionPanel: !this.data.showActionPanel,
      showEmojiPanel: false
    })
    this.scrollToBottom(120)
  },

  async onEmojiTap(e) {
    if (this.data.sending) return
    const emoji = e.currentTarget.dataset.emoji
    this.setData({ sending: true })
    try {
      const msg = await app.sendMessage(this.data.targetOpenid, emoji, 'emoji')
      if (!msg) {
        wx.showToast({ title: '发送失败', icon: 'none' })
        return
      }
      this.setData({ showEmojiPanel: false })
      this.setComposerStatus('发送成功')
      this.scrollToBottom(80)
      await this.loadMessages()
    } catch (err) {
      wx.showToast({ title: '发送失败，请检查网络', icon: 'none' })
    } finally {
      this.setData({ sending: false })
    }
  },

  async ensureRecordPermission() {
    const setting = await new Promise((resolve) => {
      wx.getSetting({
        success: resolve,
        fail: () => resolve({ authSetting: {} })
      })
    })
    if (setting.authSetting['scope.record']) return true

    const granted = await new Promise((resolve) => {
      wx.authorize({
        scope: 'scope.record',
        success: () => resolve(true),
        fail: () => resolve(false)
      })
    })
    if (granted) return true

    wx.showModal({
      title: '需要录音权限',
      content: '开启录音权限后才能发送语音消息。',
      confirmText: '去设置',
      success: (res) => {
        if (res.confirm) {
          wx.openSetting()
        }
      }
    })
    return false
  },

  onToggleVoiceMode() {
    const next = !this.data.voiceMode
    this.setData({
      voiceMode: next,
      showEmojiPanel: false,
      showActionPanel: false
    })
    if (next) {
      this.setComposerStatus('按住下方按钮说话')
    }
  },

  _startRecordingTimer() {
    this._recordStartTime = Date.now()
    this.setData({ recordingDuration: 0, recordingTimeStr: '0:00' })
    this._recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this._recordStartTime) / 1000)
      this.setData({
        recordingDuration: elapsed,
        recordingTimeStr: formatRecordingClock(elapsed)
      })
      if (elapsed >= 55) {
        this.setComposerStatus(`还剩 ${60 - elapsed} 秒`)
      }
    }, 1000)
  },

  _stopRecordingTimer() {
    if (this._recordingTimer) {
      clearInterval(this._recordingTimer)
      this._recordingTimer = null
    }
    this._recordStartTime = null
  },

  /** 模拟音量条高度（微信式波动） */
  _startWaveAnimation() {
    this._stopWaveAnimation()
    this._waveAnimTimer = setInterval(() => {
      const levels = []
      for (let i = 0; i < 7; i++) {
        const base = 20 + Math.random() * 55
        const wobble = Math.sin(Date.now() / 180 + i) * 12
        levels.push(Math.min(92, Math.max(14, Math.round(base + wobble))))
      }
      if (this.data.isRecording) {
        this.setData({ recordingWaveLevels: levels })
      }
    }, 120)
  },

  _stopWaveAnimation() {
    if (this._waveAnimTimer) {
      clearInterval(this._waveAnimTimer)
      this._waveAnimTimer = null
    }
  },

  async onVoiceTouchStart(e) {
    if (this.data.isRecording || this.data.sending) return
    const permitted = await this.ensureRecordPermission()
    if (!permitted) return

    const touch = e.touches[0]
    this._voiceTouchStartY = touch.clientY
    this._voiceTouchId = touch.identifier

    this.recordWillCancel = false
    this._lastCancelHint = false
    this.setData({
      isRecording: true,
      recordingCancelHint: false,
      recordingDuration: 0,
      recordingTimeStr: '0:00',
      showEmojiPanel: false,
      showActionPanel: false
    })
    try {
      wx.vibrateShort({ type: 'heavy' })
    } catch (err) {}

    this._startRecordingTimer()
    this._startWaveAnimation()
    recorderManager.start({ duration: 60000, format: 'mp3' })
  },

  onVoiceTouchMove(e) {
    if (!this.data.isRecording) return
    const touch = Array.from(e.touches).find((t) => t.identifier === this._voiceTouchId)
    if (!touch) return

    const dy = this._voiceTouchStartY - touch.clientY
    const inCancelZone = dy > CANCEL_SWIPE_PX

    if (inCancelZone !== this.data.recordingCancelHint) {
      this.setData({ recordingCancelHint: inCancelZone })
      if (inCancelZone) {
        try {
          wx.vibrateShort({ type: 'medium' })
        } catch (err) {}
      } else if (this._lastCancelHint) {
        try {
          wx.vibrateShort({ type: 'light' })
        } catch (err) {}
      }
    }
    this._lastCancelHint = inCancelZone
  },

  onVoiceTouchEnd() {
    if (!this.data.isRecording) return
    this._stopRecordingTimer()
    this._stopWaveAnimation()

    if (this.data.recordingCancelHint) {
      this.recordWillCancel = true
      this.setData({ recordingCancelHint: false })
    }
    recorderManager.stop()
  },

  onVoiceTouchCancel() {
    if (!this.data.isRecording) return
    this._stopRecordingTimer()
    this._stopWaveAnimation()
    this.recordWillCancel = true
    this.setData({ recordingCancelHint: false })
    recorderManager.stop()
  },

  async onChooseFromAlbum() {
    await this.pickAndSendImage(['album'])
  },

  async onTakePhoto() {
    await this.pickAndSendImage(['camera'])
  },

  async pickAndSendImage(sourceType) {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType
      })

      const file = res.tempFiles && res.tempFiles[0]
      if (!file || !file.tempFilePath) return

      const check = await app.checkImageContent(file.tempFilePath)
      if (!check.pass) {
        wx.showToast({ title: check.errMsg || '图片不合规', icon: 'none' })
        return
      }

      wx.showLoading({ title: '发送中', mask: true })
      this.setData({ sending: true })
      const ext = (file.tempFilePath.split('.').pop() || 'jpg').toLowerCase()
      const cloudPath = `chat/image/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: file.tempFilePath
      })

      const msg = await app.sendMessage(this.data.targetOpenid, uploadRes.fileID, 'image', {
        fileId: uploadRes.fileID,
        width: file.width || 0,
        height: file.height || 0
      })
      if (!msg) return

      this.setData({ showActionPanel: false })
      this.setComposerStatus('图片已发送')
      await this.loadMessages()
    } catch (err) {
      if (err && /cancel/i.test(err.errMsg || '')) return
      wx.showToast({ title: '图片发送失败', icon: 'none' })
    } finally {
      this.setData({ sending: false })
      wx.hideLoading()
    }
  },

  onRetryLoad() {
    this.loadMessages()
  },

  onPullDownRefresh() {
    this.loadMessages({ silent: true }).finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  /**
   * 语音播放地址：优先 cloud.downloadFile 到本地（不走临时链接域名白名单问题），
   * 失败再尝试 HTTPS 下载到本地，最后才直连 URL。
   */
  async ensurePlayableVoiceSrc(msg) {
    const mid = msg && msg._id != null ? String(msg._id) : ''
    if (mid && this.voiceFileCache[mid]) {
      return this.voiceFileCache[mid]
    }

    const persistLocalVoiceFile = async (tempFilePath) => {
      if (!tempFilePath || typeof tempFilePath !== 'string') return tempFilePath
      if (!wx.getFileSystemManager || !wx.env || !wx.env.USER_DATA_PATH || !mid) {
        return tempFilePath
      }
      const fs = wx.getFileSystemManager()
      const ext = inferVoiceExt(msg)
      const localPath = `${wx.env.USER_DATA_PATH}/chat_voice_${mid}.${ext}`
      try {
        await new Promise((resolve) => {
          fs.unlink({
            filePath: localPath,
            success: resolve,
            fail: resolve
          })
        })
        await new Promise((resolve, reject) => {
          fs.copyFile({
            srcPath: tempFilePath,
            destPath: localPath,
            success: resolve,
            fail: reject
          })
        })
        if (mid) {
          this.voiceFallbackCache[mid] = tempFilePath
        }
        return localPath
      } catch (err) {
        console.warn('[语音] 本地落盘失败，回退临时文件:', err)
        return tempFilePath
      }
    }

    const cloudId =
      (typeof msg.fileId === 'string' && msg.fileId.startsWith('cloud://') && msg.fileId) ||
      (typeof msg.content === 'string' && msg.content.startsWith('cloud://') && msg.content) ||
      ''

    if (cloudId && app.globalData.cloudReady && wx.cloud && typeof wx.cloud.downloadFile === 'function') {
      try {
        const res = await new Promise((resolve, reject) => {
          wx.cloud.downloadFile({
            fileID: cloudId,
            success: resolve,
            fail: reject
          })
        })
        if (res && res.tempFilePath) {
          const localPath = await persistLocalVoiceFile(res.tempFilePath)
          if (mid) this.voiceFileCache[mid] = localPath
          return localPath
        }
      } catch (e) {
        console.warn('[语音] wx.cloud.downloadFile 失败，尝试临时链接:', e)
      }
    }

    let src = msg.mediaUrl || cloudId || msg.content
    if (!src || typeof src !== 'string') {
      throw new Error('语音文件无效')
    }
    if (src.startsWith('cloud://')) {
      src = await app.resolveFileUrl(src)
    }
    if (!src || src.startsWith('cloud://')) {
      throw new Error('语音链接解析失败')
    }

    if (/^https?:\/\//i.test(src)) {
      try {
        const dl = await new Promise((resolve, reject) => {
          wx.downloadFile({
            url: src,
            success: resolve,
            fail: reject
          })
        })
        if (dl.statusCode === 200 && dl.tempFilePath) {
          const localPath = await persistLocalVoiceFile(dl.tempFilePath)
          if (mid) this.voiceFileCache[mid] = localPath
          return localPath
        }
      } catch (e) {
        console.warn('[语音] wx.downloadFile(https) 失败，尝试直连播放:', e)
      }
      if (mid) this.voiceFileCache[mid] = src
      return src
    }

    if (mid) this.voiceFileCache[mid] = src
    return src
  },

  /**
   * 播放语音：不用 data-src（长链接易被 dataset 截断），改为用 id 查消息再取 URL
   */
  async onPlayVoice(e) {
    const id = e.currentTarget.dataset.id
    if (id === undefined || id === null) return

    const msg = (this.data.messages || []).find(
      (m) => String(m._id) === String(id)
    )
    if (!msg || msg.type !== 'voice') return

    if (String(this.data.playingId) === String(id)) {
      this._destroyVoicePlayer()
      this.setData({ playingId: '' })
      return
    }

    this._destroyVoicePlayer()

    wx.showLoading({ title: '加载语音...', mask: true })
    try {
      const src = await this.ensurePlayableVoiceSrc(msg)
      const cloudId =
        (typeof msg.fileId === 'string' && msg.fileId.startsWith('cloud://') && msg.fileId) ||
        (typeof msg.content === 'string' && msg.content.startsWith('cloud://') && msg.content) ||
        ''
      const freshUrl = cloudId ? await app.resolveFileUrl(cloudId, '') : ''
      const fallbackLocal = (this.voiceFallbackCache && this.voiceFallbackCache[String(id)]) || ''
      const candidates = Array.from(new Set([src, fallbackLocal, msg.mediaUrl || '', freshUrl].filter(Boolean)))

      this.setData({ playingId: id })

      const playWithSource = (index) => {
        if (index >= candidates.length) {
          this.setData({ playingId: '' })
          wx.showToast({ title: '语音播放失败', icon: 'none' })
          return
        }

        const currentSrc = candidates[index]
        const ctx = wx.createInnerAudioContext()
        this._voicePlayer = ctx
        ctx.obeyMuteSwitch = false
        ctx.autoplay = true

        const safeClear = () => {
          if (this._voicePlayer === ctx) {
            this.setData({ playingId: '' })
            this._destroyVoicePlayer()
          }
        }

        ctx.onEnded(safeClear)
        ctx.onStop(() => {
          if (this._voicePlayer === ctx) {
            this.setData({ playingId: '' })
          }
        })
        ctx.onError((err) => {
          console.error('[语音播放]', err && (err.errMsg || err), currentSrc)
          if (this._voicePlayer === ctx) {
            this._destroyVoicePlayer()
          }
          playWithSource(index + 1)
        })

        let played = false
        const tryPlay = () => {
          if (played || this._voicePlayer !== ctx) return
          played = true
          try {
            ctx.play()
          } catch (err) {
            console.error('[语音] play()异常:', err, currentSrc)
            if (this._voicePlayer === ctx) {
              this._destroyVoicePlayer()
            }
            playWithSource(index + 1)
          }
        }

        ctx.onCanplay(tryPlay)
        ctx.src = currentSrc
        setTimeout(tryPlay, 500)
      }

      playWithSource(0)
    } catch (err) {
      this.setData({ playingId: '' })
      wx.showToast({ title: err.message || '语音加载失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  onPreviewImage(e) {
    const current = e.currentTarget.dataset.src
    const urls = this.data.messages
      .filter((message) => message.type === 'image' && message.mediaUrl)
      .map((message) => message.mediaUrl)

    wx.previewImage({ current, urls })
  },

  onViewProfile() {
    wx.navigateTo({ url: `/pages/profile/profile?openid=${this.data.targetOpenid}` })
  }
})
