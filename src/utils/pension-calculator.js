import { ACCOUNT_RATE, FLEXIBLE_RATE, PERSONAL_RATE, PENSION_RULE_VERSION, PENSION_SOURCES } from './pension-rules.js'
import { formatMonth, getMinimumContributionMonths, getTablePaymentMonths, monthIndex, resolveRetirement } from './pension-retirement.js'

export class PensionInputError extends Error {
  constructor(errors) {
    super('请核对测算条件。')
    this.name = 'PensionInputError'
    this.errors = errors
  }
}

const blank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
export const roundPensionMoney = (value) => Math.round((value + Number.EPSILON * Math.abs(value)) * 100) / 100

// Validate independently of the UI. Empty numeric fields are never coerced to zero.
export function validatePensionInput(raw) {
  const errors = []
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const n = {}
  const fail = (field, message) => errors.push({ field, message })
  const text = (field, label, max = 200) => {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > max) {
      fail(field, `请填写${label}（不超过${max}字）。`); return ''
    }
    return input[field].trim()
  }
  const option = (field, options, label) => {
    if (!options.includes(input[field])) { fail(field, `请选择${label}。`); return null }
    return input[field]
  }
  const number = (field, label, { min = 0, max = 10000000, integer = false, money = false, optional = false } = {}) => {
    if (blank(input[field]) && optional) return null
    if (blank(input[field]) || !['string', 'number'].includes(typeof input[field]) || !/^\d+(\.\d+)?$/.test(String(input[field]).trim())) {
      fail(field, `请填写${label}，未知不能按0处理。`); return null
    }
    const value = Number(input[field])
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)) || (money && Math.abs(value * 100 - Math.round(value * 100)) > 0.00001)) {
      fail(field, `${label}须在${min}—${max}之间${integer ? '，并填写整数' : money ? '，最多保留两位小数' : ''}。`); return null
    }
    return value
  }
  const month = (field, label) => {
    try { return monthIndex(input[field]) } catch { fail(field, `请填写有效的${label}。`); return null }
  }
  n.toolId = option('toolId', ['pension-calc1', 'pension-calc2'], '养老工具身份')
  n.mode = option('mode', ['cost', 'forecast'], '测算内容')
  n.region = text('region', '参保及待遇核定地区', 80)
  n.parameterSource = text('parameterSource', '地区参数依据／文件名称', 400)
  n.policyFromIndex = month('policyFrom', '政策生效年月')
  n.policyToIndex = month('policyTo', '政策适用截止年月')
  n.recordIndex = month('recordMonth', '记录截止年月')
  if (n.recordIndex !== null && n.recordIndex < monthIndex('2025-01')) fail('recordMonth', '本页缴费及账户预测从2025年起；历史缴费请按当年规则核对。')
  if (n.policyFromIndex !== null && n.policyToIndex !== null && n.policyFromIndex > n.policyToIndex) fail('policyTo', '政策截止年月不能早于生效年月。')
  if (n.recordIndex !== null && n.policyFromIndex !== null && n.policyToIndex !== null && (n.recordIndex < n.policyFromIndex || n.recordIndex > n.policyToIndex)) {
    fail('recordMonth', '记录截止年月须在所填政策适用区间内，不能静默沿用其他年度参数。')
  }
  n.lowerBase = number('lowerBase', '月缴费基数下限', { min: 0.01, money: true })
  n.upperBase = number('upperBase', '月缴费基数上限', { min: 0.01, money: true })
  if (n.lowerBase !== null && n.upperBase !== null && n.lowerBase > n.upperBase) fail('upperBase', '缴费上限不能低于下限。')
  if (n.toolId === 'pension-calc2' || n.mode === 'forecast') n.indexBase = number('indexBase', '缴费指数／档位参考基准', { min: 0.01, money: true })
  if (n.toolId === 'pension-calc1') {
    n.contributionBase = number('contributionBase', '当前核定月缴费基数', { min: 0.01, money: true })
    n.employerRate = number('employerRate', '单位养老缴费比例', { min: 0.01, max: 30 })
  } else if (n.toolId === 'pension-calc2') {
    n.grade = number('grade', '缴费档位百分数', { min: 0.01, max: 1000 })
    n.contributionBase = n.indexBase !== null && n.grade !== null ? roundPensionMoney(n.indexBase * n.grade / 100) : null
  }
  if (n.contributionBase !== null && n.lowerBase !== null && n.upperBase !== null && (n.contributionBase < n.lowerBase || n.contributionBase > n.upperBase)) {
    fail(n.toolId === 'pension-calc1' ? 'contributionBase' : 'grade', '所填缴费基数或档位超出当地上下限，请调整；本次不自动改写。')
  }
  if (n.mode === 'forecast') {
    n.birthIndex = month('birthMonth', '出生年月')
    n.category = option('category', ['male', 'female55', 'female50'], '原法定退休类别')
    n.retirementMode = option('retirementMode', ['statutory', 'early', 'late'], '退休方式')
    if (n.birthIndex !== null && n.category && n.retirementMode) {
      try { n.retirement = resolveRetirement(input.birthMonth, n.category, n.retirementMode, input.retirementMonth) }
      catch (error) { fail('retirementMonth', error.message) }
    }
    if (n.recordIndex !== null && n.birthIndex !== null && n.recordIndex - n.birthIndex < 16 * 12) fail('birthMonth', '记录截止时不足16周岁，本页不适用这一参保情形。')
    if (n.retirement && n.recordIndex !== null) {
      n.elapsedMonths = n.retirement.selectedIndex - n.recordIndex
      if (n.elapsedMonths < 0 || n.elapsedMonths > 720) fail('recordMonth', '记录截止年月不能晚于退休年月，预测期间不超过60年。')
    }
    const years = (prefix, label) => {
      const y = number(`${prefix}Years`, `${label}整年数`, { max: 80, integer: true })
      const m = number(`${prefix}ExtraMonths`, `${label}余月数`, { max: 11, integer: true })
      return y === null || m === null ? null : y * 12 + m
    }
    n.actualMonths = years('actual', '实际缴费')
    n.deemedMonths = years('deemed', '视同缴费')
    if (n.actualMonths !== null && n.deemedMonths !== null && n.birthIndex !== null && n.recordIndex !== null && n.actualMonths + n.deemedMonths > n.recordIndex - n.birthIndex) {
      fail('actualYears', '实际与视同年限之和超过出生至记录截止的时间，请核对重复期间。')
    }
    n.historicalIndex = n.actualMonths > 0 ? number('historicalIndex', '历史实际平均缴费指数', { min: 0.0001, max: 10 }) : null
    n.deemedIndex = n.deemedMonths > 0 ? number('deemedIndex', '视同缴费指数', { min: 0.0001, max: 10, optional: true }) : null
    n.accountBalance = number('accountBalance', '同一截止年月的个人账户余额', { money: true })
    n.pensionBase = number('pensionBase', '当前养老金计发基数', { min: 0.01, money: true })
    n.indexMethod = option('indexMethod', ['weighted', 'unconfirmed'], '本地区指数计算口径')
    n.transitionStatus = option('transitionStatus', ['none', 'required', 'unknown'], '过渡待遇适用情况')
    n.paymentPlan = option('paymentPlan', ['all', 'limited'], '未来缴费计划')
    n.paidMonths = n.paymentPlan === 'all' ? n.elapsedMonths : number('paymentMonths', '未来计划缴费月数', { max: 720, integer: true })
    if (n.paidMonths !== null && n.elapsedMonths !== undefined && n.paidMonths > n.elapsedMonths) fail('paymentMonths', '计划缴费月数不能超过距退休的月数。')
    // For a zero-duration snapshot no growth assumptions are needed.
    for (const [field, label] of [['baseGrowth', '缴费基数年增长'], ['indexGrowth', '指数基准及上下限年增长'], ['pensionGrowth', '养老金计发基数年增长'], ['accountInterest', '账户年记账利率假设']]) {
      n[field] = n.elapsedMonths === 0 || (field === 'baseGrowth' && n.toolId === 'pension-calc2') ? 0 : number(field, label, { max: 20 })
    }
    n.paymentDivisor = n.retirement ? getTablePaymentMonths(n.retirement.ageMonths) : null
    n.divisorSource = '国发〔2005〕38号附件（整岁）'
    if (n.retirement && n.paymentDivisor === null && !blank(input.paymentDivisor)) {
      n.paymentDivisor = number('paymentDivisor', '地方核定计发月数', { min: 1, max: 300, integer: true })
      n.divisorSource = text('divisorSource', '非整岁计发月数的核定依据', 400)
    }
  }
  return { valid: errors.length === 0, errors, normalized: n }
}

function contributions(base, n) {
  const personalMonthly = roundPensionMoney(base * (n.toolId === 'pension-calc1' ? PERSONAL_RATE : FLEXIBLE_RATE))
  const employerMonthly = n.toolId === 'pension-calc1' && n.employerRate !== null ? roundPensionMoney(base * n.employerRate / 100) : null
  return {
    base, personalMonthly, employerMonthly, accountMonthly: roundPensionMoney(base * ACCOUNT_RATE),
    totalMonthly: roundPensionMoney(personalMonthly + (employerMonthly ?? 0)), personalAnnual: roundPensionMoney(personalMonthly * 12)
  }
}

// Smooth monthly scenario projection, explicitly not a reconstruction of historical statutory interest.
// Records are through month end. Project next month through retirement month, pay at month end.
function project(n, grade = n.grade) {
  const currentBase = n.toolId === 'pension-calc2' ? roundPensionMoney(n.indexBase * grade / 100) : n.contributionBase
  let account = n.accountBalance
  let futureIndexSum = 0
  let boundedMonths = 0
  const ledger = []
  const monthlyInterest = (1 + n.accountInterest / 100) ** (1 / 12) - 1
  for (let m = 1; m <= n.elapsedMonths; m++) {
    const date = formatMonth(n.recordIndex + m)
    const year = date.slice(0, 4)
    const growthMonths = n.mode === 'estimate' ? m - 1 : m
    const indexBase = n.indexBase * (1 + n.indexGrowth / 100) ** (growthMonths / 12)
    const lower = n.lowerBase * (1 + n.indexGrowth / 100) ** (growthMonths / 12)
    const upper = n.upperBase * (1 + n.indexGrowth / 100) ** (growthMonths / 12)
    const desired = n.toolId === 'pension-calc2' ? indexBase * grade / 100 : currentBase * (1 + n.baseGrowth / 100) ** (growthMonths / 12)
    const base = roundPensionMoney(Math.max(lower, Math.min(upper, desired)))
    const paid = m <= n.paidMonths
    const deposit = paid ? roundPensionMoney(base * ACCOUNT_RATE) : 0
    const cost = paid ? contributions(base, n).personalMonthly : 0
    if (paid) {
      futureIndexSum += base / indexBase
      if (desired < lower || desired > upper) boundedMonths++
    }
    const interest = account * monthlyInterest
    const opening = account
    account += interest + deposit
    let row = ledger[ledger.length - 1]
    if (!row || row.year !== year) {
      row = { year, from: date, to: date, months: 0, paidMonths: 0, opening, deposits: 0, interest: 0, personalCost: 0, closing: 0 }
      ledger.push(row)
    }
    row.to = date; row.months++; row.paidMonths += Number(paid)
    row.deposits += deposit; row.interest += interest; row.personalCost += cost; row.closing = account
  }
  const totalMonths = n.actualMonths + n.deemedMonths + n.paidMonths
  const unknownIndex = n.indexMethod !== 'weighted' || (n.deemedMonths > 0 && n.deemedIndex === null) || totalMonths === 0
  const averageIndex = unknownIndex ? null : ((n.historicalIndex ?? 0) * n.actualMonths + (n.deemedIndex ?? 0) * n.deemedMonths + futureIndexSum) / totalMonths
  const retirementPensionBase = roundPensionMoney(n.pensionBase * (1 + n.pensionGrowth / 100) ** (n.elapsedMonths / 12))
  const basic = averageIndex === null ? null : roundPensionMoney(retirementPensionBase * (1 + averageIndex) / 2 * totalMonths / 12 * .01)
  const personal = n.paymentDivisor === null ? null : roundPensionMoney(roundPensionMoney(account) / n.paymentDivisor)
  // Even deemed=0 does not prove there is no pre-reform contribution / transitional entitlement.
  const transitional = n.transitionStatus === 'none' && n.deemedMonths === 0 ? 0 : null
  const eligible = totalMonths >= n.retirement.minimumMonths
  const total = eligible && basic !== null && personal !== null && transitional !== null ? roundPensionMoney(basic + personal + transitional) : null
  return {
    components: { basic, personal, transitional, total },
    projection: {
      elapsedMonths: n.elapsedMonths, paidMonths: n.paidMonths, totalMonths, averageIndex,
      futureIndexSum, retirementPensionBase: roundPensionMoney(retirementPensionBase),
      accountBalance: roundPensionMoney(account), boundedMonths,
      futurePersonalCost: roundPensionMoney(ledger.reduce((sum, row) => sum + row.personalCost, 0)),
      ledger: ledger.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ['opening', 'deposits', 'interest', 'personalCost', 'closing'].includes(key) ? roundPensionMoney(value) : value])))
    }
  }
}

export function calculatePension(raw) {
  const { valid, errors, normalized: n } = validatePensionInput(raw)
  if (!valid) throw new PensionInputError(errors)
  const parameters = {
    region: n.region, source: n.parameterSource, policyFrom: formatMonth(n.policyFromIndex), policyTo: formatMonth(n.policyToIndex),
    recordMonth: formatMonth(n.recordIndex), lowerBase: n.lowerBase, upperBase: n.upperBase,
    indexBase: n.indexBase ?? null, employerRate: n.employerRate ?? null
  }
  const assumptions = [
    '仅适用于企业职工基本养老保险；无雇工个体工商户或灵活就业人员按个人参保情形计算，不包含居民养老、医保、补贴或企业年金。',
    '地方参数由本次填写的地区、政策区间和依据确定，尚未自动核验；单位成本按单个职工同一基数估算，不代替单位工资总额核定。',
    '职工个人8%、灵活就业全部20%、个人账户入账8%采用国家一般规则；特殊减免或其他缴费制度不适用本页。',
    '月缴费和入账额四舍五入至分；账户预测中间利息不逐月舍入，退休时账户余额及计发基数到分后计算待遇，待遇分项先到分再相加。此为测算精度约定，非地区经办舍入承诺。'
  ]
  const result = {
    ruleVersion: PENSION_RULE_VERSION, toolId: n.toolId, mode: n.mode, parameters, inputSnapshot: n,
    contributions: contributions(n.contributionBase, n), status: 'cost-only', pending: [],
    assumptions, sources: PENSION_SOURCES.map((source) => ({ ...source })), comparison: [],
    components: null, retirement: null, eligibility: null, projection: null
  }
  if (n.mode === 'forecast') {
    const scenario = project(n)
    Object.assign(result, scenario, { retirement: n.retirement })
    result.eligibility = {
      totalMonths: scenario.projection.totalMonths, minimumMonths: n.retirement.minimumMonths,
      thresholdYear: n.retirement.thresholdYear, shortfallMonths: Math.max(0, n.retirement.minimumMonths - scenario.projection.totalMonths),
      meetsContributionYears: scenario.projection.totalMonths >= n.retirement.minimumMonths
    }
    if (n.indexMethod !== 'weighted') result.pending.push('本地区基础公式及平均指数计算口径未核实，基础养老金暂不能计算。')
    if (n.deemedMonths > 0 && n.deemedIndex === null) result.pending.push('视同缴费指数未知，基础养老金暂不能计算；不能默认为1。')
    if (scenario.projection.totalMonths === 0) result.pending.push('累计缴费年限为0，不能计算平均指数。')
    if (n.paymentDivisor === null) result.pending.push('退休年龄不是表中整岁，须核对当地计发月数；不取整、不插值、不兜底139。')
    if (scenario.components.transitional === null) result.pending.push('过渡性养老金及其他地方待遇须按地区规则核对，本页暂未计算；视同为0也不自动排除过渡待遇。')
    if (!result.eligibility.meetsContributionYears) result.pending.push(`所选计划距最低缴费年限还差${result.eligibility.shortfallMonths}个月，分项仅供情景核对，不合成为可领取总额。`)
    result.status = !result.eligibility.meetsContributionYears ? 'ineligible' : scenario.components.total === null ? 'partial' : 'complete'
    assumptions.push(
      `记录和余额截至${parameters.recordMonth}月末；从次月起至${n.retirement.selectedMonth}退休当月预测${n.elapsedMonths}个月，其中从次月起连续缴${n.paidMonths}个月，之后停缴。`,
      `未来指数基准及上下限年增长${n.indexGrowth}%，计发基数年增长${n.pensionGrowth}%，${n.toolId === 'pension-calc1' ? `缴费基数年增长${n.baseGrowth}%` : `保持所选${n.grade}%档位`}；增长率均为用户情景假设，不是已公布的未来政策。`,
      `账户年记账利率假设${n.accountInterest}%，按等效月利率、先计息后月末入账模拟；不用于重建实际年度记账，不保证收益。`,
      '未来基数按当前上下限随指数基准平滑增长进行约束；不预测实际年度调整、补差、跨地区、任意断缴、补缴或制度转换。',
      '预测期间缴费费率和个人账户入账比例保持不变；未来政策变动、减免或补贴不在本次情景内。',
      '仅在确认地区适用按月加权指数口径时，合并历史实际指数、已核实视同指数及未来逐月指数；历史实际年限不得重复包含视同期间。',
      `最低缴费年限按${n.retirement.thresholdYear}年核对；达标只表示年限条件满足，不代表参保身份、退休手续或待遇资格已审核通过。`,
      `计发月数：${n.paymentDivisor ?? '待核对'}；依据：${n.paymentDivisor === null ? '尚未提供' : n.divisorSource}。`
    )
    if (scenario.projection.boundedMonths > 0) assumptions.push(`未来${scenario.projection.boundedMonths}个缴费月触及预测上下限，已按假设边界约束。`)
  } else {
    assumptions.push('年缴费额按当前月缴费×12计算，仅表示参数不变并缴满12个月的情景，不保证政策区间覆盖完整一年。')
  }
  if (n.toolId === 'pension-calc2') {
    const grades = [...new Set([60, 100, 200, 300, n.grade])].sort((a, b) => a - b)
    result.comparison = grades.map((grade) => {
      const base = roundPensionMoney(n.indexBase * grade / 100)
      const available = base >= n.lowerBase && base <= n.upperBase
      if (!available) return { grade, base, available: false, reason: '超出所填地区上下限', personalMonthly: null, personalAnnual: null, accountMonthly: null, total: null }
      const cost = contributions(base, n)
      const scenario = n.mode === 'forecast' ? project(n, grade) : null
      return { grade, available: true, ...cost, total: scenario?.components.total ?? null, futurePersonalCost: scenario?.projection.futurePersonalCost ?? null }
    })
    assumptions.push('60%、100%、200%、300%及当前档位是同条件比较情景，非当地可选档位清单；超出所填上下限的情景不计算。')
  }
  return result
}

// Compact mini-program-style scenario: no invented birth month, regional policy
// limits or transitional coefficients. Shares the monthly arithmetic above.
export function formatPensionDuration(months, age = false) {
  const years = Math.floor(months / 12)
  const extra = months % 12
  return `${years}${age ? '岁' : '年'}${extra ? `${extra}个月` : ''}`
}

export function validatePensionEstimate(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const errors = []
  const values = {}
  const fail = (field, message) => errors.push({ field, message })
  // Old histories retain their original year-end anchor; new forms supply it explicitly.
  const recordMonth = input.recordMonth === undefined ? `${input.referenceYear - 1}-12` : input.recordMonth
  try {
    const recordIndex = monthIndex(recordMonth)
    if (recordIndex < monthIndex('2024-12') || recordIndex > monthIndex('2099-12')) throw new RangeError()
    values.recordMonth = recordMonth
    values.referenceYear = Math.floor((recordIndex + 1) / 12)
  } catch { fail('recordMonth', '请选择有效的记录截止年月（2024年12月—2099年12月）。') }
  for (const [field, options, label] of [
    ['toolId', ['pension-calc1', 'pension-calc2'], '养老工具'],
    ['gender', ['male', 'female'], '性别']
  ]) {
    if (!options.includes(input[field])) fail(field, `请选择${label}。`)
    values[field] = input[field]
  }
  const fields = [
    ['currentAge', '年龄', 16, 70, true],
    ['currentAgeExtraMonths', '记录截止时年龄的余月', 0, 11, true],
    ['retirementAge', '预计退休年龄', 40, 70, true],
    ['retirementAgeExtraMonths', '预计退休年龄的余月', 0, 11, true],
    ['actualYears', '实际缴费年限', 0, 80, true],
    ['actualExtraMonths', '实际缴费年限的余月', 0, 11, true],
    ['deemedYears', '视同缴费年限', 0, 80, true],
    ['deemedExtraMonths', '视同缴费年限的余月', 0, 11, true],
    ['pastAvgIndex', '以前年度平均缴费工资指数', 0.01, 1000],
    ['accountBalance', '上年末个人账户储存额', 0, 10000000],
    ['localAvgWage', '参保地上年在岗职工月平均工资', 0.01, 1000000],
    ['wageGrowth', '未来在岗职工月平均工资增长率', 0, 14],
    ['accountInterest', '未来个人账户记账利率', 0, 10],
    ...(input.toolId === 'pension-calc1'
      ? [['currentMonthlyWage', '本年月缴费工资', 0.01, 1000000], ['futureWageGrowth', '未来缴费工资增长率', 0, 14]]
      : [['grade', '未来缴费档次', 0.01, 1000]])
  ]
  for (const [field, label, min, max, integer = false] of fields) {
    if (field.endsWith('ExtraMonths') && input[field] === undefined) {
      values[field] = 0
      continue
    }
    if (field === 'pastAvgIndex' && Number(input.actualYears) === 0 && Number(input.actualExtraMonths ?? 0) === 0 && !blank(input.actualYears) && blank(input[field])) {
      values[field] = null
      continue
    }
    if (blank(input[field]) || !['string', 'number'].includes(typeof input[field]) || !/^\d+(\.\d+)?$/.test(String(input[field]).trim())) {
      fail(field, `请填写${label}，已知为零才填0。`)
      continue
    }
    const value = Number(input[field])
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      fail(field, `${label}须在${min}—${max}之间${integer ? '，请填写整数；不足整年的部分填在月份栏' : ''}。`)
    } else values[field] = value
  }
  const currentMonths = values.currentAge * 12 + values.currentAgeExtraMonths
  const retirementMonths = values.retirementAge * 12 + values.retirementAgeExtraMonths
  const actualMonths = values.actualYears * 12 + values.actualExtraMonths
  const deemedMonths = values.deemedYears * 12 + values.deemedExtraMonths
  const remainingMonths = retirementMonths - currentMonths
  if (currentMonths > 70 * 12) fail('currentAge', '记录截止时年龄不能超过70岁。')
  if (retirementMonths > 70 * 12) fail('retirementAge', '预计退休年龄不能超过70岁。')
  if (remainingMonths < 0) fail('retirementAge', '预计退休年龄不能小于记录截止时年龄，请同时核对月份。')
  if (actualMonths + deemedMonths > currentMonths) fail('actualYears', '实际与视同缴费年限之和不能超过记录截止时年龄，请核对重复期间。')
  if (remainingMonths > 60 * 12) fail('retirementAge', '预测期间不能超过60年。')
  if (values.recordMonth === '2024-12' && remainingMonths === 0) fail('retirementAge', '本页适用于2025年及以后的预测，请核对记录截止年月和预计退休年龄。')
  if (actualMonths + deemedMonths + remainingMonths === 0) fail('actualYears', '累计缴费年限为0，无法测算养老金。')
  values.paymentDivisor = null
  if (values.retirementAgeExtraMonths > 0 && !blank(input.paymentDivisor)) {
    if (!/^\d+$/.test(String(input.paymentDivisor)) || Number(input.paymentDivisor) < 1 || Number(input.paymentDivisor) > 600) {
      fail('paymentDivisor', '计发月数请填写1—600之间的整数；未查询到可留空，不要自行取整或插值。')
    } else values.paymentDivisor = Number(input.paymentDivisor)
  }
  return { valid: errors.length === 0, errors, values }
}

export function calculatePensionEstimate(raw) {
  const { valid, errors, values: v } = validatePensionEstimate(raw)
  if (!valid) throw new PensionInputError(errors)
  const elapsedMonths = (v.retirementAge - v.currentAge) * 12 + v.retirementAgeExtraMonths - v.currentAgeExtraMonths
  const recordMonth = v.recordMonth
  const selectedMonth = formatMonth(monthIndex(recordMonth) + elapsedMonths)
  const thresholdYear = Number(selectedMonth.slice(0, 4))
  const n = {
    toolId: v.toolId, mode: 'estimate', recordIndex: monthIndex(recordMonth),
    indexBase: v.localAvgWage, pensionBase: v.localAvgWage,
    lowerBase: 0, upperBase: Number.POSITIVE_INFINITY,
    contributionBase: v.toolId === 'pension-calc1' ? v.currentMonthlyWage : roundPensionMoney(v.localAvgWage * v.grade / 100),
    employerRate: null, grade: v.grade,
    actualMonths: v.actualYears * 12 + v.actualExtraMonths, deemedMonths: v.deemedYears * 12 + v.deemedExtraMonths,
    historicalIndex: v.pastAvgIndex === null ? null : v.pastAvgIndex / 100, deemedIndex: null,
    indexMethod: 'weighted', transitionStatus: v.deemedYears === 0 && v.deemedExtraMonths === 0 ? 'none' : 'unknown',
    accountBalance: v.accountBalance, elapsedMonths, paidMonths: elapsedMonths,
    indexGrowth: v.wageGrowth, pensionGrowth: v.wageGrowth,
    baseGrowth: v.toolId === 'pension-calc1' ? v.futureWageGrowth : 0,
    accountInterest: v.accountInterest, paymentDivisor: v.retirementAgeExtraMonths === 0 ? getTablePaymentMonths(v.retirementAge * 12) : v.paymentDivisor,
    retirement: { minimumMonths: getMinimumContributionMonths(thresholdYear) }
  }
  const scenario = project(n)
  const meetsYears = scenario.projection.totalMonths >= n.retirement.minimumMonths
  const pending = []
  if (n.deemedMonths > 0) pending.push('你填写了视同缴费年限。还需核对当地视同缴费指数和过渡待遇，因此本次仅展示可算分项，暂不计算养老金参考合计。')
  if (n.paymentDivisor === null) pending.push('预计退休年龄包含月份，尚未填写社保口径的计发月数。可以先查看基础养老金和缴费预测，个人账户养老金及参考合计暂不计算。')
  if (!meetsYears) pending.push(`按本次预测，累计缴费${formatPensionDuration(scenario.projection.totalMonths)}，少于${thresholdYear}年一般最低缴费年限${formatPensionDuration(n.retirement.minimumMonths)}；还差${n.retirement.minimumMonths - scenario.projection.totalMonths}个月，暂不计算参考合计。实际退休方式和领取资格仍需向社保核对。`)
  const assumptions = [
    `年龄、累计缴费记录、历史平均指数和账户余额统一截至${recordMonth}月末。从次月起连续缴费${elapsedMonths}个月，情景结束年月为${selectedMonth}；该年月仅由输入年龄差推算，不是核定退休年月。`,
    '预计退休年龄由用户填写；性别仅保存基本信息，不据此自动判定退休资格或养老金系数。',
    `参保地上年工资${v.localAvgWage}元，在本次一般情景中同时用作指数基准和计发基数；未匹配地方政策，未自动核验或约束缴费基数上下限。`,
    `社平工资年增长${v.wageGrowth}%，账户年记账利率${v.accountInterest}%，${v.toolId === 'pension-calc1' ? `缴费工资年增长${v.futureWageGrowth}%` : `保持${v.grade}%缴费档次`}；均为情景假设。`,
    '使用等效月利率，先计息后月末入账；企业职工个人缴费8%，灵活就业全部缴费20%，个人账户入账8%。单位缴费不在本次结果内。',
    '平均指数按实际、视同及未来缴费期间加权；未来工资与社平工资增长不同时，未来指数逐月变化。视同指数未知时不默认为1。',
    '预测首月使用填写的工资基数，从第二个月起按年增长率折算并平滑增长；这不是当地实际年度调整或补差规则。',
    `计发月数：${n.paymentDivisor ?? '待查询'}；${v.retirementAgeExtraMonths === 0 ? '按整岁退休年龄查国家表' : '采用用户提供的社保口径，不取整、不插值'}。金额到分，基础与账户分项先舍入后相加。`,
    `以情景结束年份${thresholdYear}年作最低缴费年限参考；这不是退休或领取资格判断，弹性退休、特殊提前退休需另核对。`,
    '参考合计仅包含基础养老金及个人账户养老金，不包含过渡待遇、补贴、企业年金或其他地方待遇；有视同缴费时暂不合计。'
  ]
  return {
    ruleVersion: `${PENSION_RULE_VERSION}-simple-v2`, toolId: v.toolId, mode: 'estimate',
    inputSnapshot: v,
    parameters: { recordMonth, referenceYear: v.referenceYear, selectedMonth },
    contributions: contributions(n.contributionBase, n), ...scenario,
    eligibility: { meetsContributionYears: meetsYears, thresholdYear, minimumMonths: n.retirement.minimumMonths },
    paymentDivisor: n.paymentDivisor, pending, assumptions,
    status: pending.length ? 'partial' : 'estimated',
    sources: PENSION_SOURCES.map((source) => ({ ...source })),
    comparison: v.toolId === 'pension-calc2' ? [...new Set([60, 100, 200, 300, v.grade])].sort((a, b) => a - b).map((grade) => {
      const base = roundPensionMoney(n.indexBase * grade / 100)
      return { grade, ...contributions(base, n), total: project(n, grade).components.total }
    }) : []
  }
}
