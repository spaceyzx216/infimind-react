import { PAYMENT_MONTH_TABLE } from './pension-rules.js'

const CATEGORIES = Object.freeze({
  male: { baseAge: 60, start: '1965-01', step: 4, cap: 36 },
  female55: { baseAge: 55, start: '1970-01', step: 4, cap: 36 },
  female50: { baseAge: 50, start: '1975-01', step: 2, cap: 60 }
})

export function monthIndex(value) {
  if (typeof value !== 'string' || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new RangeError('请使用有效的YYYY-MM年月（1900—2199）。')
  }
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1
}

export function formatMonth(index) {
  if (!Number.isInteger(index)) throw new RangeError('年月索引必须是整数。')
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`
}

export function getStatutoryRetirement(birthMonth, category) {
  const rule = CATEGORIES[category]
  if (!rule) throw new RangeError('请核对原法定退休类别，不能按参保身份推断。')
  const birth = monthIndex(birthMonth)
  const cohortMonths = birth - monthIndex(rule.start) + 1
  const delayMonths = Math.max(0, Math.min(rule.cap, Math.ceil(cohortMonths / rule.step)))
  const ageMonths = rule.baseAge * 12 + delayMonths
  const statutory = birth + ageMonths
  // Elastic retirement is not applied to cohorts already at the old statutory age before 2025.
  const elastic = birth + rule.baseAge * 12 >= monthIndex('2025-01')
  return {
    month: formatMonth(statutory), index: statutory, ageMonths, delayMonths, baseAge: rule.baseAge,
    elastic, earliestMonth: formatMonth(elastic ? Math.max(birth + rule.baseAge * 12, statutory - 36) : statutory),
    latestMonth: formatMonth(elastic ? statutory + 36 : statutory)
  }
}

export function getMinimumContributionMonths(year) {
  if (!Number.isInteger(year) || year < 2025 || year > 2199) throw new RangeError('最低年限适用年份须为2025—2199。')
  return Math.min(240, 180 + Math.max(0, year - 2029) * 6)
}

export function getTablePaymentMonths(ageMonths) {
  return Number.isInteger(ageMonths) && ageMonths % 12 === 0
    ? PAYMENT_MONTH_TABLE[ageMonths / 12] ?? null : null
}

export function resolveRetirement(birthMonth, category, mode, selectedMonth) {
  const statutory = getStatutoryRetirement(birthMonth, category)
  if (!['statutory', 'early', 'late'].includes(mode)) throw new RangeError('请选择退休方式。')
  const selected = mode === 'statutory' ? statutory.index : monthIndex(selectedMonth)
  if (mode !== 'statutory' && !statutory.elastic) throw new RangeError('2025年前已达到原法定退休年龄，本页不适用弹性退休规则。')
  if (mode === 'early' && (selected < monthIndex(statutory.earliestMonth) || selected >= statutory.index)) {
    throw new RangeError(`弹性提前退休须在${statutory.earliestMonth}至法定退休年月之前。`)
  }
  if (mode === 'late' && (selected <= statutory.index || selected > monthIndex(statutory.latestMonth))) {
    throw new RangeError(`弹性延迟退休须在法定退休年月之后至${statutory.latestMonth}之间。`)
  }
  const thresholdYear = Math.floor((mode === 'late' ? statutory.index : selected) / 12)
  if (thresholdYear < 2025) throw new RangeError('本页待遇测算适用于2025年及以后退休，历史待遇请按当年规则核对。')
  return {
    mode, statutoryMonth: statutory.month, selectedMonth: formatMonth(selected), selectedIndex: selected,
    earliestMonth: statutory.earliestMonth, latestMonth: statutory.latestMonth,
    ageMonths: selected - monthIndex(birthMonth), thresholdYear,
    minimumMonths: getMinimumContributionMonths(thresholdYear)
  }
}
