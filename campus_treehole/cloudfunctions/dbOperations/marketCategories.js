const MARKET_PRIMARY_CATEGORIES = ['书籍', '手机数码', '生活用品']

const MARKET_LEGACY_CATEGORIES = [
  '电器',
  '美妆',
  '男装',
  '女装',
  '医药',
  '玩乐',
  '车品',
  '技能服务',
  '虚拟产品',
  '餐饮'
]

function getOtherCategoryNames() {
  return [...MARKET_LEGACY_CATEGORIES, '其他']
}

function normalizePublishCategory(category) {
  const name = String(category || '').trim()
  if (!name) return '其他'
  if (MARKET_PRIMARY_CATEGORIES.includes(name) || name === '其他') return name
  return '其他'
}

/** 云数据库 where：按集市分类筛选（「其他」含历史分类） */
function buildMarketCategoryWhere(_, category) {
  const name = String(category || '').trim()
  if (!name) return null
  if (name === '其他') {
    const names = getOtherCategoryNames()
    return _.or(names.map((c) => ({ category: c })))
  }
  return { category: name }
}

module.exports = {
  MARKET_PRIMARY_CATEGORIES,
  MARKET_LEGACY_CATEGORIES,
  getOtherCategoryNames,
  normalizePublishCategory,
  buildMarketCategoryWhere
}
