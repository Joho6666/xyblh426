// 登录云函数 - 获取用户openid并创建/更新用户记录
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function getNumericId(openid) {
  const hash = crypto.createHash('md5').update(String(openid || '')).digest('hex')
  const raw = parseInt(hash.slice(0, 8), 16)
  return String((raw % 90000000) + 10000000)
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    if (!OPENID) {
      return { code: -1, msg: '未授权访问' }
    }
    // 查询用户是否已存在
    const userRes = await db.collection('users').where({ _openid: OPENID }).get()

    if (userRes.data.length > 0) {
      const user = userRes.data[0]

      // 封禁到期自动解封
      if (user.status === 'banned' && user.banExpiry) {
        const now = Date.now()
        const expire = new Date(user.banExpiry).getTime()
        if (!Number.isNaN(expire) && now > expire) {
          await db.collection('users').doc(user._id).update({
            data: { status: 'active', banTime: null, banExpiry: null }
          })
          user.status = 'active'
        }
      }

      // 用户已存在，检查账号状态
      if (user.status === 'deleted') {
        return { code: -3, msg: '该账号已注销，无法继续使用', user: null }
      }
      if (user.status === 'banned') {
        return { code: -2, msg: '账号已被封禁', user: null }
      }

      const nextUser = {
        ...user,
        numericId: user.numericId || getNumericId(OPENID)
      }
      // 更新最后登录时间
      await db.collection('users').doc(user._id).update({
        data: {
          lastLoginTime: db.serverDate(),
          numericId: nextUser.numericId
        }
      })
      return { code: 0, msg: '登录成功', user: nextUser, openid: OPENID }
    } else {
      // 新用户 - 创建用户记录
      const newUser = {
        _openid: OPENID,
        numericId: getNumericId(OPENID),
        nickName: '树洞用户' + Math.floor(Math.random() * 9000 + 1000),
        avatarUrl: '/images/avatar_default.png',
        college: '未设置',
        bio: '',
        tags: [],
        coverImage: '',
        role: 'user',
        status: 'active',
        postCount: 0,
        likeCount: 0,
        createTime: db.serverDate(),
        lastLoginTime: db.serverDate(),
        agreedPrivacy: false,
        profileCompleted: false
      }
      const addRes = await db.collection('users').add({ data: newUser })
      newUser._id = addRes._id
      return { code: 0, msg: '注册成功', user: newUser, openid: OPENID, isNew: true }
    }
  } catch (err) {
    console.error('登录失败:', err)
    return { code: -1, msg: '登录失败: ' + err.message }
  }
}
