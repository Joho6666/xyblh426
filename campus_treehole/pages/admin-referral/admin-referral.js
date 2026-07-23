const app = getApp()

Page({
  data: {
    list: [],
    loading: false,
    generatingEmpId: '',
    statusLabels: ['启用', '停用'],
    formVisible: false,
    isNewForm: false,
    formEmpId: '',
    formName: '',
    formInviteCode: '',
    formStatusIndex: 0,
    saving: false
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

  onTapAdd() {
    this.setData({
      formVisible: true,
      isNewForm: true,
      formEmpId: '',
      formName: '',
      formInviteCode: '',
      formStatusIndex: 0
    })
  },

  onTapEdit(e) {
    const empId = e.currentTarget.dataset.empid
    if (!empId) return
    const row = (this.data.list || []).find((x) => x.empId === empId)
    if (!row) return
    this.setData({
      formVisible: true,
      isNewForm: false,
      formEmpId: row.empId || '',
      formName: row.name || '',
      formInviteCode: row.inviteCode || '',
      formStatusIndex: row.status === 'disabled' ? 1 : 0
    })
  },

  onCancelForm() {
    if (this.data.saving) return
    this.setData({ formVisible: false })
  },

  onFormEmpId(e) {
    this.setData({ formEmpId: (e.detail && e.detail.value) || '' })
  },

  onFormName(e) {
    this.setData({ formName: (e.detail && e.detail.value) || '' })
  },

  onFormInviteCode(e) {
    this.setData({ formInviteCode: (e.detail && e.detail.value) || '' })
  },

  onStatusPick(e) {
    const v = parseInt(e.detail.value, 10)
    this.setData({ formStatusIndex: v === 1 ? 1 : 0 })
  },

  async onSaveEmployee() {
    if (this.data.saving) return
    const { isNewForm, formEmpId, formName, formInviteCode, formStatusIndex } = this.data
    const empId = String(formEmpId || '').trim()
    const name = String(formName || '').trim()
    const inviteCode = String(formInviteCode || '').trim()
    const status = formStatusIndex === 1 ? 'disabled' : 'enabled'

    if (!empId) {
      wx.showToast({ title: '请填写员工编号', icon: 'none' })
      return
    }
    if (!name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminPanel',
        data: {
          action: 'saveEmployee',
          data: {
            isNew: isNewForm,
            empId,
            name,
            inviteCode,
            status
          }
        }
      })
      const r = (res && res.result) || {}
      if (r.code !== 0) {
        wx.showToast({ title: r.msg || '保存失败', icon: 'none', duration: 2800 })
        return
      }
      wx.showToast({ title: r.msg || '已保存', icon: 'success' })
      this.setData({ formVisible: false })
      await this.loadStats()
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '调用失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
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
