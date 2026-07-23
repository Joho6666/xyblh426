/**
 * 管理后台数据分析看板
 * - 实时：每次打开/刷新从云库统计
 * - 历史：写入 analytics_daily_snapshots（每日一条，打开看板时更新当天）
 */
module.exports = function createAnalyticsDashboard(db, _) {
  const POST_CATEGORIES = [
    '树洞', '求助', '找搭子', '校园生活', '学术交流', '失物招领', '社团活动', '校园活动', '其他'
  ]
  const MARKET_CATEGORIES = ['书籍', '手机数码', '生活用品', '其他']
  const SNAPSHOT_COL = 'analytics_daily_snapshots'

  function dayStart(offsetDays = 0) {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays)
  }

  function dayLabel(date) {
    const m = date.getMonth() + 1
    const day = date.getDate()
    return `${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`
  }

  function dateKey(d = new Date()) {
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const day = d.getDate()
    return `${y}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`
  }

  function clampTrendDays(raw) {
    const n = Number(raw) || 7
    return Math.min(30, Math.max(7, Math.floor(n)))
  }

  async function safeCount(run, fallback = 0) {
    try {
      const res = await run()
      return (res && res.total) || 0
    } catch (e) {
      return fallback
    }
  }

  async function countUsersSince(since) {
    return safeCount(() =>
      db.collection('users').where({ status: 'active', lastLoginTime: _.gte(since) }).count()
    )
  }

  async function countLoginsBetween(start, end) {
    const parts = [{ status: 'active', lastLoginTime: _.gte(start) }]
    if (end) parts.push({ lastLoginTime: _.lt(end) })
    const cond = parts.length === 1 ? parts[0] : _.and(parts)
    return safeCount(() => db.collection('users').where(cond).count())
  }

  async function countUsersWithPosts() {
    try {
      const res = await db
        .collection('posts')
        .where({ status: 'active' })
        .field({ _openid: true })
        .limit(500)
        .get()
      return new Set((res.data || []).map((p) => p._openid).filter(Boolean)).size
    } catch (e) {
      return 0
    }
  }

  async function countNewUsersBetween(start, end) {
    const parts = [{ status: 'active', createTime: _.gte(start) }]
    if (end) parts.push({ createTime: _.lt(end) })
    const cond = parts.length === 1 ? parts[0] : _.and(parts)
    return safeCount(() => db.collection('users').where(cond).count())
  }

  async function countNewPostsBetween(start, end) {
    const parts = [{ status: 'active', createTime: _.gte(start) }]
    if (end) parts.push({ createTime: _.lt(end) })
    const cond = parts.length === 1 ? parts[0] : _.and(parts)
    return safeCount(() => db.collection('posts').where(cond).count())
  }

  async function aggregateField(collection, field, where = {}, limit = 1200) {
    const map = {}
    try {
      const res = await db.collection(collection).where(where).limit(limit).get()
      ;(res.data || []).forEach((row) => {
        const key = String((row && row[field]) || '未分类').trim() || '未分类'
        map[key] = (map[key] || 0) + 1
      })
    } catch (e) {
      return []
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }))
  }

  async function buildTrends(trendDays) {
    const dayTasks = []
    for (let i = trendDays - 1; i >= 0; i--) {
      const start = dayStart(i)
      const end = i === 0 ? null : dayStart(i - 1)
      dayTasks.push({ label: dayLabel(start), date: dateKey(start), start, end })
    }
    const counts = await Promise.all(
      dayTasks.flatMap((d) => [
        countNewUsersBetween(d.start, d.end),
        countNewPostsBetween(d.start, d.end),
        countLoginsBetween(d.start, d.end)
      ])
    )
    const trends = { labels: [], dates: [], newUsers: [], newPosts: [], logins: [] }
    let ti = 0
    dayTasks.forEach((d) => {
      trends.labels.push(d.label)
      trends.dates.push(d.date)
      trends.newUsers.push(counts[ti++])
      trends.newPosts.push(counts[ti++])
      trends.logins.push(counts[ti++])
    })
    return trends
  }

  async function buildUserPersona() {
    const week0 = dayStart(6)
    const month0 = dayStart(29)
    let users = []
    try {
      const res = await db.collection('users').where({ status: 'active' }).limit(1500).get()
      users = res.data || []
    } catch (e) {
      return { sampleSize: 0, activitySegments: [], profileSegments: [], acquisition: [], collegeTop: [] }
    }

    let active7d = 0
    let active30d = 0
    let profileComplete = 0
    let inviteBound = 0
    let defaultNick = 0
    const collegeMap = {}

    users.forEach((u) => {
      const login = u.lastLoginTime ? new Date(u.lastLoginTime) : null
      if (login && login >= week0) active7d++
      if (login && login >= month0) active30d++
      if (u.profileCompleted === true) profileComplete++
      if (u.inviteEmpId && String(u.inviteEmpId).trim()) inviteBound++
      if (/^树洞用户\d+$/.test(String(u.nickName || u.nickname || ''))) defaultNick++
      const col = String(u.college || '未设置').trim() || '未设置'
      collegeMap[col] = (collegeMap[col] || 0) + 1
    })

    const silent = Math.max(0, users.length - active30d)
    return {
      sampleSize: users.length,
      activitySegments: [
        { name: '7日内活跃', count: active7d },
        { name: '30日内活跃', count: active30d },
        { name: '沉默(>30天未登录)', count: silent }
      ],
      profileSegments: [
        { name: '资料已完善', count: profileComplete },
        { name: '资料未完成', count: Math.max(0, users.length - profileComplete) }
      ],
      acquisition: [
        { name: '员工推广绑定', count: inviteBound },
        { name: '自然注册/其他', count: Math.max(0, users.length - inviteBound) }
      ],
      nicknameSegments: [
        { name: '仍用默认昵称', count: defaultNick },
        { name: '已改昵称', count: Math.max(0, users.length - defaultNick) }
      ],
      collegeTop: Object.entries(collegeMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }))
    }
  }

  async function saveDailySnapshot(overview, activity, trends, funnel) {
    const date = dateKey()
    const last = trends.labels.length - 1
    const row = {
      date,
      overview,
      activity,
      funnel: {
        totalUsers: funnel.totalUsers,
        profileCompleteRate: funnel.profileCompleteRate,
        postUserRate: funnel.postUserRate
      },
      dayMetrics: {
        newUsers: trends.newUsers[last] || 0,
        newPosts: trends.newPosts[last] || 0,
        logins: trends.logins[last] || 0
      },
      savedAt: db.serverDate()
    }
    try {
      const existing = await db.collection(SNAPSHOT_COL).where({ date }).limit(1).get()
      if (existing.data && existing.data.length) {
        await db.collection(SNAPSHOT_COL).doc(existing.data[0]._id).update({ data: row })
      } else {
        await db.collection(SNAPSHOT_COL).add({ data: row })
      }
      return true
    } catch (e) {
      console.warn('[analytics] saveDailySnapshot', e)
      return false
    }
  }

  async function getAnalyticsHistory(options = {}) {
    const days = Math.min(90, Math.max(7, Number(options.days) || 30))
    try {
      const res = await db
        .collection(SNAPSHOT_COL)
        .orderBy('date', 'desc')
        .limit(days)
        .get()
      const rows = (res.data || []).slice().reverse()
      return {
        code: 0,
        data: {
          days: rows.length,
          rows,
          note:
            rows.length === 0
              ? '暂无历史快照：请打开数据看板一次，系统会自动记录当日数据；之后每天刷新看板即可累积。'
              : '历史来自每日快照；当天数据以实时统计为准。'
        }
      }
    } catch (e) {
      return {
        code: 0,
        data: {
          days: 0,
          rows: [],
          note: '历史集合尚未创建，打开看板后将自动开始记录。'
        }
      }
    }
  }

  async function getAnalyticsDashboard(options = {}) {
    const trendDays = clampTrendDays(options.trendDays)
    const saveSnapshot = options.saveSnapshot !== false
    const today0 = dayStart(0)
    const week0 = dayStart(6)
    const month0 = dayStart(29)

    const [
      totalPosts,
      todayPosts,
      pendingPosts,
      totalUsers,
      todayUsers,
      pendingReports,
      totalComments,
      marketComments,
      profileIncomplete,
      privacyNotAgreed,
      usersWithPosts,
      totalLikes,
      totalFollows,
      totalMessages,
      marketGoods,
      marketFavors,
      peerReferrals,
      userBlocks,
      loginToday,
      login7d,
      login30d,
      trends,
      campusDistribution,
      postCategoryRows,
      marketCategoryRows,
      userPersona
    ] = await Promise.all([
      safeCount(() => db.collection('posts').where({ status: 'active' }).count()),
      safeCount(() =>
        db.collection('posts').where({ status: 'active', createTime: _.gte(today0) }).count()
      ),
      safeCount(() => db.collection('posts').where({ status: 'pending' }).count()),
      safeCount(() => db.collection('users').where({ status: 'active' }).count()),
      safeCount(() =>
        db.collection('users').where({ status: 'active', createTime: _.gte(today0) }).count()
      ),
      safeCount(() => db.collection('reports').where({ status: 'pending' }).count()),
      safeCount(() => db.collection('comments').where({ status: 'active' }).count()),
      safeCount(() => db.collection('market_comments').where({ status: 'active' }).count()),
      safeCount(() =>
        db.collection('users').where({ status: 'active', profileCompleted: false }).count()
      ),
      safeCount(() =>
        db.collection('users').where({ status: 'active', agreedPrivacy: false }).count()
      ),
      countUsersWithPosts(),
      safeCount(() => db.collection('likes').count()),
      safeCount(() => db.collection('follows').count()),
      safeCount(() => db.collection('messages').count()),
      safeCount(() => db.collection('market_goods').where({ status: 'active' }).count()),
      safeCount(() => db.collection('market_favors').count()),
      safeCount(() => db.collection('peer_referrals').count()),
      safeCount(() => db.collection('user_blocks').count()),
      countUsersSince(today0),
      countUsersSince(week0),
      countUsersSince(month0),
      buildTrends(trendDays),
      aggregateField('users', 'campusName', { status: 'active' }, 1500),
      aggregateField('posts', 'category', { status: 'active' }, 500),
      aggregateField('market_goods', 'category', { status: 'active' }, 300),
      buildUserPersona()
    ])

    const postCategories = POST_CATEGORIES.map((name) => {
      const row = postCategoryRows.find((r) => r.name === name)
      return { name, count: row ? row.count : 0 }
    })
    postCategoryRows.forEach((r) => {
      if (!POST_CATEGORIES.includes(r.name)) postCategories.push(r)
    })

    const marketCategories = MARKET_CATEGORIES.map((name) => {
      const row = marketCategoryRows.find((r) => r.name === name)
      return { name, count: row ? row.count : 0 }
    })
    marketCategoryRows.forEach((r) => {
      if (!MARKET_CATEGORIES.includes(r.name)) marketCategories.push(r)
    })

    const profileComplete = Math.max(0, totalUsers - profileIncomplete)
    const postRate = totalUsers > 0 ? Math.round((usersWithPosts / totalUsers) * 1000) / 10 : 0
    const profileRate = totalUsers > 0 ? Math.round((profileComplete / totalUsers) * 1000) / 10 : 0

    const overview = {
      totalPosts,
      todayPosts,
      pendingPosts,
      totalUsers,
      todayUsers,
      pendingReports,
      totalComments: totalComments + marketComments,
      postComments: totalComments,
      marketComments,
      totalLikes,
      totalFollows,
      totalMessages,
      marketGoods,
      marketFavors,
      peerReferrals,
      userBlocks
    }
    const activity = { loginToday, login7d, login30d }
    const funnel = {
      totalUsers,
      profileComplete,
      profileIncomplete,
      privacyNotAgreed,
      usersWithPosts,
      profileCompleteRate: profileRate,
      postUserRate: postRate
    }

    if (saveSnapshot) {
      await saveDailySnapshot(overview, activity, trends, funnel)
    }

    const insights = []
    insights.push(
      `数据为实时统计（刷新/自动刷新时重新计算），非微信官方 DAU；历史日表来自每日快照。`
    )
    if (profileRate < 60) {
      insights.push(`约 ${100 - profileRate}% 用户未完成资料，可加强新用户引导。`)
    }
    if (postRate < 10) {
      insights.push(`仅约 ${postRate}% 用户发过帖，内容生产依赖少数活跃用户。`)
    }
    if (login7d > 0 && totalUsers > 0 && login7d / totalUsers < 0.15) {
      insights.push(`7 日登录约占 ${Math.round((login7d / totalUsers) * 100)}%，可配合订阅消息促活。`)
    }
    if (pendingReports > 0) insights.push(`有 ${pendingReports} 条举报待处理。`)
    if (pendingPosts > 0) insights.push(`有 ${pendingPosts} 条视频帖待审核。`)

    return {
      code: 0,
      data: {
        generatedAt: new Date().toISOString(),
        trendDays,
        refreshHint: '打开看板或点击刷新即可获取最新数据；开启自动刷新后每 60 秒更新一次。',
        overview,
        activity,
        funnel,
        trends,
        userPersona,
        campusDistribution: campusDistribution.slice(0, 8),
        postCategories,
        marketCategories,
        insights
      }
    }
  }

  return {
    getAnalyticsDashboard,
    getAnalyticsHistory
  }
}
