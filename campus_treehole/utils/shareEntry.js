/** 解析分享落地页参数（好友分享 path、朋友圈 query / scene） */

function decodeParam(value) {
  if (value === undefined || value === null || value === '') return ''
  let raw = String(value)
  if (raw === 'undefined' || raw === 'null') return ''
  try {
    raw = decodeURIComponent(raw)
    if (/%[0-9A-Fa-f]{2}/.test(raw)) {
      raw = decodeURIComponent(raw)
    }
  } catch (e) {
    raw = String(value)
  }
  return raw.trim()
}

function parseIdFromScene(sceneRaw) {
  const scene = decodeParam(sceneRaw)
  if (!scene) return ''
  if (scene.includes('id=')) {
    const match = scene.match(/(?:^|[?&])id=([^&]+)/)
    if (match && match[1]) return decodeParam(match[1])
  }
  if (/^[a-f\d]{24}$/i.test(scene)) return scene
  return ''
}

function resolveShareIdFromPageOptions(options, extraKeys = []) {
  if (!options || typeof options !== 'object') return ''
  const keys = ['id', 'postId', 'goodsId', ...extraKeys]
  let id = ''
  for (let i = 0; i < keys.length; i++) {
    if (options[keys[i]]) {
      id = decodeParam(options[keys[i]])
      if (id) break
    }
  }
  if (!id) id = parseIdFromScene(options.scene)
  if (!id && typeof wx !== 'undefined' && typeof wx.getEnterOptionsSync === 'function') {
    try {
      const enter = wx.getEnterOptionsSync() || {}
      const q = enter.query && typeof enter.query === 'object' ? enter.query : {}
      for (let i = 0; i < keys.length; i++) {
        if (q[keys[i]]) {
          id = decodeParam(q[keys[i]])
          if (id) break
        }
      }
      if (!id) id = parseIdFromScene(enter.scene)
    } catch (e) {}
  }
  return id
}

function resolvePostIdFromPageOptions(options) {
  return resolveShareIdFromPageOptions(options)
}

function resolveGoodsIdFromPageOptions(options) {
  return resolveShareIdFromPageOptions(options, ['goodsId'])
}

function isTimelineSinglePageScene(scene) {
  const n = Number(scene)
  return n === 1154 || n === 1155
}

module.exports = {
  decodeParam,
  resolveShareIdFromPageOptions,
  resolvePostIdFromPageOptions,
  resolveGoodsIdFromPageOptions,
  isTimelineSinglePageScene
}
