/**
 * 校区目录：稳定 id + 展示名 + 搜索关键词（名称子串、简称、英文 id）
 * 与云函数 dbOperations 中 DEFAULT_CAMPUS_ID 保持一致
 */
const DEFAULT_CAMPUS_ID = 'guit-hangtian'

const CAMPUSES = [
  {
    id: DEFAULT_CAMPUS_ID,
    name: '桂林航天工业学院',
    keywords: ['桂航', '桂林航天工业学院', '航天', 'guit', 'hangtian']
  },
  {
    id: 'gxnu-yanshan',
    name: '广西师范大学雁山校区',
    keywords: ['广西师范大学雁山', '广西师大雁山', '师大雁山', 'gxnu', '雁山校区']
  },
  {
    id: 'gxnu-yucai',
    name: '广西师范大学育才校区',
    keywords: ['广西师范大学育才', '师大育才', '育才校区', 'gxnu']
  },
  {
    id: 'guet-jjl',
    name: '桂林电子科技大学金鸡岭校区',
    keywords: ['桂电金鸡岭', '桂林电子科技大学金鸡岭', '金鸡岭', 'guet', '电科']
  },
  {
    id: 'guet-huajiang',
    name: '桂林电子科技大学花江校区',
    keywords: ['桂电花江', '桂林电子科技大学花江', '花江校区', 'guet']
  },
  {
    id: 'glut-yanshan',
    name: '桂林理工大学雁山校区',
    keywords: ['桂工雁山', '桂林理工大学雁山', '理工雁山', 'glut']
  },
  {
    id: 'glut-pingfeng',
    name: '桂林理工大学屏风校区',
    keywords: ['桂工屏风', '桂林理工大学屏风', '屏风校区', 'glut']
  },
  {
    id: 'gxmu',
    name: '广西医科大学',
    keywords: ['广西医科大', '医科大', 'gxmu', '医科大学']
  },
  {
    id: 'gltu',
    name: '桂林旅游学院',
    keywords: ['桂旅', '桂林旅游学院', 'gltu', '旅游学院']
  },
  {
    id: 'guilin-college',
    name: '桂林学院',
    keywords: ['桂林学院', '桂院', 'guilincollege', 'guilin-college']
  },
  {
    id: 'glnc',
    name: '桂林师范学院',
    keywords: ['桂林师院', '桂林师范学院', 'glnc', '师范']
  },
  {
    id: 'gist',
    name: '桂林信息科技学院',
    keywords: ['信科', '桂林信息科技学院', 'gist', '信息科技']
  },
  {
    id: 'nnlgxy',
    name: '南宁理工学院',
    keywords: ['南宁理工', '南宁理工学院', 'nnlgxy']
  },
  
]

function normalize(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

/** 字符依次出现在字符串中（支持「桂林航」搜「桂林航天工业学院」等简写） */
function charSubsequenceMatch(haystack, needle) {
  if (!needle) return true
  let from = 0
  for (let i = 0; i < needle.length; i++) {
    const ch = needle[i]
    const j = haystack.indexOf(ch, from)
    if (j === -1) return false
    from = j + 1
  }
  return true
}

function getCampusById(id) {
  if (!id) return null
  return CAMPUSES.find((c) => c.id === id) || null
}

function campusMatchesToken(c, tok) {
  if (!tok) return true
  const nameN = normalize(c.name)
  if (nameN.indexOf(tok) !== -1 || tok.indexOf(nameN) !== -1) return true
  if (charSubsequenceMatch(nameN, tok)) return true
  return (c.keywords || []).some((kw) => {
    const kn = normalize(kw)
    if (!kn) return false
    return (
      nameN.indexOf(kn) !== -1 ||
      kn.indexOf(tok) !== -1 ||
      tok.indexOf(kn) !== -1 ||
      charSubsequenceMatch(kn, tok)
    )
  })
}

/** 按关键词过滤校区：支持空格多词 AND、子串、简写顺序匹配、关键词表 */
function filterCampusesByQuery(query) {
  const raw = String(query || '').trim()
  if (!raw) return CAMPUSES.slice()
  const tokens = raw
    .split(/\s+/)
    .map((t) => normalize(t))
    .filter(Boolean)
  if (!tokens.length) return CAMPUSES.slice()
  return CAMPUSES.filter((c) => tokens.every((tok) => campusMatchesToken(c, tok)))
}

module.exports = {
  DEFAULT_CAMPUS_ID,
  CAMPUSES,
  getCampusById,
  filterCampusesByQuery
}
