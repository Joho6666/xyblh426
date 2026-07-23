/** 集市商品分类：浏览 Tab 与发布选项 */

const MARKET_PRIMARY_CATEGORIES = ['书籍', '手机数码', '生活用品']

/** 已下线分类，浏览「其他」时一并展示 */
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

const MARKET_PUBLISH_CATEGORIES = [
  { name: '书籍', icon: '📚' },
  { name: '手机数码', icon: '📱' },
  { name: '生活用品', icon: '🧴' },
  { name: '其他', icon: '📦' }
]

const MARKET_BROWSE_CATEGORIES = [
  { name: '全部', icon: '🛍️' },
  ...MARKET_PUBLISH_CATEGORIES
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

module.exports = {
  MARKET_PRIMARY_CATEGORIES,
  MARKET_LEGACY_CATEGORIES,
  MARKET_PUBLISH_CATEGORIES,
  MARKET_BROWSE_CATEGORIES,
  getOtherCategoryNames,
  normalizePublishCategory
}
