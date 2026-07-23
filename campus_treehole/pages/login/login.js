const app = getApp()

/** 与 mine.js 退出登录写入的 key 一致 */
const LOGIN_PREFILL_KEY = 'login_prefill_v1'

const SEASONS = [
  { key: 'spring', emoji: '🌸', label: '春', text: '春暖花开，校园生活从这里开始' },
  { key: 'summer', emoji: '☀️', label: '夏', text: '阳光灿烂，校园生活从这里开始' },
  { key: 'autumn', emoji: '🍂', label: '秋', text: '秋高气爽，校园生活从这里开始' },
  { key: 'winter', emoji: '❄️', label: '冬', text: '银装素裹，校园生活从这里开始' }
]

Page({
  data: {
    avatarUrl: '/images/avatar_default.png',
    nickName: '',
    hasChosenAvatar: false,
    /** 须用户主动勾选，禁止默认同意（平台审核） */
    agreedTerms: false,
    logging: false,
    /** 云端已完善资料且已同意协议，可一键进首页 */
    canQuickEnter: false,
    /** 本次是否由退出登录带回的预填 */
    fromLogout: false,
    quickWelcome: false,
    season: 'spring',
    seasonEmoji: '🌸',
    seasonLabel: '春',
    seasonText: '春暖花开，校园生活从这里开始',
    transitioning: false
  },

  onLoad() {
    this._seasonIdx = 0
    this._startSeasonCycle()
    this._applyLogoutPrefill()
    app.waitForLogin((userInfo) => {
      let p = {}
      try {
        p = wx.getStorageSync(LOGIN_PREFILL_KEY) || {}
      } catch (e) {
        p = {}
      }
      if (!userInfo) {
        this.setData({
          canQuickEnter: false,
          quickWelcome: false,
          hasChosenAvatar: false
        })
        return
      }
      const baseNick = ((p.nickName != null && p.nickName !== '') ? p.nickName : userInfo.nickName || '')
        .trim()
      const baseAv =
        (p.avatarUrl != null && p.avatarUrl !== '')
          ? p.avatarUrl
          : userInfo.avatarUrl || '/images/avatar_default.png'
      const canQuick = !!(userInfo.profileCompleted && userInfo.agreedPrivacy)
      const fromLogout = this.data.fromLogout
      this.setData({
        nickName: baseNick,
        avatarUrl: baseAv,
        hasChosenAvatar: false,
        canQuickEnter: canQuick,
        quickWelcome: !!(canQuick && fromLogout)
      })
    })
  },

  _applyLogoutPrefill() {
    try {
      const p = wx.getStorageSync(LOGIN_PREFILL_KEY)
      if (p && typeof p === 'object') {
        this.setData({
          nickName: (p.nickName || '').trim(),
          avatarUrl: p.avatarUrl || '/images/avatar_default.png',
          hasChosenAvatar: false,
          fromLogout: true
        })
      }
    } catch (e) {
      console.warn('[login] prefill', e)
    }
  },

  onUnload() {
    if (this._seasonTimer) { clearInterval(this._seasonTimer); this._seasonTimer = null }
  },

  _startSeasonCycle() {
    if (this._seasonTimer) return
    this._seasonTimer = setInterval(() => {
      this._seasonIdx = (this._seasonIdx + 1) % 4
      const s = SEASONS[this._seasonIdx]
      this.setData({ transitioning: true })
      setTimeout(() => {
        this.setData({
          season: s.key,
          seasonEmoji: s.emoji,
          seasonLabel: s.label,
          seasonText: s.text,
          transitioning: false
        })
      }, 400)
    }, 7000)
  },

  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl
    if (avatarUrl) {
      this.setData({ avatarUrl, hasChosenAvatar: true })
    }
  },

  onNicknameInput(e) {
    this.setData({ nickName: e.detail.value })
  },

  onTermsChange(e) {
    const vals = e.detail.value || []
    this.setData({ agreedTerms: vals.indexOf('agree') >= 0 })
  },

  async onLogin() {
    if (this.data.logging) return
    const u = app.globalData.userInfo
    const needTerms = !(this.data.canQuickEnter && u && u.agreedPrivacy === true)
    if (needTerms && !this.data.agreedTerms) {
      wx.showToast({ title: '请先阅读并勾选同意协议', icon: 'none' })
      return
    }
    const nickName = this.data.nickName.trim()
    if (nickName) {
      const check = app.checkContent(nickName)
      if (!check.pass) {
        wx.showToast({ title: '昵称包含违规内容，请修改', icon: 'none' })
        return
      }
    }

    if (this.data.canQuickEnter && u && u.agreedPrivacy === true) {
      const nickSame = !nickName || (u.nickName || '').trim() === nickName
      const noNewAvatar = !this.data.hasChosenAvatar
      if (nickSame && noNewAvatar) {
        wx.switchTab({ url: '/pages/index/index' })
        return
      }
    }

    this.setData({ logging: true })
    wx.showLoading({ title: '登录中...', mask: true })
    try {
      let finalAvatarUrl = this.data.avatarUrl
      if (this.data.hasChosenAvatar && !this.data.avatarUrl.startsWith('/images/')) {
        try {
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `avatars/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`,
            filePath: this.data.avatarUrl
          })
          finalAvatarUrl = uploadRes.fileID
        } catch (err) {
          console.warn('头像上传失败，使用默认头像:', err)
          finalAvatarUrl = '/images/avatar_default.png'
        }
      }
      const payload = {
        profileCompleted: true
      }
      if (nickName) payload.nickName = nickName
      if (this.data.hasChosenAvatar) payload.avatarUrl = finalAvatarUrl
      const result = await app.updateProfile(payload)
      if (!result) throw new Error('更新资料失败')
      if (app.globalData.userInfo) {
        if (nickName) app.globalData.userInfo.nickName = nickName
        if (this.data.hasChosenAvatar) app.globalData.userInfo.avatarUrl = finalAvatarUrl
        app.globalData.userInfo.profileCompleted = true
      }
      wx.hideLoading()
      wx.showToast({ title: '欢迎来到校园便利盒', icon: 'success' })
      setTimeout(() => {
        if (app.globalData.userInfo && !app.globalData.userInfo.agreedPrivacy) {
          wx.redirectTo({ url: '/pages/privacy/privacy' })
        } else {
          wx.switchTab({ url: '/pages/index/index' })
        }
      }, 1500)
    } catch (err) {
      wx.hideLoading()
      this.setData({ logging: false })
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
      console.error('登录失败:', err)
    }
  },

  async onSkip() {
    if (this.data.logging) return
    const u0 = app.globalData.userInfo
    const needTerms = !(this.data.canQuickEnter && u0 && u0.agreedPrivacy === true)
    if (needTerms && !this.data.agreedTerms) {
      wx.showToast({ title: '请先阅读并勾选同意协议', icon: 'none' })
      return
    }
    if (this.data.canQuickEnter && app.globalData.userInfo && app.globalData.userInfo.agreedPrivacy === true) {
      wx.switchTab({ url: '/pages/index/index' })
      return
    }
    this.setData({ logging: true })
    wx.showLoading({ title: '请稍候', mask: true })
    try {
      const result = await app.updateProfile({ profileCompleted: true })
      if (!result) throw new Error('更新资料失败')
      if (app.globalData.userInfo) {
        app.globalData.userInfo.profileCompleted = true
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ logging: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
      return
    }
    wx.hideLoading()
    this.setData({ logging: false })
    if (app.globalData.userInfo && !app.globalData.userInfo.agreedPrivacy) {
      wx.redirectTo({ url: '/pages/privacy/privacy' })
    } else {
      wx.switchTab({ url: '/pages/index/index' })
    }
  },

  onPrivacyTap() {
    wx.navigateTo({ url: '/pages/privacy/privacy' })
  }
})
