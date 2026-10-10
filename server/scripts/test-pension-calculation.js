import assert from 'node:assert/strict'
import { calculatePension, calculatePensionEstimate, PensionInputError, validatePensionEstimate, validatePensionInput } from '../../src/utils/pension-calculator.js'
import { pensionHistoryKey, readPensionHistory, writePensionHistory } from '../../src/utils/pension-history.js'
import { getStatutoryRetirement, getMinimumContributionMonths, getTablePaymentMonths, monthIndex } from '../../src/utils/pension-retirement.js'

// All monetary values and local parameters below are fictional, independent arithmetic fixtures.
const fixture = (overrides = {}) => ({
  toolId: 'pension-calc1', mode: 'forecast', region: '虚构验算地区',
  policyFrom: '2025-01', policyTo: '2025-12', recordMonth: '2025-12',
  parameterSource: '虚构验算参数；不代表地区政策', lowerBase: '4800', upperBase: '24000',
  indexBase: '8000', contributionBase: '8000', employerRate: '16', grade: '100',
  birthMonth: '1966-02', category: 'male', retirementMode: 'statutory', retirementMonth: '',
  actualYears: '19', actualExtraMonths: '0', deemedYears: '0', deemedExtraMonths: '0',
  historicalIndex: '1', deemedIndex: '', accountBalance: '90000', pensionBase: '8500',
  indexMethod: 'weighted', transitionStatus: 'none', paymentPlan: 'all', paymentMonths: '',
  baseGrowth: '0', indexGrowth: '0', pensionGrowth: '0', accountInterest: '0',
  paymentDivisor: '', divisorSource: '', ...overrides
})
let checks = 0
function check(name, test) { test(); checks++; console.log(`PASS ${name}`) }
function invalid(overrides, field) {
  const errors = validatePensionInput(fixture(overrides)).errors
  assert.ok(errors.some((error) => error.field === field), `${field}: ${JSON.stringify(errors)}`)
  assert.throws(() => calculatePension(fixture(overrides)), { name: 'PensionInputError' })
}

check('改革前、第一组、跨年和封顶的退休年月', () => {
  const cases = [
    ['1964-12', 'male', '2024-12', 0], ['1965-01', 'male', '2025-02', 1],
    ['1965-04', 'male', '2025-05', 1], ['1965-05', 'male', '2025-07', 2],
    ['1965-12', 'male', '2026-03', 3], ['1976-12', 'male', '2039-12', 36],
    ['1981-09', 'male', '2044-09', 36], ['1969-12', 'female55', '2024-12', 0],
    ['1970-01', 'female55', '2025-02', 1], ['1982-01', 'female55', '2040-01', 36],
    ['1974-12', 'female50', '2024-12', 0], ['1975-01', 'female50', '2025-02', 1],
    ['1975-02', 'female50', '2025-03', 1], ['1975-03', 'female50', '2025-05', 2],
    ['1984-12', 'female50', '2039-12', 60], ['1985-01', 'female50', '2040-01', 60]
  ]
  for (const [birth, category, month, delay] of cases) {
    const result = getStatutoryRetirement(birth, category)
    assert.equal(result.month, month); assert.equal(result.delayMonths, delay)
  }
  assert.throws(() => getStatutoryRetirement('1965-13', 'male'))
  assert.throws(() => getStatutoryRetirement('1965-01', 'unknown'))
})
check('2030—2039最低缴费年限逐年增加且封顶', () => {
  for (let year = 2025; year <= 2045; year++) {
    assert.equal(getMinimumContributionMonths(year), year <= 2029 ? 180 : Math.min(240, 180 + (year - 2029) * 6))
  }
})
check('计发月数支持完整表；非整岁不取整、不兜底139', () => {
  // Independently transcribed from the original 2005 attachment image, not the calculator table.
  const official = [233, 230, 226, 223, 220, 216, 212, 208, 204, 199, 195, 190, 185, 180, 175, 170, 164, 158, 152, 145, 139, 132, 125, 117, 109, 101, 93, 84, 75, 65, 56]
  official.forEach((months, index) => assert.equal(getTablePaymentMonths((index + 40) * 12), months))
  assert.equal(getTablePaymentMonths(50 * 12), 195)
  assert.equal(getTablePaymentMonths(55 * 12), 170)
  assert.equal(getTablePaymentMonths(60 * 12), 139)
  assert.equal(getTablePaymentMonths(61 * 12), 132)
  assert.equal(getTablePaymentMonths(62 * 12), 125)
  assert.equal(getTablePaymentMonths(63 * 12), 117)
  assert.equal(getTablePaymentMonths(60 * 12 + 1), null)
  assert.equal(getTablePaymentMonths(71 * 12), null)
})
check('独立零增长手算：6个月、加权指数、个人账户和分项合计', () => {
  // 1966-02 male: statutory 2026-06 (60y4m), explicit fictional divisor 139.
  const input = fixture({ paymentDivisor: '139', divisorSource: '虚构非整岁计发口径' })
  const result = calculatePension(input)
  assert.equal(result.retirement.selectedMonth, '2026-06')
  assert.equal(result.projection.elapsedMonths, 6)
  assert.equal(result.projection.paidMonths, 6)
  assert.equal(result.projection.accountBalance, 93840)
  assert.equal(result.projection.averageIndex, 1)
  assert.equal(result.eligibility.totalMonths, 234)
  assert.equal(result.components.basic, 1657.5) // 8500 * 1 * 19.5 * .01
  assert.equal(result.components.personal, 675.11) // 93840 / 139
  assert.equal(result.components.total, 2332.61)
  assert.equal(result.contributions.personalMonthly, 640)
  assert.equal(result.contributions.employerMonthly, 1280)
  assert.equal(result.contributions.totalMonthly, 1920)
  assert.equal(result.status, 'complete')
  assert.equal(result.projection.ledger.length, 1)
  assert.equal(result.projection.ledger[0].deposits, 3840)
  assert.deepEqual(input, fixture({ paymentDivisor: '139', divisorSource: '虚构非整岁计发口径' }))
})
check('同等条件两身份待遇一致，灵活就业全额20%与入账8%分开', () => {
  const common = { paymentDivisor: '139', divisorSource: '虚构计发口径' }
  const enterprise = calculatePension(fixture(common))
  const flexible = calculatePension(fixture({ ...common, toolId: 'pension-calc2', baseGrowth: '', employerRate: '', contributionBase: '' }))
  assert.deepEqual(enterprise.components, flexible.components)
  assert.equal(flexible.contributions.personalMonthly, 1600)
  assert.equal(flexible.contributions.accountMonthly, 640)
  assert.equal(flexible.contributions.employerMonthly, null)
  assert.equal(flexible.comparison.find((row) => row.grade === 100).total, flexible.components.total)
})
check('不同指数基准与上下限不混用，超出范围的比较档位不伪装有效', () => {
  const result = calculatePension(fixture({ mode: 'cost', toolId: 'pension-calc2', indexBase: '8433', lowerBase: '4986', upperBase: '25299' }))
  assert.equal(result.comparison.find((row) => row.grade === 60).base, 5059.8)
  const other = calculatePension(fixture({ mode: 'cost', toolId: 'pension-calc2', upperBase: '20000' }))
  assert.equal(other.comparison.find((row) => row.grade === 300).available, false)
  assert.equal(other.comparison.find((row) => row.grade === 300).total, null)
})
check('不足年限仅展示分项情景，不展示可领取总额', () => {
  const result = calculatePension(fixture({ actualYears: '1', paymentDivisor: '139', divisorSource: '虚构口径' }))
  assert.equal(result.status, 'ineligible'); assert.equal(result.components.total, null)
  assert.equal(result.eligibility.shortfallMonths, 162)
  assert.equal(typeof result.components.basic, 'number')
})
check('过渡性养老金待核对时保留缺项，视同年限不默认为指数1', () => {
  const transition = calculatePension(fixture({ transitionStatus: 'required', paymentDivisor: '139', divisorSource: '虚构口径' }))
  assert.equal(transition.status, 'partial'); assert.equal(transition.components.transitional, null)
  assert.equal(transition.components.total, null)
  const deemed = calculatePension(fixture({ deemedYears: '2', deemedIndex: '', transitionStatus: 'unknown' }))
  assert.equal(deemed.components.basic, null); assert.equal(deemed.components.total, null)
  assert.ok(deemed.pending.some((text) => text.includes('视同缴费指数')))
})
check('地方指数口径未核实和非整岁计发月数缺失只产生可算分项', () => {
  const result = calculatePension(fixture({ indexMethod: 'unconfirmed' }))
  assert.equal(result.components.basic, null); assert.equal(result.components.personal, null)
  assert.equal(result.status, 'partial'); assert.equal(result.components.total, null)
  assert.ok(result.pending.some((text) => text.includes('计发月数')))
})
check('弹性提前与延迟按不同年份检查最低年限', () => {
  const base = { birthMonth: '1970-05', actualYears: '16', recordMonth: '2029-12', policyFrom: '2029-01', policyTo: '2029-12', retirementMode: 'early', retirementMonth: '2030-05' }
  const early = calculatePension(fixture(base))
  assert.equal(early.retirement.statutoryMonth, '2031-10')
  assert.equal(early.eligibility.thresholdYear, 2030); assert.equal(early.eligibility.minimumMonths, 186)
  const late = calculatePension(fixture({ ...base, retirementMode: 'late', retirementMonth: '2034-10', paymentPlan: 'limited', paymentMonths: '0' }))
  assert.equal(late.eligibility.thresholdYear, 2031); assert.equal(late.eligibility.minimumMonths, 192)
  invalid({ ...base, retirementMonth: '2030-04' }, 'retirementMonth')
  invalid({ ...base, retirementMode: 'late', retirementMonth: '2034-11' }, 'retirementMonth')
})
check('未来缴费基数增长会同时影响指数与账户，不再沿用固定指数', () => {
  const common = { paymentDivisor: '139', divisorSource: '虚构口径' }
  const low = calculatePension(fixture(common))
  const high = calculatePension(fixture({ ...common, baseGrowth: '10' }))
  assert.ok(high.projection.averageIndex > low.projection.averageIndex)
  assert.ok(high.components.basic > low.components.basic)
  assert.ok(high.components.personal > low.components.personal)
})
check('非单位指数的独立手算，整岁退休使用117个月，无额外兜底', () => {
  const input = fixture({ birthMonth: '1981-09', recordMonth: '2043-09', policyFrom: '2043-01', policyTo: '2043-12', actualYears: '20', historicalIndex: '1.2', indexBase: '10000', contributionBase: '5000' })
  const result = calculatePension(input)
  assert.equal(result.retirement.selectedMonth, '2044-09')
  assert.equal(result.projection.elapsedMonths, 12)
  assert.equal(result.projection.accountBalance, 94800)
  assert.equal(result.inputSnapshot.paymentDivisor, 117)
  assert.ok(Math.abs(result.projection.averageIndex - 7 / 6) < 1e-12)
  assert.equal(result.components.basic, 1933.75)
  assert.equal(result.components.personal, 810.26)
  assert.equal(result.components.total, 2744.01)
  const deemed = calculatePension({ ...input, deemedYears: '1', deemedIndex: '1.5', transitionStatus: 'required' })
  assert.equal(deemed.components.basic, 2040)
  assert.equal(deemed.components.total, null)
})
check('未来基数触及边界时按明确预测约束，同时记录触及月数', () => {
  const result = calculatePension(fixture({ birthMonth: '1981-09', recordMonth: '2043-09', policyFrom: '2043-01', policyTo: '2043-12', actualYears: '20', contributionBase: '24000', baseGrowth: '20' }))
  assert.equal(result.projection.boundedMonths, 12)
  assert.equal(result.projection.accountBalance, 113040)
  assert.ok(result.assumptions.some((text) => text.includes('12个缴费月触及')))
})
check('账户利息采用明确月末入账情景，停止缴费后仍计息', () => {
  const result = calculatePension(fixture({ paymentPlan: 'limited', paymentMonths: '1', accountInterest: '12', paymentDivisor: '139', divisorSource: '虚构口径' }))
  const expected = 90000 * 1.12 ** (6 / 12) + 640 * 1.12 ** (5 / 12)
  assert.ok(Math.abs(result.projection.accountBalance - expected) < .0051)
  assert.equal(result.projection.paidMonths, 1)
  assert.equal(result.eligibility.totalMonths, 229)
})
check('退休当月记录不重复计入未来缴费；零年限不除零', () => {
  const result = calculatePension(fixture({ recordMonth: '2026-06', policyFrom: '2026-01', policyTo: '2026-12', actualYears: '0', historicalIndex: '', paymentDivisor: '139', divisorSource: '虚构口径' }))
  assert.equal(result.projection.elapsedMonths, 0)
  assert.equal(result.projection.averageIndex, null)
  assert.equal(result.components.basic, null); assert.equal(result.components.total, null)
  assert.ok(!JSON.stringify(result).includes('NaN'))
})
check('缺失不当零、拒绝负数/小数月/无穷/非法枚举/逆日期与越界', () => {
  for (const [overrides, field] of [
    [{ region: '' }, 'region'], [{ parameterSource: '' }, 'parameterSource'],
    [{ lowerBase: '' }, 'lowerBase'], [{ lowerBase: '25000' }, 'upperBase'],
    [{ accountBalance: '' }, 'accountBalance'], [{ accountBalance: '-1' }, 'accountBalance'],
    [{ accountBalance: '12.345' }, 'accountBalance'], [{ accountBalance: 'Infinity' }, 'accountBalance'],
    [{ actualYears: '1.5' }, 'actualYears'], [{ actualExtraMonths: '12' }, 'actualExtraMonths'],
    [{ category: 'unknown' }, 'category'], [{ mode: 'unknown' }, 'mode'], [{ toolId: 'medical-calculator' }, 'toolId'],
    [{ recordMonth: '2026-01' }, 'recordMonth'], [{ policyTo: '2024-12' }, 'policyTo'],
    [{ contributionBase: '25000' }, 'contributionBase'], [{ employerRate: '' }, 'employerRate'],
    [{ baseGrowth: '' }, 'baseGrowth'], [{ historicalIndex: '0' }, 'historicalIndex'],
    [{ paymentPlan: 'limited', paymentMonths: '7' }, 'paymentMonths'],
    [{ paymentDivisor: '139', divisorSource: '' }, 'divisorSource'],
    [{ recordMonth: '2026-07', policyFrom: '2026-01', policyTo: '2026-12' }, 'recordMonth']
  ]) invalid(overrides, field)
  assert.ok(validatePensionInput(fixture({ mode: 'cost', accountBalance: '', birthMonth: '' })).valid)
})
check('结果快照、规则版本、政策区间和舍入契约可追溯', () => {
  const result = calculatePension(fixture({ mode: 'cost', contributionBase: '8000.01' }))
  assert.equal(result.contributions.personalMonthly, 640)
  assert.equal(result.contributions.employerMonthly, 1280)
  assert.ok(result.ruleVersion.includes('20261009'))
  assert.equal(result.parameters.policyFrom, '2025-01')
  assert.ok(result.assumptions.some((text) => text.includes('分')))
  assert.ok(result.sources.length >= 3)
  assert.equal(monthIndex('2025-12') + 1, monthIndex('2026-01'))
})
const simpleFixture = (overrides = {}) => ({
  toolId: 'pension-calc1', referenceYear: '2026', gender: 'male', currentAge: '59', retirementAge: '60',
  actualYears: '19', deemedYears: '0', pastAvgIndex: '100', accountBalance: '90000',
  localAvgWage: '8000', wageGrowth: '0', accountInterest: '0', currentMonthlyWage: '8000',
  futureWageGrowth: '0', grade: '100', ...overrides
})
check('小程序字段独立手算：1年、100%指数、账户97680及参考合计2302.73', () => {
  const result = calculatePensionEstimate(simpleFixture())
  assert.equal(result.projection.accountBalance, 97680)
  assert.equal(result.components.basic, 1600)
  assert.equal(result.components.personal, 702.73)
  assert.equal(result.components.total, 2302.73)
  assert.equal(result.contributions.personalMonthly, 640)
  assert.equal(result.contributions.employerMonthly, null)
  assert.equal(result.parameters.recordMonth, '2025-12')
  assert.equal(result.inputSnapshot.pastAvgIndex, 100)
  assert.equal(result.paymentDivisor, 139)
})
check('简表两身份同条件待遇相同，全部缴费与账户入账分开', () => {
  const employee = calculatePensionEstimate(simpleFixture())
  const flexible = calculatePensionEstimate(simpleFixture({ toolId: 'pension-calc2' }))
  assert.deepEqual(flexible.components, employee.components)
  assert.equal(flexible.contributions.personalMonthly, 1600)
  assert.equal(flexible.contributions.accountMonthly, 640)
  assert.equal(flexible.comparison[0].grade, 60)
  assert.equal(flexible.comparison[0].personalMonthly, 960)
  // (19×1 + 1×0.6)/20 = 0.98; basic 1584,
  // account (90000 + 4800×8%×12)/139 = 680.63.
  assert.equal(flexible.comparison[0].total, 2264.63)
  const female = calculatePensionEstimate(simpleFixture({ gender: 'female' }))
  assert.deepEqual(female.components, employee.components)
})
check('简表仍拦截非法/缺项/逆年龄/零年限，有视同和不足年限不凑合计', () => {
  for (const overrides of [{ currentAge: '' }, { gender: 'other' }, { accountBalance: -1 },
    { currentAge: '61' }, { actualYears: '60' }, { wageGrowth: '15' }, { accountInterest: '11' },
    { pastAvgIndex: Infinity }, { referenceYear: 'NaN' }, { retirementAge: '60.5' },
    { currentAge: '60', actualYears: '0' }]) {
    assert.equal(validatePensionEstimate(simpleFixture(overrides)).valid, false)
    assert.throws(() => calculatePensionEstimate(simpleFixture(overrides)), PensionInputError)
  }
  assert.equal(calculatePensionEstimate(simpleFixture({ actualYears: '5' })).components.total, null)
  const deemed = calculatePensionEstimate(simpleFixture({ deemedYears: '2' }))
  assert.equal(deemed.components.basic, null)
  assert.equal(deemed.components.total, null)
  assert.equal(deemed.components.personal, 702.73)
  assert.ok(deemed.pending[0].includes('视同'))
})
check('简表未来指数随不同增长率变化，退休年龄查表不固定139', () => {
  const increased = calculatePensionEstimate(simpleFixture({ futureWageGrowth: '10' }))
  assert.ok(increased.projection.averageIndex > 1)
  assert.ok(increased.components.basic > 1600)
  assert.ok(increased.components.personal > 702.73)
  assert.equal(calculatePensionEstimate(simpleFixture({ currentAge: '61', retirementAge: '63' })).paymentDivisor, 117)
})
check('年月精度独立手算：19年6个月历史、未来6个月，基础1600和账户93840', () => {
  const result = calculatePensionEstimate(simpleFixture({ currentAgeExtraMonths: '6', actualExtraMonths: '6' }))
  assert.equal(result.projection.elapsedMonths, 6)
  assert.equal(result.projection.totalMonths, 240)
  assert.equal(result.projection.accountBalance, 93840)
  assert.equal(result.components.basic, 1600)
  assert.equal(result.components.personal, 675.11)
  assert.equal(result.components.total, 2275.11)
  assert.equal(result.parameters.selectedMonth, '2026-06')
})
check('截止年月控制起点，不重复累计已缴月份；跨2030按情景年份核对最低年限', () => {
  const result = calculatePensionEstimate(simpleFixture({ recordMonth: '2029-09', currentAgeExtraMonths: '6', actualYears: '14', actualExtraMonths: '6' }))
  assert.equal(result.parameters.referenceYear, 2029)
  assert.equal(result.parameters.selectedMonth, '2030-03')
  assert.equal(result.projection.ledger[0].from, '2029-10')
  assert.equal(result.projection.totalMonths, 180)
  assert.equal(result.eligibility.thresholdYear, 2030)
  assert.equal(result.eligibility.minimumMonths, 186)
  assert.equal(result.components.total, null)
  assert.ok(result.pending[0].includes('还差6个月'))
  const alreadyAtAge = calculatePensionEstimate(simpleFixture({ recordMonth: '2029-12', currentAge: '60', actualYears: '15' }))
  assert.equal(alreadyAtAge.projection.elapsedMonths, 0)
  assert.equal(alreadyAtAge.eligibility.thresholdYear, 2029)
  assert.equal(alreadyAtAge.eligibility.minimumMonths, 180)
})
check('起点工资不提前增长：只预测一个月时缴费640、账户90640', () => {
  const result = calculatePensionEstimate(simpleFixture({ currentAgeExtraMonths: '11', futureWageGrowth: '10' }))
  assert.equal(result.projection.elapsedMonths, 1)
  assert.equal(result.projection.futurePersonalCost, 640)
  assert.equal(result.projection.accountBalance, 90640)
})
check('非整岁退休不取整或插值；有核定计发月数可算，未知仍保留其他分项', () => {
  const raw = simpleFixture({ retirementAgeExtraMonths: '3' })
  const unknown = calculatePensionEstimate(raw)
  assert.equal(unknown.projection.elapsedMonths, 15)
  assert.equal(unknown.projection.accountBalance, 99600)
  assert.equal(unknown.components.basic, 1620)
  assert.equal(unknown.paymentDivisor, null)
  assert.equal(unknown.components.personal, null)
  assert.equal(unknown.components.total, null)
  const known = calculatePensionEstimate({ ...raw, paymentDivisor: '138' }) // fictional verified input, not policy value
  assert.equal(known.components.personal, 721.74)
  assert.equal(known.components.total, 2341.74)
  assert.equal(known.pending.length, 0)
})
check('仅有缴费余月不能省略历史指数，视同余月也不凑合计；拒绝非法余月与逆年龄', () => {
  for (const overrides of [{ currentAgeExtraMonths: '' }, { actualExtraMonths: '12' },
    { deemedExtraMonths: '-1' }, { retirementAgeExtraMonths: '1.5' }, { recordMonth: '' },
    { recordMonth: '2026-13' }, { recordMonth: '2023-12' }, { currentAge: '60', currentAgeExtraMonths: '3' },
    { currentAge: '70', currentAgeExtraMonths: '1', retirementAge: '70' },
    { actualYears: '0', actualExtraMonths: '6', pastAvgIndex: '' },
    { retirementAgeExtraMonths: '3', paymentDivisor: '139.5' }]) {
    assert.equal(validatePensionEstimate(simpleFixture(overrides)).valid, false)
  }
  const deemed = calculatePensionEstimate(simpleFixture({ deemedExtraMonths: '6' }))
  assert.equal(deemed.components.basic, null)
  assert.equal(deemed.components.total, null)
  assert.ok(deemed.pending.some((text) => text.includes('视同')))
})
const storageMap = new Map()
const storage = { getItem: (key) => storageMap.get(key) ?? null, setItem: (key, value) => storageMap.set(key, value) }
const key = pensionHistoryKey('fictional-user', 'pension-calc1')
const record = { id: 'fictional-record', title: '59岁 → 60岁 · 职工养老', updatedAt: 1000,
  form: simpleFixture(), result: calculatePensionEstimate(simpleFixture()) }
check('历史保存、恢复、删除及工具/账号分开，金额从输入复算', () => {
  assert.equal(writePensionHistory(storage, key, [record]), '')
  const read = readPensionHistory(storage, key, 'pension-calc1')
  assert.equal(read.records.length, 1)
  assert.equal(read.records[0].result.components.total, 2302.73)
  assert.equal(readPensionHistory(storage, pensionHistoryKey('other-user', 'pension-calc1'), 'pension-calc1').records.length, 0)
  assert.equal(readPensionHistory(storage, pensionHistoryKey('fictional-user', 'pension-calc2'), 'pension-calc2').records.length, 0)
  writePensionHistory(storage, key, [{ ...record, result: { ...record.result, components: { total: 999999 } } }])
  assert.equal(readPensionHistory(storage, key, 'pension-calc1').records[0].result.components.total, 2302.73)
  writePensionHistory(storage, key, [])
  assert.equal(readPensionHistory(storage, key, 'pension-calc1').records.length, 0)
})
check('历史坏JSON、非法输入和不可用存储可恢复，不跨版本默默换金额', () => {
  storage.setItem(key, '{bad')
  assert.ok(readPensionHistory(storage, key, 'pension-calc1').error)
  writePensionHistory(storage, key, [null, { ...record, form: simpleFixture({ accountBalance: '' }) },
    { ...record, result: { ruleVersion: 'older-version' } }])
  const read = readPensionHistory(storage, key, 'pension-calc1')
  assert.equal(read.records.length, 1)
  assert.equal(read.records[0].result, null)
  assert.ok(read.error)
  assert.ok(read.error.includes('填写口径已更新'))
  const denied = () => { throw new Error('SecurityError') }
  assert.ok(readPensionHistory(denied, key, 'pension-calc1').error)
  assert.ok(writePensionHistory(denied, key, [record]).includes('未能保存'))
})
console.log(JSON.stringify({ status: 'passed', checks }))
