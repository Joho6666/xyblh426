const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const SCENE_TEMPLATE_ENV = {
  dm: 'TPL_DM',
  comment: 'TPL_COMMENT',
  like: 'TPL_LIKE',
  favorite: 'TPL_FAVORITE',
  share: 'TPL_SHARE',
  announcement: 'TPL_ANNOUNCEMENT',
  offshelf: 'TPL_OFFSHELF'
}

function resolveTemplateId(sceneType) {
  const envKey = SCENE_TEMPLATE_ENV[sceneType]
  if (!envKey) return ''
  return String(process.env[envKey] || '').trim()
}

function trimMsg(text, max = 20) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

/** 订阅消息 name 类字段：空值/纯符号会触发 47003 */
function safeNameValue(text, fallback = '有人') {
  const raw = trimMsg(text, 12) || fallback
  if (/^[\u4e00-\u9fa5a-zA-Z0-9·]{1,12}$/.test(raw)) return raw
  return fallback
}

function formatDateTime(d = new Date()) {
  const pad = (n) => (n < 10 ? `0${n}` : String(n))
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const min = pad(d.getMinutes())
  return `${y}-${m}-${day} ${h}:${min}`
}

function buildTemplateData(sceneType, data, nowText) {
  const actorName = safeNameValue(data.actorName, '有人')
  const summary = trimMsg(data.summary || '你有一条新通知', 20)
  const itemTitle = trimMsg(data.itemTitle || '帖子', 20)
  const reason = trimMsg(data.reason || '内容调整', 20)
  const targetCount = Number(data.targetCount || 1)
  if (sceneType === 'dm') {
    return {
      name1: { value: actorName },
      thing2: { value: summary },
      date3: { value: nowText },
      thing4: { value: '私信消息' },
      thing6: { value: trimMsg(data.remark || '点击查看消息', 20) }
    }
  }
  if (sceneType === 'comment') {
    return {
      thing1: { value: itemTitle },
      name2: { value: actorName },
      time3: { value: nowText },
      thing5: { value: summary }
    }
  }
  if (sceneType === 'like') {
    return {
      name1: { value: actorName },
      date2: { value: nowText },
      thing3: { value: summary },
      thing4: { value: actorName },
      thing5: { value: itemTitle }
    }
  }
  if (sceneType === 'favorite') {
    return {
      thing1: { value: itemTitle },
      thing2: { value: actorName },
      number3: { value: targetCount > 0 ? targetCount : 1 },
      thing4: { value: summary },
      time6: { value: nowText }
    }
  }
  if (sceneType === 'share') {
    return {
      thing1: { value: itemTitle },
      time2: { value: nowText },
      thing3: { value: actorName },
      thing4: { value: summary },
      time5: { value: nowText }
    }
  }
  if (sceneType === 'offshelf') {
    return {
      name1: { value: safeNameValue(itemTitle, '商品') },
      name2: { value: safeNameValue(reason, '内容调整') },
      name3: { value: trimMsg(summary, 20) || '已下架' }
    }
  }
  if (sceneType === 'announcement') {
    return {
      time1: { value: nowText },
      thing3: { value: itemTitle },
      thing4: { value: summary },
      thing5: { value: trimMsg(data.announcementType || '社区公告', 20) }
    }
  }
  return {
    thing1: { value: actorName },
    thing2: { value: summary },
    time3: { value: nowText }
  }
}

async function appendNotifyLog(doc) {
  try {
    await db.collection('notify_logs').add({
      data: {
        ...doc,
        createTime: db.serverDate()
      }
    })
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      await db.createCollection('notify_logs').catch(() => {})
      await db.collection('notify_logs').add({
        data: {
          ...doc,
          createTime: db.serverDate()
        }
      })
      return
    }
    throw err
  }
}

async function isThrottled(toOpenid, sceneType, seconds = 60) {
  const since = new Date(Date.now() - seconds * 1000)
  try {
    const res = await db.collection('notify_logs').where({
      toOpenid,
      sceneType,
      status: 'sent',
      createTime: cloud.database().command.gte(since)
    }).limit(1).get()
    return Array.isArray(res.data) && res.data.length > 0
  } catch (err) {
    return false
  }
}

exports.main = async (event) => {
  const action = event && event.action
  const data = (event && event.data) || {}

  const internalSecret = String(process.env.INTERNAL_NOTIFY_SECRET || '').trim()
  const callerSecret = String((event && event.internalSecret) || '').trim()
  if (!internalSecret || callerSecret !== internalSecret) {
    return { code: -403, msg: '禁止直接调用：notifySender 仅供服务端互调（缺少有效 internalSecret）' }
  }

  if (action !== 'send') {
    return { code: -1, msg: '未知操作' }
  }
  const toOpenid = String(data.toOpenid || '').trim()
  const sceneType = String(data.sceneType || '').trim()
  const actorName = trimMsg(data.actorName || '有人', 12)
  const summary = trimMsg(data.summary || '你有一条新通知', 20)
  const page = String(data.page || '/pages/message/message').trim()
  const nowText = formatDateTime()

  if (!toOpenid || !sceneType) {
    return { code: -1, msg: '参数缺失' }
  }
  const templateId = resolveTemplateId(sceneType)
  if (!templateId) {
    await appendNotifyLog({
      toOpenid,
      sceneType,
      status: 'skip',
      errMsg: '模板ID未配置'
    })
    return { code: 0, msg: '模板未配置，已跳过' }
  }
  if (await isThrottled(toOpenid, sceneType, 60)) {
    await appendNotifyLog({
      toOpenid,
      sceneType,
      status: 'skip',
      errMsg: '限频跳过'
    })
    return { code: 0, msg: '限频跳过' }
  }

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: toOpenid,
      templateId,
      page,
      miniprogramState: 'formal',
      lang: 'zh_CN',
      data: buildTemplateData(sceneType, { ...data, actorName, summary }, nowText)
    })
    await appendNotifyLog({
      toOpenid,
      sceneType,
      status: 'sent'
    })
    return { code: 0, msg: '发送成功' }
  } catch (err) {
    const errCode = err && err.errCode
    const errMsg = (err && err.errMsg) || (err && err.message) || '发送失败'
    await appendNotifyLog({
      toOpenid,
      sceneType,
      status: 'fail',
      errCode,
      errMsg
    })
    if (errCode === 43101) {
      return { code: -1, msg: '用户未授权该订阅消息（需在小程序内重新开启服务通知）' }
    }
    return { code: -1, msg: errMsg }
  }
}
