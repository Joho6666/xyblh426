// pages/privacy/privacy.js - 用户协议与隐私政策页面
const app = getApp()

Page({
  data: {
    agreed: false
  },

  onAgreeChange(e) {
    this.setData({ agreed: e.detail.value.length > 0 })
  },

  async onConfirm() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意协议', icon: 'none' })
      return
    }
    wx.showLoading({ title: '处理中...' })
    const success = await app.agreePrivacy()
    wx.hideLoading()
    if (success) {
      wx.showToast({ title: '欢迎使用校园便利盒', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' })
      }, 1200)
    }
  },

  onDecline() {
    wx.showModal({
      title: '提示',
      content: '不同意协议将无法使用校园便利盒，确定退出吗？',
      confirmColor: '#426089',
      success: (res) => {
        if (res.confirm) {
          wx.exitMiniProgram()
        }
      }
    })
  }
})
