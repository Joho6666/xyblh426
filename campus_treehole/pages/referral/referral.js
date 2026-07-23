const app = getApp()

Page({
  data: {
    loading: true,
    inviteCount: 0,
    referralScanCount: 0,
    numericId: '',
    sharePath: '',
    qrcodeDisplayUrl: '',
    generating: false
  },

  onShow() {
    if (!app.globalData.isLoggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    this._syncSharePath()
    this.loadStats()
  },

  _syncSharePath() {
    const u = app.globalData.userInfo
    const nid = u && u.numericId ? String(u.numericId).trim() : ''
    const sharePath = nid ? `/pages/index/index?ref=u_${nid}` : ''
    this.setData({ sharePath, numericId: nid })
  },

  async loadStats() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'userReferral',
        data: { action: 'getStats' }
      })
      const r = (res && res.result) || {}
      if (r.code !== 0) {
        wx.showToast({ title: r.msg || '加载失败', icon: 'none' })
        this.setData({ loading: false })
        return
      }
      const d = r.data || {}
      let qrcodeDisplayUrl = ''
      const fid = d.peerReferralQrcodeUrl
      if (fid && String(fid).startsWith('cloud://') && app.globalData.cloudReady) {
        const tmp = await app.getTempFileUrls([fid])
        ;(tmp || []).forEach((t) => {
          const id = t.fileID || t.FileID
          const url = t.tempFileURL || t.TempFileURL
          if (id === fid && url) qrcodeDisplayUrl = url
        })
      } else if (fid && !String(fid).startsWith('cloud://')) {
        qrcodeDisplayUrl = String(fid)
      }
      this.setData({
        loading: false,
        inviteCount: d.inviteCount || 0,
        referralScanCount: d.referralScanCount || 0,
        numericId: d.numericId || this.data.numericId,
        qrcodeDisplayUrl
      })
      this._syncSharePath()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false })
      wx.showToast({ title: '请求失败', icon: 'none' })
    }
  },

  async onGenerateQr() {
    if (this.data.generating) return
    this.setData({ generating: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'userReferral',
        data: { action: 'generateQrcode' }
      })
      const r = (res && res.result) || {}
      if (r.code !== 0) {
        wx.showToast({ title: r.msg || '生成失败', icon: 'none', duration: 3000 })
        return
      }
      wx.showToast({ title: '已生成', icon: 'success' })
      if (app.globalData.userInfo && r.data && r.data.peerReferralQrcodeUrl) {
        app.globalData.userInfo.peerReferralQrcodeUrl = r.data.peerReferralQrcodeUrl
      }
      await this.loadStats()
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '调用失败', icon: 'none' })
    } finally {
      this.setData({ generating: false })
    }
  },

  onShareAppMessage() {
    const nid = this.data.numericId || (app.globalData.userInfo && app.globalData.userInfo.numericId) || ''
    return {
      title: '一起来用校园便利盒',
      path: nid ? `/pages/index/index?ref=u_${nid}` : '/pages/index/index',
      imageUrl: '/images/icon_share.png'
    }
  },

  onShareTimeline() {
    const nid = this.data.numericId || (app.globalData.userInfo && app.globalData.userInfo.numericId) || ''
    return {
      title: '校园便利盒',
      query: nid ? `ref=u_${nid}` : '',
      imageUrl: '/images/icon_share.png'
    }
  }
})
