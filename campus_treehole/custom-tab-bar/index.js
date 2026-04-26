Component({
  data: {
    selected: 0,
    hidden: false,
    unreadCount: 0,
    list: [
      { pagePath: "/pages/index/index", text: "首页", icon: "home", iconFill: "home-fill" },
      { pagePath: "/pages/market/market", text: "集市", icon: "market", iconFill: "market-fill" },
      { pagePath: "/pages/post/post", text: "", icon: "plus", iconFill: "plus" },
      { pagePath: "/pages/message/message", text: "消息", icon: "message", iconFill: "message-fill" },
      { pagePath: "/pages/mine/mine", text: "我", icon: "mine", iconFill: "mine-fill" }
    ]
  },
  methods: {
    switchTab(e) {
      if (this.data.hidden) return
      const idx = e.currentTarget.dataset.index
      if (idx === this.data.selected) return
      const item = this.data.list[idx]
      wx.switchTab({ url: item.pagePath })
    }
  }
})
