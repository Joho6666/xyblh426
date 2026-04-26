const app = getApp()

Page({
  data: {
    list: [],
    loading: false,
    generatingEmpId: ''
  },

  onShow() {
    if (!app.globalData.isLoggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    const u = app.globalData.userInfo
    if (!u || u.role !== 'admin') {
      wx.showModal({
        title: '无权限',
        content: '仅管理员可查看此页。请在云数据库 users 中将你的账号 role 设为 admin。',
        showCancel: false,
        success: () => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) })
      })
      return
    }
    this.loadStats()
  },

  async loadStats() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminPanel',
        data: { action: 'getEmployeeReferralStats', data: {} }
      })
      const r = (res && res.result) || {}
      if (r.code === -403) {
        wx.showToast({ title: '无管理员权限', icon: 'none' })
        this.setData({ list: [], loading: false })
        return
      }
      if (r.code !== 0) {
        wx.showToast({ title: r.msg || '加载失败', icon: 'none' })
        this.setData({ list: [], loading: false })
        return
      }
      const list = r.data || []
      const fileIds = list
        .map((i) => i.qrcodeUrl)
        .filter((u) => u && String(u).startsWith('cloud://'))
      let urlMap = {}
      if (fileIds.length && app.globalData.cloudReady) {
        const tmp = await app.getTempFileUrls(fileIds)
        ;(tmp || []).forEach((t) => {
          const fid = t.fileID || t.FileID
          const url = t.tempFileURL || t.TempFileURL
          if (fid && url) urlMap[fid] = url
        })
      }
      const enriched = list.map((item) => ({
        ...item,
        qrcodeDisplayUrl:
          item.qrcodeUrl && urlMap[item.qrcodeUrl]
            ? urlMap[item.qrcodeUrl]
            : item.qrcodeUrl && !String(item.qrcodeUrl).startsWith('cloud://')
              ? item.qrcodeUrl
              : ''
      }))
      this.setData({ list: enriched, loading: false })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false })
      wx.showToast({ title: '请求失败', icon: 'none' })
    }
  },

  async onGenerateQr(e) {
    const empId = e.currentTarget.dataset.empid
    if (!empId || this.data.generatingEmpId) return
    this.setData({ generatingEmpId: empId })
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminPanel',
        data: { action: 'generateEmployeeQrcode', data: { empId } }
      })
      const r = (res && res.result) || {}
      if (r.code !== 0) {
        wx.showToast({ title: r.msg || '生成失败', icon: 'none', duration: 3000 })
        return
      }
      wx.showToast({ title: '已生成', icon: 'success' })
      await this.loadStats()
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '调用失败', icon: 'none' })
    } finally {
      this.setData({ generatingEmpId: '' })
    }
  }
})
