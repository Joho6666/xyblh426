function coerce(v) {
  if (v == null) return ''
  const s = String(v)
  if (s === 'undefined' || s === 'null' || s === '[object Object]') return ''
  return s
}

Component({
  properties: {
    placeholder: {
      type: String,
      value: '搜索用户昵称、学院或 ID…'
    }
  },
  data: {
    innerValue: ''
  },
  methods: {
    onInput(e) {
      const raw = e && e.detail && e.detail.value != null ? String(e.detail.value) : ''
      const v = coerce(raw)
      if (v !== this.data.innerValue) {
        this.setData({ innerValue: v })
      }
      this.triggerEvent('change', { value: v })
    },
    onConfirm(e) {
      const raw = e && e.detail && e.detail.value != null ? String(e.detail.value) : this.data.innerValue
      const v = coerce(raw)
      if (v !== this.data.innerValue) {
        this.setData({ innerValue: v })
      }
      this.triggerEvent('change', { value: v })
    },
    onClear() {
      if (this.data.innerValue !== '') {
        this.setData({ innerValue: '' })
      }
      this.triggerEvent('change', { value: '' })
    }
  }
})
