// Medical-period-only pure calculation. No clock, network, storage or model calls.
// Legal uncertainties are explicit result fields, never silently chosen algorithms.
const ALGORITHM_VERSION = 'medical-period-2026-10-10.2'
const VERIFIED_ON = '2026-10-09'
const SH_MONTH_WORKDAYS = 20.67
const SH_CONVERSION_VERIFIED_FROM = '2025-10-28'
const REGION_LABELS = { shanghai: '上海', national: '全国（非上海）', other: '其他或适用地区暂不明确' }
const NATIONAL_SOURCES = [
  { title: '劳部发〔1994〕479号 · 第三、四条', url: 'https://hrss.sz.gov.cn/xxgk/zcfgjjd/zcfg/shbx/content/post_2017414.html' },
  { title: '劳部发〔1995〕236号 · 病休累计与特殊疾病', url: 'https://hrss.zs.gov.cn/zcfg/ldgx/content/post_1192213.html' }
]
const SH_SOURCES = [
  { title: '沪府发〔2015〕40号 · 医疗期标准', url: 'https://www.shanghai.gov.cn/nw38936/20200821/0001-38936_44821.html' },
  { title: '沪府〔2025〕20号 · 有效期延长至2030年6月30日', url: 'https://www.shanghai.gov.cn/nw12344/20250321/e8ad21ef789c4499aa54bf1fd5f6f972.html' },
  { title: '上海人社2026年8月4日 · 满1年不满2年仍为3个月', url: 'https://rsj.sh.gov.cn/trdhy_17355/20260805/269b2b8831de4d27ac30246a832c2bac.html' },
  { title: '上海人社2025年10月28日 · 20.67个病休工作日折算1个月', url: 'https://rsj.sh.gov.cn/tmsztc_17502/20251107/t0035_1436642.html' }
]

const leap = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
const monthDays = (year, month) => [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
const iso = (year, month, day) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
const parts = (date) => date.split('-').map(Number)

export function normalizeMedicalDate(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const match = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(text)
    || /^(\d{4})年(\d{1,2})月(\d{1,2})(?:日|号)?$/.exec(text)
    || /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (!match) return null
  const [, y, m, d] = match.map(Number)
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= monthDays(y, m) ? iso(y, m, d) : null
}

function ordinal(date) {
  const [year, month, day] = parts(date)
  const prior = year - 1
  let total = prior * 365 + Math.floor(prior / 4) - Math.floor(prior / 100) + Math.floor(prior / 400) + day
  for (let index = 1; index < month; index++) total += monthDays(year, index)
  return total
}

export function countMedicalCalendarDays(start, end) {
  const first = normalizeMedicalDate(start)
  const last = normalizeMedicalDate(end)
  return first && last && first <= last ? ordinal(last) - ordinal(first) + 1 : null
}

// Calendar comparison only. Feb-29 anniversaries are flagged in the result;
// clipping here is not presented as a legally confirmed anniversary rule.
function calendarAddMonths(date, count) {
  const [year, month, day] = parts(date)
  const index = year * 12 + month - 1 + count
  const targetYear = Math.floor(index / 12)
  const targetMonth = index % 12 + 1
  return iso(targetYear, targetMonth, Math.min(day, monthDays(targetYear, targetMonth)))
}

// Product reference scenario: the cycle's first sick date anchors the calendar
// quota budget. Include that day, exclude the next corresponding date, and
// clip a missing target day to month-end. This is not a legal expiry forecast.
function calendarReferenceEstimate(start, months, usedDays) {
  const quotaBoundary = calendarAddMonths(start, months)
  const budgetDays = ordinal(quotaBoundary) - ordinal(start)
  return { scope: 'calendar-reference-only', budgetDays, quotaBoundary, usedDays,
    remainingDays: Math.max(0, budgetDays - usedDays),
    overBudgetDays: Math.max(0, usedDays - budgetDays),
    baseThresholdReached: usedDays >= budgetDays }
}

export function completedMedicalYears(start, end) {
  const first = normalizeMedicalDate(start)
  const last = normalizeMedicalDate(end)
  if (!first || !last || first > last) return null
  let years = parts(last)[0] - parts(first)[0]
  if (calendarAddMonths(first, years * 12) > last) years--
  return years
}

function nationalTier(total, unit) {
  if (total < 10) return unit < 5 ? [3, 6] : [6, 12]
  if (unit < 5) return [6, 12]
  if (unit < 10) return [9, 15]
  if (unit < 15) return [12, 18]
  if (unit < 20) return [18, 24]
  return [24, 30]
}
const shanghaiMonths = (unit) => Math.min(24, 3 + Math.max(0, unit - 1))

function nationalTotalTenureBand(input, firstDay, date) {
  if (input.tenYearDate) return input.tenYearDate <= date ? 10 : 0
  if (input.totalWorkYears >= 10) return 10
  if (date === firstDay) return 0
  // An integer at the first date does not reveal its anniversary. Bound the
  // later tenure under continuing employment instead of treating it as exact.
  const minimum = input.totalWorkYears + completedMedicalYears(firstDay, date)
  return minimum >= 10 ? 10 : minimum + 1 >= 10 ? null : 0
}

// Fixed-window grouping is a reference scenario, not a nationwide legal reset
// rule. Boundary allocation, exhausted periods and ambiguous tenure stay explicit.
function segmentedReferenceResults(input, records, quota, usage, reviewReasons) {
  if (input.recordMode !== 'intervals' || input.leaveType !== 'segmented') return []
  if (input.region === 'shanghai') {
    let cumulativeCents = 0
    let complete = true
    return records.rows.map((row) => {
      complete &&= row.workDays !== null
      cumulativeCents += row.workDays === null ? 0 : Math.round(row.workDays * 100)
      const remainingCents = quota ? Math.max(0, quota.months * 2067 - cumulativeCents) : null
      return { ...row, cycleNumber: null, cycleStart: records.firstDay, cycleBoundary: null,
        quotaMonths: quota?.months ?? null, accumulationMonths: null,
        cumulativeWorkDays: complete ? cumulativeCents / 100 : null,
        estimate: usage ? { remainingWorkDays: remainingCents / 100, remainingMonths: remainingCents / 2067 } : null,
        issues: usage ? [] : reviewReasons.filter((item) => ['FIRST_DATE_MISSING', 'HISTORY_INCOMPLETE', 'SPECIAL_REVIEW', 'LEAP_ANNIVERSARY', 'TENURE_CHANGE', 'WORKDAYS_MISSING', 'HISTORICAL_CONVERSION', 'HISTORICAL_CONTRACT', 'RULE_DATE_UNSUPPORTED'].includes(item.code)) }
    })
  }
  if (input.region !== 'national') return []
  const common = reviewReasons.filter((item) => ['HISTORY_INCOMPLETE', 'SPECIAL_REVIEW', 'LEAP_ANNIVERSARY', 'RULE_DATE_UNSUPPORTED'].includes(item.code))
  const totalBand = (date) => nationalTotalTenureBand(input, records.firstDay, date)
  let cycle = null
  let cycleNumber = 0
  let allocationPending = false
  let renewalPending = false
  const output = []
  for (const row of records.rows) {
    if (!cycle || (cycle.boundary && row.startDate > cycle.boundary)) {
      if (cycle?.months && calendarReferenceEstimate(cycle.start, cycle.months, cycle.days).baseThresholdReached) renewalPending = true
      const total = totalBand(row.startDate)
      const [months, accumulationMonths] = quota && total !== null
        ? nationalTier(total, completedMedicalYears(input.hireDate, row.startDate)) : [null, null]
      cycle = { number: ++cycleNumber, start: row.startDate,
        boundary: accumulationMonths ? calendarAddMonths(row.startDate, accumulationMonths) : null,
        months, accumulationMonths, total, days: 0, issues: [...common] }
      if (total === null) cycle.issues.push({ code: 'TOTAL_TENURE_UNKNOWN', message: '本周期累计工龄是否满10年无法由首段已满年数确定；请补充实际满10年的日期。' })
      if (renewalPending) cycle.issues.push({ code: 'RENEWAL_REVIEW', message: '此前周期录入量已达到参考额度；是否重新享有医疗期须核对，不能自动恢复额度。' })
      if (allocationPending) cycle.issues.push({ code: 'PERIOD_ALLOCATION', message: '此前记录涉及累计周期边界，后续周期归属需先核对。' })
    }
    cycle.days += row.naturalDays
    if (cycle.boundary && row.endDate >= cycle.boundary) {
      allocationPending = true
      if (!cycle.issues.some((item) => item.code === 'PERIOD_BOUNDARY')) cycle.issues.push({ code: 'PERIOD_BOUNDARY', message: '本段到达或跨过参考累计周期边界，端点及跨周期分配须核对；保留实际天数，暂不试算余额。' })
    }
    const endTotal = totalBand(row.endDate)
    const endMonths = endTotal === null ? null : nationalTier(endTotal, completedMedicalYears(input.hireDate, row.endDate))[0]
    if (endMonths !== cycle.months && !cycle.issues.some((item) => item.code === 'PERIOD_TENURE_CHANGE')) cycle.issues.push({ code: 'PERIOD_TENURE_CHANGE', message: '本周期病休期间工龄跨档或满10年日期不明确，额度调整须核对。' })
    // An earlier segment's own count remains valid; the period's conclusions
    // must also show later-discovered boundary/tenure uncertainty.
    for (const previous of output.filter((item) => item.cycleNumber === cycle.number)) {
      previous.issues = [...cycle.issues]
      if (cycle.issues.length) previous.estimate = null
      if (cycle.issues.some((item) => ['PERIOD_BOUNDARY', 'PERIOD_ALLOCATION'].includes(item.code))) previous.cumulativeDays = null
    }
    output.push({ ...row, cycleNumber: cycle.number, cycleStart: cycle.start, cycleBoundary: cycle.boundary,
      quotaMonths: cycle.months, accumulationMonths: cycle.accumulationMonths,
      cumulativeDays: cycle.issues.some((item) => ['PERIOD_BOUNDARY', 'PERIOD_ALLOCATION'].includes(item.code)) ? null : cycle.days,
      estimate: cycle.months !== null && !cycle.issues.length ? calendarReferenceEstimate(cycle.start, cycle.months, cycle.days) : null, issues: [...cycle.issues] })
  }
  return output
}

// The form may omit a separate national cutoff when actual end dates exist.
// Keep this preparation separate from strict calculation validation.
export function prepareMedicalPeriodInput(raw) {
  const derivedCutoff = Array.isArray(raw?.segments)
    ? raw.segments.map((row) => normalizeMedicalDate(row?.endDate)).filter(Boolean).sort().at(-1) || '' : ''
  return { ...raw, asOf: raw?.asOf || (raw?.region !== 'shanghai' && raw?.recordMode === 'intervals' ? derivedCutoff : '') }
}
const blank = (value) => value === undefined || value === null || (typeof value === 'string' && !value.trim())
function readNumber(value, decimals = 0) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  if (!text || !(decimals ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/).test(text)) return null
  const number = Number(text)
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER / 100 ? number : null
}

/**
 * today is supplied by the caller when validating actual (rather than future)
 * records. Include it in a future server receipt; this function reads no clock.
 * ok means valid input, not legal approval or a confirmed maturity date.
 */
export function calculateMedicalPeriod(raw, { today } = {}) {
  const errors = []
  const error = (field, message) => errors.push({ field, message })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: 'form', message: '请提供完整的测算条件。' }] }
  }
  if (typeof raw.region !== 'string' || !Object.hasOwn(REGION_LABELS, raw.region)) error('region', '请选择适用地区。')
  const date = (value, field, optional = false) => {
    if (optional && blank(value)) return null
    const normalized = normalizeMedicalDate(value)
    if (!normalized) error(field, '请填写1900至2100年之间的真实日期。')
    return normalized
  }
  const input = {
    region: raw.region, locality: typeof raw.locality === 'string' ? raw.locality.trim().slice(0, 100) : '',
    asOf: date(raw.asOf, 'asOf'), hireDate: date(raw.hireDate, 'hireDate'),
    recordMode: raw.recordMode || 'intervals', leaveType: raw.leaveType || 'continuous',
    historyComplete: raw.historyComplete === true, specialCircumstances: raw.specialCircumstances === true,
    specialNote: typeof raw.specialNote === 'string' ? raw.specialNote.slice(0, 1000) : '',
    totalWorkYears: null, tenYearDate: null, segments: [], summary: null
  }
  const assessmentDate = today === undefined ? null : date(today, 'assessmentDate')
  if (!['intervals', 'summary'].includes(input.recordMode)) error('recordMode', '请选择实际日期段或汇总记录。')
  if (!['continuous', 'segmented'].includes(input.leaveType)) error('leaveType', '请选择连续或非连续分段病休。')
  for (const field of ['historyComplete', 'specialCircumstances']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') error(field, '请明确选择是否确认。')
  }
  if (input.asOf && assessmentDate && input.asOf > assessmentDate) error('asOf', '统计截止日不能晚于测算当日；未来病休不能记为已经发生。')
  if (input.asOf && input.hireDate && input.hireDate > input.asOf) error('hireDate', '入职日期不能晚于统计截止日。')
  if (input.region === 'national') {
    input.totalWorkYears = readNumber(raw.totalWorkYears)
    if (input.totalWorkYears === null || input.totalWorkYears > 80) error('totalWorkYears', '请填写累计工龄的已满年数（0至80整数）；未知不能按0处理。')
    input.tenYearDate = date(raw.tenYearDate, 'tenYearDate', true)
  }
  const workdays = (value, field, maximum) => {
    if (blank(value)) return null
    const number = readNumber(value, 2)
    if (number === null || (maximum !== null && number > maximum)) {
      error(field, '病休工作日须为非负数，最多两位小数，且不能超过该记录的自然日数。')
    }
    return number
  }
  let firstDay = null
  let lastDay = null
  let naturalDays = 0
  let knownWorkDaysCents = 0
  let allWorkDaysKnown = true
  let rows = []
  if (input.recordMode === 'summary') {
    const source = raw.summary && typeof raw.summary === 'object' && !Array.isArray(raw.summary) ? raw.summary : {}
    const optionalDetails = input.region === 'shanghai'
    const firstDate = date(source.firstDate, 'summary.firstDate', optionalDetails)
    const days = optionalDetails && blank(source.naturalDays) ? null : readNumber(source.naturalDays)
    const horizonStart = firstDate || (optionalDetails ? input.hireDate : null)
    const horizon = horizonStart && input.asOf ? countMedicalCalendarDays(horizonStart, input.asOf) : null
    if (!(optionalDetails && blank(source.naturalDays)) && (days === null || days < 1 || (horizon !== null && days > horizon))) error('summary.naturalDays', '请填写正整数累计自然日数，不能超过已知日期范围。')
    const maximumWorkDays = days === null ? horizon : horizon === null ? days : Math.min(days, horizon)
    const workDays = optionalDetails ? workdays(source.workDays, 'summary.workDays', maximumWorkDays) : null
    if (optionalDetails && workDays === null && !firstDate && days === null) error('summary.workDays', '请提供首次病休日期或实际累计病休工作日；未知不要填0。')
    input.summary = { firstDate, naturalDays: days, workDays }
    firstDay = firstDate
    naturalDays = days
    allWorkDaysKnown = workDays !== null
    knownWorkDaysCents = workDays === null ? 0 : Math.round(workDays * 100)
  } else if (input.recordMode === 'intervals') {
    if (!Array.isArray(raw.segments) || !raw.segments.length) error('segments', '请至少填写一段实际病休起止日期。')
    else {
      if (input.leaveType === 'continuous' && raw.segments.length !== 1) error('segments', '连续病休只能有一段；请保留记录并选择非连续分段。')
      rows = raw.segments.map((source, index) => {
        const row = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
        const startDate = date(row.startDate, `segments.${index}.startDate`)
        const endDate = date(row.endDate, `segments.${index}.endDate`)
        const days = startDate && endDate ? countMedicalCalendarDays(startDate, endDate) : null
        if (startDate && endDate && startDate > endDate) error(`segments.${index}.endDate`, '结束日期不能早于开始日期。')
        if (endDate && input.asOf && endDate > input.asOf) error(`segments.${index}.endDate`, '结束日期不能晚于统计截止日；请核对，不会自动截断记录。')
        const workDays = input.region === 'shanghai' ? workdays(row.workDays, `segments.${index}.workDays`, days) : null
        input.segments.push({ startDate, endDate, workDays })
        return { inputIndex: index, startDate, endDate, naturalDays: days, workDays, gapDays: 0 }
      })
      if (rows.every((row) => row.startDate && row.endDate && row.naturalDays !== null)) {
        rows.sort((a, b) => a.startDate.localeCompare(b.startDate))
        let occupiedUntil = null
        let occupiedRow = null
        rows.forEach((row, index) => {
          if (occupiedUntil && row.startDate <= occupiedUntil) error(`segments.${row.inputIndex}.startDate`, `与第${occupiedRow.inputIndex + 1}段病休重叠或重复，请核对原始记录。`)
          row.gapDays = index === 0 ? 0 : Math.max(0, ordinal(row.startDate) - ordinal(rows[index - 1].endDate) - 1)
          if (!occupiedUntil || row.endDate > occupiedUntil) { occupiedUntil = row.endDate; occupiedRow = row }
        })
        firstDay = rows[0].startDate
        lastDay = occupiedUntil
        naturalDays = rows.reduce((sum, row) => sum + row.naturalDays, 0)
        allWorkDaysKnown = rows.every((row) => row.workDays !== null)
        knownWorkDaysCents = rows.reduce((sum, row) => sum + (row.workDays === null ? 0 : Math.round(row.workDays * 100)), 0)
      }
    }
  }
  if (firstDay && input.asOf && firstDay > input.asOf) error(input.recordMode === 'summary' ? 'summary.firstDate' : 'segments.0.startDate', '首个病休日不能晚于统计截止日。')
  if (firstDay && input.hireDate && firstDay < input.hireDate) error('hireDate', '本单位病休记录不能早于入职日期，请核对入职及历史承继情况。')
  const unitYearsAtStart = firstDay && input.hireDate ? completedMedicalYears(input.hireDate, firstDay) : null
  const unitYearsAtAsOf = input.asOf && input.hireDate ? completedMedicalYears(input.hireDate, input.asOf) : null
  if (input.region === 'national' && unitYearsAtStart !== null && input.totalWorkYears !== null) {
    if (input.totalWorkYears < unitYearsAtStart) error('totalWorkYears', '累计实际工龄不能少于首个病休日的本单位已满年数；有承继或扣除情形请人工核对。')
    if (input.tenYearDate && firstDay && ((input.tenYearDate <= firstDay) !== (input.totalWorkYears >= 10))) error('tenYearDate', '满10年日期与首个病休日的累计工龄矛盾，请核对。')
  }
  if (errors.length) return { ok: false, errors }

  const reviewReasons = []
  const reason = (code, message) => { if (!reviewReasons.some((item) => item.code === code)) reviewReasons.push({ code, message }) }
  const shanghai = input.region === 'shanghai'
  const rule = {
    id: shanghai ? 'shanghai-medical-2015-current' : input.region === 'national' ? 'national-medical-479-baseline' : null,
    version: shanghai ? '沪府发〔2015〕40号／沪府〔2025〕20号；工作日解释2025-10-28' : input.region === 'national' ? '劳部发〔1994〕479号／〔1995〕236号' : '适用规则尚未确定',
    effectiveFrom: shanghai ? '2015-05-01' : '1995-01-01',
    effectiveThrough: shanghai ? '2030-06-30' : null,
    verifiedOn: VERIFIED_ON, businessApproval: 'pending',
    sources: (shanghai ? SH_SOURCES : input.region === 'national' ? NATIONAL_SOURCES : []).map((source) => ({ ...source }))
  }
  let quota = null
  let usage = null
  let referenceEstimate = null
  // Without a first sick day, only show an explicitly labelled as-of comparison.
  // Never infer a sick interval or use that comparison to issue a balance.
  const referenceDate = firstDay || (shanghai ? input.asOf : null)
  const referenceYears = firstDay ? unitYearsAtStart : unitYearsAtAsOf
  if (shanghai && !firstDay) reason('FIRST_DATE_MISSING', '尚未提供首个病休日，基础额度仅按计算截止日年限作对照；补充首日及完整历史后再核对余额。')
  if (!input.historyComplete) reason('HISTORY_INCOMPLETE', shanghai ? '尚未确认本单位期间的全部病休历史，录入量不能当作全部已用医疗期。' : '尚未确认相关累计范围内的全部病休历史。')
  if (input.specialCircumstances) reason('SPECIAL_REVIEW', '特殊疾病、鉴定、延长审批或更长约定需要人工核对；基础额度不代表最终额度。')
  if (input.recordMode === 'summary') reason('DISTRIBUTION_UNKNOWN', '当前为累计量，无法判断病休分布、重叠与窗口归属，不生成实际日期段。')
  if (input.hireDate.endsWith('-02-29')) reason('LEAP_ANNIVERSARY', '2月29日入职在平年的周年归属需要核定；本次年限仅按日历截断作对照。')
  const supportedDates = referenceDate >= rule.effectiveFrom && (!rule.effectiveThrough || input.asOf <= rule.effectiveThrough)
  if (input.region === 'other') reason('REGION_UNSUPPORTED', '适用地区规则尚未确定，本次只核对录入的病休记录。')
  else if (!supportedDates) reason('RULE_DATE_UNSUPPORTED', '病休记录或统计日期超出已核对规则期间，只统计记录，不推断基础额度或届满日期。')
  else {
    const [months, accumulationMonths] = shanghai ? [shanghaiMonths(referenceYears), null] : nationalTier(input.totalWorkYears, unitYearsAtStart)
    quota = { months, accumulationMonths, unitYearsAtStart, unitYearsAtAsOf, referenceDate, referenceBasis: firstDay ? 'first-day' : 'as-of', scope: 'base-reference' }
    reason('TENURE_BASIS_PENDING', firstDay ? '基础额度按最早录入病休日的工作年限作参考；实际起算点及跨档调整仍需结合完整历史核对。' : '截止日年限只用于基础额度对照，不代表历史病休适用的最终额度。')
    const asOfTotal = input.totalWorkYears >= 10 || (input.tenYearDate && input.tenYearDate <= input.asOf) ? 10 : 0
    const endMonths = shanghai ? shanghaiMonths(unitYearsAtAsOf) : nationalTier(asOfTotal, unitYearsAtAsOf)[0]
    if (endMonths !== months) reason('TENURE_CHANGE', '病休统计期间工作年限跨越额度档位，需要核定是否调整；不直接套用首日或截止日额度计算余额。')
    if (!shanghai && input.tenYearDate && input.tenYearDate > firstDay && input.tenYearDate <= input.asOf) reason('TOTAL_TENURE_CHANGE', '病休统计期间累计工龄满10年，额度及累计范围的调整需要人工核定。')
    if (!shanghai && input.totalWorkYears === 9 && !input.tenYearDate && input.asOf > firstDay) reason('TOTAL_TENURE_DATE_MISSING', '累计工作年限已满9年，期间可能满10年；请补充实际满10年的日期，核对是否跨档。')
    if (shanghai) {
      if (!allWorkDaysKnown) reason('WORKDAYS_MISSING', '请按实际考勤补充每段病休工作日；不能根据自然日或仅扣除周末推算。')
      if (firstDay && firstDay < SH_CONVERSION_VERIFIED_FROM) reason('HISTORICAL_CONVERSION', '涉及较早病休记录，20.83与20.67的历史适用、转换及累计需核对，不统一按现行常量折算。')
      if (input.hireDate < rule.effectiveFrom) reason('HISTORICAL_CONTRACT', '本规定施行前已履行的劳动合同存在历史适用条款，请核对合同及当时规则。')
      const blockers = ['FIRST_DATE_MISSING', 'HISTORY_INCOMPLETE', 'SPECIAL_REVIEW', 'LEAP_ANNIVERSARY', 'TENURE_CHANGE', 'WORKDAYS_MISSING', 'HISTORICAL_CONVERSION', 'HISTORICAL_CONTRACT']
      if (!reviewReasons.some((item) => blockers.includes(item.code))) {
        // Workdays stored in hundredths; compare before display rounding.
        const remainingCents = months * 2067 - knownWorkDaysCents
        usage = {
          scope: 'base-reference', monthWorkDays: SH_MONTH_WORKDAYS,
          usedMonths: knownWorkDaysCents / 2067,
          remainingMonths: Math.max(0, remainingCents / 2067),
          remainingWorkDays: Math.max(0, remainingCents / 100),
          baseThresholdReached: remainingCents <= 0
        }
      }
      reason('SH_MATURITY_PENDING', '未来病休排班、届满当天的小数处理及最终适用额度未确定，暂不能给出届满日期。')
    } else {
      reason('LOCAL_RULE_PENDING', '这里只核对全国基础额度，尚未完成具体适用地区的地方规定核对。')
      reason('DAY_MONTH_PENDING', '当前按周期起点对应的日历月实际天数作参考预算；分段日月换算及最终法定余额仍需核对地方口径，不能把参考预算当作核定结果。')
      reason('WINDOW_REVIEW', '累计窗口长度与医疗期额度不同；窗口端点、重启及跨窗口分配需核定，录入总量不能直接认作同一窗口已用量。')
      if (input.asOf >= calendarAddMonths(firstDay, accumulationMonths)) reason('WINDOW_SPAN', '记录或统计截止日到达、跨过首个病休日对应的累计窗口边界；请核对窗口归属后再计算余额。')
      const blockers = ['HISTORY_INCOMPLETE', 'SPECIAL_REVIEW', 'LEAP_ANNIVERSARY', 'TENURE_CHANGE', 'TOTAL_TENURE_CHANGE', 'TOTAL_TENURE_DATE_MISSING', 'DISTRIBUTION_UNKNOWN', 'WINDOW_SPAN']
      if (!reviewReasons.some((item) => blockers.includes(item.code))) {
        referenceEstimate = calendarReferenceEstimate(firstDay, months, naturalDays)
        reason('CALENDAR_REFERENCE_ONLY', '页面按首个病休日对应的日历月实际天数作预算；包含起点，不含下一对应日，目标月无对应日时取月末。分段同周期共用预算，地方口径尚待校准，不据此判断届满。')
      }
    }
  }
  const records = {
    precision: input.recordMode === 'summary' ? 'summary' : 'dated-intervals', firstDay, lastDay,
    naturalDays, workDays: shanghai && allWorkDaysKnown ? knownWorkDaysCents / 100 : null,
    knownWorkDays: shanghai ? knownWorkDaysCents / 100 : null, rows
  }
  const steps = [
    { title: '确认记录范围', detail: `统计截止于${input.asOf}；${firstDay ? `最早录入病休日为${firstDay}` : '首个病休日未提供'}。${input.historyComplete ? '已勾选历史完整，仍需核对原始材料。' : '历史完整性未确认。'}` },
    { title: '核对工作年限', detail: `${firstDay ? `最早录入病休日的本单位已满年数为${unitYearsAtStart}年，` : '首日年限未知，'}统计截止日为${unitYearsAtAsOf}年。${shanghai ? '上海基础额度按本单位年限设置。' : input.region === 'national' ? `首日累计工龄为${input.totalWorkYears}个已满年。` : '尚未选择可用额度规则。'}` },
    { title: '累计实际病休记录', detail: `${input.recordMode === 'summary' ? '采用填写的汇总量，日期分布未知。' : '每段含首尾日期，间隔不计入，重叠记录已拒绝。'}${naturalDays === null ? '累计自然日未提供' : `本次录入${naturalDays}个自然日`}${shanghai ? `；${records.workDays === null ? '病休工作日尚不完整' : `考勤病休工作日合计${records.workDays}天`}` : ''}。` },
    { title: '确定可展示的结论', detail: usage ? `已用折算：${records.workDays} ÷ 20.67，约${usage.usedMonths.toFixed(2)}个月；基础预算${quota.months} × 20.67 = ${quota.months * 2067 / 100}个病休工作日。预算扣除已录工作日后，未用量为${usage.remainingWorkDays}个病休工作日（${usage.remainingMonths > 0 && usage.remainingMonths < 0.005 ? '不足0.01' : `约${usage.remainingMonths.toFixed(2)}`}个月）；录入量达到或超过预算时余额显示0${usage.baseThresholdReached ? '（录入工作日折算已达到基础额度）' : ''}。展示值保留2位小数，不据显示舍入判断届满。` : quota ? '本次已匹配基础分档并统计病休时间；法定余额及未来届满日期未核定，具体原因见核算状态。' : '本次只统计录入病休时间；适用规则尚未确定，未计算基础额度和余额。' }
  ]
  return {
    ok: true, status: 'reference', schemaVersion: 1, algorithmVersion: ALGORITHM_VERSION,
    assessmentDate, input, regionLabel: REGION_LABELS[input.region], rule,
    quota, records, usage, referenceEstimate, maturityDate: null, reviewReasons, steps,
    segmentResults: segmentedReferenceResults(input, records, quota, usage, reviewReasons)
  }
}

// One presentation contract for the page and copied receipt. Primary national
// balances explicitly retain the unverified calendar-budget qualification.
export function describeMedicalPeriodResult(result) {
  if (!result?.ok) return null
  const { input, quota, records, usage, referenceEstimate, reviewReasons } = result
  const shanghai = input.region === 'shanghai'
  const segments = result.segmentResults || []
  const segmentedNational = !shanghai && segments.length > 0
  const lastSegment = segments.at(-1)
  const cycleCount = new Set(segments.map((row) => row.cycleNumber)).size
  const groupingKnown = segments.every((row) => row.accumulationMonths !== null)
  const anyWorkDaysKnown = records.workDays !== null || records.rows.some((row) => row.workDays !== null)
  const years = quota?.referenceBasis === 'as-of' ? quota.unitYearsAtAsOf : quota?.unitYearsAtStart
  const unitYears = years === 0 ? '本单位未满1年' : `本单位已满${years}年`
  const quotaDetail = !quota ? '适用地区或日期超出当前已核对的规则范围' : shanghai
    ? `${unitYears}；按${quota.referenceBasis === 'as-of' ? '计算截止日' : '首次病休日'}${quota.referenceDate}年限${quota.referenceBasis === 'as-of' ? '作对照' : '匹配基础额度'}`
    : `累计工作${input.totalWorkYears}年，${unitYears}；按参考起点${quota.referenceDate}匹配分档`
  const scope = shanghai
    ? `请核对本单位入职${input.hireDate}至统计截止${input.asOf}的全部病休工作日，包括此前病休。`
    : quota ? `参考起点${records.firstDay}，按${quota.accumulationMonths}个月内累计病休核对。此前若有相关病休，请补齐记录并核对起点。`
      : '请保留实际病休记录，核对适用地区、规则期间与起算日期。'
  const actionCodes = ['REGION_UNSUPPORTED', 'RULE_DATE_UNSUPPORTED', 'SPECIAL_REVIEW', 'FIRST_DATE_MISSING', 'HISTORY_INCOMPLETE', 'WORKDAYS_MISSING', 'TOTAL_TENURE_DATE_MISSING', 'TENURE_CHANGE', 'TOTAL_TENURE_CHANGE', 'LEAP_ANNIVERSARY', 'HISTORICAL_CONVERSION', 'HISTORICAL_CONTRACT', 'WINDOW_SPAN', 'DISTRIBUTION_UNKNOWN']
  const actions = actionCodes.map((code) => reviewReasons.find((item) => item.code === code)).filter(Boolean)
  let status
  if (usage) status = { tone: usage.baseThresholdReached ? 'pending' : 'complete',
    title: usage.baseThresholdReached ? '工作日折算已达到基础额度' : '已按上海工作日口径完成折算',
    detail: usage.baseThresholdReached ? '录入工作日已达到基础额度；有延长或更长约定时需另行核对，不能据此直接判断可解除劳动合同。' : '按确认的本单位全部病休工作日，以20.67工作日折算1个月；不据此预测未来届满日期。' }
  else if (actions.length) status = { tone: 'pending', title: actions.some((item) => ['FIRST_DATE_MISSING', 'HISTORY_INCOMPLETE', 'WORKDAYS_MISSING', 'TOTAL_TENURE_DATE_MISSING'].includes(item.code)) ? '已统计记录，还需补充核对信息' : '已统计记录，适用条件需人工核对', detail: actions[0].message }
  else status = { tone: 'pending', title: '已匹配基础分档，法定余额待核对', detail: '全国基础分档和录入天数已计算。法定额度以月计，病休记录以自然日计；最终余额需核对具体适用地区的日月折算口径。' }
  const presentation = {
    referenceDate: quota?.referenceDate || records.firstDay,
    quotaValue: quota?.months ?? '待核对',
    quotaLabel: quota?.referenceBasis === 'as-of' ? '基础额度对照' : '基础医疗期额度', quotaDetail,
    recordValue: shanghai ? records.workDays ?? (anyWorkDaysKnown ? records.knownWorkDays : '未提供') : records.naturalDays,
    recordUnit: shanghai ? records.workDays === null && anyWorkDaysKnown ? '工作日（部分）' : '工作日' : '自然日',
    recordDetail: shanghai ? `${records.naturalDays === null ? '自然日总量未提供' : `日期范围合计${records.naturalDays}个自然日`}；月数按病休工作日折算` : records.precision === 'summary' ? '仅有汇总量，日期分布未知' : '各段包含首尾日期，未病休的间隔不计入',
    thirdLabel: shanghai ? '剩余医疗期' : '剩余医疗期（参考）',
    thirdValue: shanghai ? usage?.remainingWorkDays ?? '待核对' : referenceEstimate?.remainingDays ?? '待核对',
    thirdUnit: shanghai ? usage ? '工作日' : '' : referenceEstimate ? '天' : '',
    thirdDetail: shanghai ? usage ? '按20.67工作日/月折算' : medicalBalanceReason(actions[0]) : referenceEstimate ? '按实际日历天数参考，非核定法定余额' : medicalBalanceReason(actions[0]),
    meaning: quota ? shanghai ? '医疗期是停工治病期间的劳动合同保护期限。上海按本单位年限设置基础额度，病休月份按工作日折算。' : `${quota.months}个月是基础医疗期额度，按${quota.accumulationMonths}个月内累计病休判断是否用满；实际需要病休多久依据医疗证明。` : '本次可以核对录入天数；基础医疗期额度需先确认适用规则。',
    referenceDetail: referenceEstimate ? `日历参考预算：以${records.firstDay}为起点，增加${quota.months}个月至${referenceEstimate.quotaBoundary}，包含起点、不含下一对应日，共${referenceEstimate.budgetDays}天；已录入${referenceEstimate.usedDays}天，参考余额${referenceEstimate.remainingDays}天${referenceEstimate.overBudgetDays ? `（录入量超出参考预算${referenceEstimate.overBudgetDays}天）` : ''}。目标月无对应日时取月末；该区间仅用于换算参考预算，不是员工届满日期。地方口径仍待核对。` : null,
    scope, status, actions, reviewReasons
  }
  if (segmentedNational) {
    const issues = [...new Map(segments.flatMap((row) => row.issues).map((item) => [item.code, item])).values()]
    Object.assign(presentation, {
      quotaLabel: '最近一段基础额度', quotaValue: lastSegment.quotaMonths ?? '待核对',
      quotaDetail: `按最近一段所在参考周期起点${lastSegment.cycleStart}的年限分档；各段额度见下方`,
      thirdLabel: '最近一段剩余（参考）', thirdValue: lastSegment.estimate?.remainingDays ?? '待核对', thirdUnit: lastSegment.estimate ? '天' : '',
      thirdDetail: lastSegment.estimate ? '按所在周期的实际日历天数参考' : medicalBalanceReason(lastSegment.issues[0]),
      meaning: '各段结果按参考累计周期分别展示，同周期共用预算并累计已休；预算以本周期首个病休日为起点，按额度月数对应的实际日历天数确定。包含起点、不含下一对应日，无对应日取月末；具体地方口径及周期重启仍需核对，不据此预测届满。',
      scope: groupingKnown ? `${segments.length}段病休按固定累计窗口参考方案分为${cycleCount}个周期；跨周期的总天数不直接扣减某一个周期额度。` : `${segments.length}段病休已统计；部分周期长度或归属待核对，详情见分段结果。`,
      status: { tone: 'pending', title: issues.length ? '已分段统计，部分结果需补充核对' : '已按参考累计周期分段统计',
        detail: issues[0]?.message || '每段已显示本段天数、周期累计量及剩余试算；参考周期和试算值不代表已核定的法定余额。' },
      actions: issues, referenceDetail: null,
      reviewReasons: [...new Map([...reviewReasons.filter((item) => !['WINDOW_SPAN', 'TENURE_CHANGE', 'TOTAL_TENURE_CHANGE', 'TOTAL_TENURE_DATE_MISSING', 'TENURE_BASIS_PENDING', 'CALENDAR_REFERENCE_ONLY'].includes(item.code)),
        { code: 'SEGMENTED_REFERENCE', message: '分段结果采用固定累计窗口的参考方案；每周期按起点工龄重新分档，同周期内累计，跨档或边界归属不明确时停止余额试算。' }, ...issues].map((item) => [item.code, item])).values()]
    })
  }
  return presentation
}

// UI guidance reuses the same tenure bounds, without changing eligibility or
// requiring unknown inputs to be fabricated. Targets are existing form fields.
export function describeMedicalInputGuidance(result) {
  if (!result?.ok) return { needsTenYearDate: false, fields: [] }
  const { input, records } = result
  const display = describeMedicalPeriodResult(result)
  const undecided = { ...input, tenYearDate: null }
  const needsTenYearDate = input.region === 'national' && input.totalWorkYears < 10 && Boolean(records.firstDay) && (
    input.totalWorkYears === 9 && input.asOf > records.firstDay ||
    input.leaveType === 'segmented' && records.rows.some((row) => [row.startDate, row.endDate].some((date) => nationalTotalTenureBand(undecided, records.firstDay, date) === null))
  )
  const fields = []
  const add = (field, code) => {
    if (!fields.some((item) => item.field === field)) fields.push({ field, message: medicalBalanceReason({ code }) })
  }
  for (const item of display.actions) {
    if (item.code === 'FIRST_DATE_MISSING') add('summary.firstDate', item.code)
    if (item.code === 'HISTORY_INCOMPLETE') add('historyComplete', item.code)
    if (item.code === 'WORKDAYS_MISSING') {
      if (input.recordMode === 'summary') add('summary.workDays', item.code)
      else input.segments.forEach((row, index) => { if (row.workDays === null) add(`segments.${index}.workDays`, item.code) })
    }
  }
  if (needsTenYearDate && !input.tenYearDate) add('tenYearDate', 'TOTAL_TENURE_DATE_MISSING')
  return { needsTenYearDate, fields }
}

// Short actionable wording is shared by result cards and the copied receipt.
function medicalBalanceReason(issue) {
  const messages = {
    TOTAL_TENURE_DATE_MISSING: '请补充累计工龄满10年日期',
    TOTAL_TENURE_UNKNOWN: '请补充累计工龄满10年日期',
    FIRST_DATE_MISSING: '请补充首次病休日期',
    HISTORY_INCOMPLETE: '请补齐并确认全部相关病休记录',
    WORKDAYS_MISSING: '请补充实际病休工作日',
    SPECIAL_REVIEW: '特殊情况或延长约定需人工核对',
    TENURE_CHANGE: '病休期间工龄跨档，需核对额度调整',
    TOTAL_TENURE_CHANGE: '病休期间累计工龄满10年，需核对额度调整',
    PERIOD_TENURE_CHANGE: '请核对本周期工龄跨档及额度调整',
    WINDOW_SPAN: '病休跨累计周期，需核对周期归属',
    PERIOD_BOUNDARY: '病休到达或跨周期边界，需核对归属',
    PERIOD_ALLOCATION: '请先核对此前跨周期病休的归属',
    RENEWAL_REVIEW: '前一周期已达参考额度，需核对是否重新享有医疗期',
    DISTRIBUTION_UNKNOWN: '请补充实际病休日期段，核对周期归属',
    LEAP_ANNIVERSARY: '2月29日入职，需核对周年日期',
    HISTORICAL_CONVERSION: '较早病休记录的工作日换算需核对',
    HISTORICAL_CONTRACT: '请核对历史合同及适用规则',
    RULE_DATE_UNSUPPORTED: '记录日期超出当前规则范围',
    REGION_UNSUPPORTED: '请核对适用地区规则'
  }
  return messages[issue?.code] || issue?.message || '请核对适用额度与病休记录'
}

export function describeMedicalSegmentResult(result, segment) {
  const shanghai = result.input.region === 'shanghai'
  const estimate = segment.estimate
  return {
    title: `第${segment.inputIndex + 1}段`, dates: `${segment.startDate} 至 ${segment.endDate}`,
    periodLabel: shanghai ? '本单位病休累计' : segment.cycleBoundary ? `参考周期 ${segment.cycleNumber}` : '周期待核对',
    period: shanghai ? '分段不重置额度' : segment.cycleBoundary
      ? `${segment.cycleStart} 至 ${segment.cycleBoundary}` : '累计周期待核对',
    quota: segment.quotaMonths === null ? '待核对' : `${segment.quotaMonths}个月`,
    recorded: shanghai ? `${segment.workDays ?? '未提供'}工作日` : `${segment.naturalDays}自然日`,
    cumulative: shanghai ? `${segment.cumulativeWorkDays ?? '未完整提供'}工作日` : segment.cumulativeDays === null ? '归属待核对' : `${segment.cumulativeDays}自然日`,
    balanceLabel: '剩余',
    balance: !estimate ? '待核对' : shanghai ? `${estimate.remainingWorkDays}工作日` : `${estimate.remainingDays}天（参考）`,
    balanceDetail: !estimate ? medicalBalanceReason(segment.issues[0]) : estimate.overBudgetDays ? `已超出参考预算${estimate.overBudgetDays}天` : shanghai ? '' : `本周期${segment.quotaMonths}个月对应${estimate.budgetDays}个实际日历天`
  }
}

export function formatMedicalResult(result) {
  if (!result?.ok) return ''
  const { input, quota, records, referenceEstimate } = result
  const display = describeMedicalPeriodResult(result)
  const lines = [
    '员工医疗期测算',
    `适用地区：${result.regionLabel}${input.locality ? `（${input.locality}）` : ''}`,
    `统计截止日：${input.asOf}；本单位入职日：${input.hireDate}`,
    `最早录入病休日：${records.firstDay || '未提供'}；记录方式：${records.precision === 'summary' ? '汇总量，日期分布未知' : '实际日期段'}`,
    `累计工龄：${input.totalWorkYears === null ? '不参与本地区额度分档' : `${input.totalWorkYears}个已满年`}；满10年日期：${input.tenYearDate || '未提供'}`,
    `历史完整性：${input.historyComplete ? '已勾选，需核对材料' : '未确认'}；特殊情况：${input.specialCircumstances ? '已勾选，待人工核对' : '未勾选'}`,
    ...(input.specialNote ? [`备注：${input.specialNote}`] : []),
    `${display.quotaLabel}：${typeof display.quotaValue === 'number' ? `${display.quotaValue}个月` : display.quotaValue}；${display.quotaDetail}`,
    `累计窗口：${result.segmentResults?.length && input.region === 'national' ? '各参考周期见分段结果' : quota?.accumulationMonths ? `${quota.accumulationMonths}个月（端点及重启待核对）` : input.region === 'shanghai' ? '核对本单位期间全部病休' : '待核对'}`,
    `本次录入自然日：${records.naturalDays === null ? '未提供' : `${records.naturalDays}天`}；病休工作日：${records.workDays === null ? '未完整提供或不适用' : `${records.workDays}天`}`,
    `已录入病休：${display.recordValue}${display.recordUnit}`,
    `额度含义：${display.meaning}`,
    `核算范围：${display.scope}`,
    `核算状态：${display.status.title}；${display.status.detail}`,
    `${display.thirdLabel}：${display.thirdValue}${display.thirdUnit}；${display.thirdDetail}`,
    ...(referenceEstimate && display.referenceDetail ? [`参考折算（非核定余额）：${display.referenceDetail}`] : []),
    '届满日期：不预测未来届满日；医疗期届满不自动构成解除劳动合同的结论。',
    '', '记录明细：',
    ...records.rows.map((row) => `原第${row.inputIndex + 1}段：${row.startDate}至${row.endDate}，含首尾${row.naturalDays}自然日，间隔${row.gapDays}日${input.region === 'shanghai' ? `，病休工作日${row.workDays === null ? '未知' : row.workDays}` : ''}`),
    ...(result.segmentResults?.length ? ['', '分段测算结果（参考）：', ...result.segmentResults.map((row) => {
      const segment = describeMedicalSegmentResult(result, row)
      return `${segment.title}：${segment.dates}；${segment.periodLabel}，${segment.period}；基础额度${segment.quota}；本段${segment.recorded}，累计${segment.cumulative}；${segment.balanceLabel}：${segment.balance}；${segment.balanceDetail}`
    })] : []),
    '', '待核对事项：', ...display.reviewReasons.map((item) => `- ${item.message}`),
    '', `规则版本：${result.rule.version}；来源核对日：${result.rule.verifiedOn}；业务验收：待复核`,
    `计算版本：${result.algorithmVersion}`,
    ...result.rule.sources.map((source) => `${source.title}：${source.url}`)
  ]
  return lines.join('\n')
}
