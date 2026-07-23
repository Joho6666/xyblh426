/**
 * 活动专区期次：进行中帖子带 inActivityZone + activityRoundId；
 * 结束本期后转为普通帖（默认「校园生活」），并清空横幅配置。
 */
'use strict'

const DEFAULT_CAMPUS_ID = 'default'

function normalizeCampusIds(raw) {
  const list = Array.isArray(raw) ? raw : []
  const ids = Array.from(new Set(list.map((x) => String(x || '').trim()).filter(Boolean)))
  return ids.length ? ids : ['all']
}

function announcementTargetsCampus(item, campusId) {
  const target = String(campusId || DEFAULT_CAMPUS_ID).trim() || DEFAULT_CAMPUS_ID
  const ids = Array.isArray(item && item.campusIds)
    ? item.campusIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [String((item && item.campusIds) || '').trim()].filter(Boolean)
  if (!ids.length) return true
  return ids.includes('all') || ids.includes(target)
}

function parseActivityEndAt(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw
  const s = String(raw).trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function isActivityZoneRunning(doc) {
  if (!doc || !doc.enabled) return false
  const endAt = parseActivityEndAt(doc.endAt)
  if (endAt && endAt.getTime() <= Date.now()) return false
  return true
}

function buildCampusScopeWhere(campusIds, _) {
  const ids = normalizeCampusIds(campusIds)
  if (ids.includes('all')) return null
  return { campusId: _.in(ids) }
}

/** 本期待归档的活动帖查询条件（需配合 db.command） */
function buildFinalizePostWhere(campusIds, roundId, _) {
  const parts = [
    { status: 'active' },
    { category: '校园活动' }
  ]
  const rid = String(roundId || '')
  if (rid) {
    parts.push(_.or([{ inActivityZone: true }, { activityRoundId: rid }]))
  } else {
    parts.push({ inActivityZone: true })
  }
  const campusPart = buildCampusScopeWhere(campusIds, _)
  if (campusPart) parts.push(campusPart)
  return parts.length === 1 ? parts[0] : _.and(parts)
}

function adminDataFromDoc(doc) {
  if (!doc) {
    return {
      enabled: false,
      campusIds: [],
      slides: [],
      roundId: '',
      endAt: null,
      lastEndedAt: null,
      activityRunning: false
    }
  }
  const endAt = doc.endAt || null
  return {
    enabled: !!doc.enabled,
    campusIds: Array.isArray(doc.campusIds) ? doc.campusIds : [],
    slides: Array.isArray(doc.slides) ? doc.slides : [],
    roundId: String(doc.roundId || ''),
    endAt: endAt ? (endAt instanceof Date ? endAt.toISOString() : String(endAt)) : null,
    lastEndedAt: doc.lastEndedAt || null,
    activityRunning: isActivityZoneRunning(doc)
  }
}

module.exports = {
  DEFAULT_CAMPUS_ID,
  normalizeCampusIds,
  announcementTargetsCampus,
  parseActivityEndAt,
  isActivityZoneRunning,
  buildFinalizePostWhere,
  adminDataFromDoc
}
