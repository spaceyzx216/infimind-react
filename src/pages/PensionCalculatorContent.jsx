import { useRef, useState } from 'react'
import { calculatePensionEstimate, formatPensionDuration, PensionInputError } from '../utils/pension-calculator.js'
import './PensionCalculationPage.css'

const emptyForm = () => ({
  referenceYear: new Date().getFullYear(), gender: '', currentAge: '', retirementAge: '',
  recordMonth: `${new Date().getFullYear() - 1}-12`, currentAgeExtraMonths: '0', retirementAgeExtraMonths: '0',
  actualExtraMonths: '0', deemedExtraMonths: '0', paymentDivisor: '',
  actualYears: '', deemedYears: '', pastAvgIndex: '', accountBalance: '', localAvgWage: '',
  wageGrowth: '0', accountInterest: '0', currentMonthlyWage: '', futureWageGrowth: '0', grade: ''
})
const money = (value) => value === null ? '待核对' : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Field({ name, label, value, onChange, errors, unit, hint, children, type = 'number', ...props }) {
  const error = errors.find((item) => item.field === name)
  const id = `pension-${name}`
  const description = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  const control = { id, name, value, onChange: (event) => onChange(name, event.target.value), 'aria-invalid': Boolean(error), 'aria-describedby': description, ...props }
  return <div className="pension-field">
    <label htmlFor={id}>{label}</label>
    <div className="pension-input-wrap">
      {children ? <select {...control}>{children}</select> : <input {...control} type={type} autoComplete="off" step={type === 'number' ? 'any' : undefined} />}
      {unit && <span className="pension-unit">{unit}</span>}
    </div>
    {hint && <details className="pension-field-help"><summary>填写说明</summary><p id={`${id}-hint`}>{hint}</p></details>}
    {error && <small className="pension-field-error" id={`${id}-error`}>{error.message}</small>}
  </div>
}

function Duration({ label, yearName, monthName, form, onChange, errors, age = false, min = 0, max = 80, hint }) {
  return <fieldset className="pension-duration" aria-describedby={hint ? `pension-${yearName}-help` : undefined}>
    <legend>{label}</legend>
    <div className="pension-duration-inputs">
      <Field name={yearName} label={`${label}（整${age ? '岁' : '年'}）`} value={form[yearName]} onChange={onChange} errors={errors} min={min} max={max} unit={age ? '岁' : '年'} placeholder="请输入" />
      <Field name={monthName} label={`${label}（余月）`} value={form[monthName]} onChange={onChange} errors={errors} min={0} max={11} unit="个月" />
    </div>
    {hint && <details className="pension-field-help"><summary>填写说明</summary><p id={`pension-${yearName}-help`}>{hint}</p></details>}
  </fieldset>
}

function FormSection({ id, title, description, children }) {
  return <section className="pension-form-section" aria-labelledby={id}>
    <div className="pension-section-heading"><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div>
    <div className="pension-fields">{children}</div>
  </section>
}

function Result({ result, resultRef }) {
  const { contributions: cost, components, projection, inputSnapshot: input } = result
  return <section className="pension-result" ref={resultRef} tabIndex={-1} aria-labelledby="pension-result-title" data-testid="pension-result">
    <div className="pension-result-heading"><h2 id="pension-result-title">测算结果</h2><span className="pension-status">{result.pending.length ? '部分项目待核对' : '一般情景估算'}</span></div>
    <div className="pension-total"><span>{components.total === null ? '还需核对条件，暂不显示参考合计' : '预计基础＋个人账户养老金'}</span>
      {components.total !== null && <strong data-testid="pension-total">{money(components.total)}<small>元／月</small></strong>}
      <small>不含过渡性养老金、补贴及其他地方待遇。实际领取以社保经办核定为准。</small>
    </div>
    <div className="pension-result-grid">
      <div><span>基础养老金</span><strong>{money(components.basic)}{components.basic !== null && <small>元／月</small>}</strong></div>
      <div><span>个人账户养老金</span><strong>{money(components.personal)}{components.personal !== null && <small>元／月</small>}</strong></div>
      <div><span>{result.toolId === 'pension-calc1' ? '预测首月个人缴费' : '所选档次月缴费参考'}</span><strong>{money(cost.personalMonthly)}<small>元／月</small></strong></div>
    </div>
    {result.pending.length > 0 && <div className="pension-notice pension-warning"><ul>{result.pending.map((text) => <li key={text}>{text}</li>)}</ul></div>}
    <dl className="pension-facts"><div><dt>预计退休年龄</dt><dd>{formatPensionDuration(input.retirementAge * 12 + input.retirementAgeExtraMonths, true)}</dd></div><div><dt>未来连续缴费</dt><dd>{formatPensionDuration(projection.paidMonths)}</dd></div><div><dt>累计缴费年限</dt><dd>{formatPensionDuration(projection.totalMonths)}</dd></div><div><dt>首月账户入账</dt><dd>{money(cost.accountMonthly)}元</dd></div></dl>
    <p className="pension-result-note">预测期间：{result.parameters.recordMonth}月末之后至 {result.parameters.selectedMonth}。按填写年龄推算，实际退休年月及领取资格需核对。</p>
    <details className="pension-details"><summary>测算说明</summary>
    {result.comparison.length > 0 && <div><h3>缴费档次比较</h3><p>保持历史记录和其他假设不变；以下为比较情景，不代表当地实际开放的档次。</p><div className="pension-table-wrap"><table><caption className="pension-sr-only">灵活就业养老保险档位比较</caption><thead><tr><th>缴费档次</th><th>月缴费基数</th><th>全部月缴费</th><th>养老金参考合计</th></tr></thead><tbody>{result.comparison.map((row) => <tr key={row.grade} className={row.grade === input.grade ? 'pension-selected-row' : ''}><th scope="row">{row.grade}%</th><td>{money(row.base)}</td><td>{money(row.personalMonthly)}</td><td>{money(row.total)}</td></tr>)}</tbody></table></div></div>}
    <h3>分项计算过程</h3><ol className="pension-process">
      <li><strong>预测起点缴费</strong><p>月缴费基数 {money(cost.base)} × {result.toolId === 'pension-calc1' ? '8%' : '20%'} = {money(cost.personalMonthly)}元；其中个人账户入账 {money(cost.accountMonthly)}元。</p></li>
      <li><strong>缴费年限与平均指数</strong><p>实际 {formatPensionDuration(input.actualYears * 12 + input.actualExtraMonths)} + 视同 {formatPensionDuration(input.deemedYears * 12 + input.deemedExtraMonths)} + 未来 {formatPensionDuration(projection.paidMonths)} = {formatPensionDuration(projection.totalMonths)}。综合平均指数 {projection.averageIndex === null ? '待核对' : projection.averageIndex.toFixed(6)}，未来指数按缴费工资与社平工资的比值逐月计算。</p></li>
      <li><strong>基础养老金</strong><p>{components.basic === null ? '视同缴费指数尚未核对，本次暂不计算基础养老金。' : `预测计发基数 ${money(projection.retirementPensionBase)} ×（1 + 综合平均指数）÷ 2 × ${projection.totalMonths} ÷ 12 × 1% = ${money(components.basic)}元／月。`}</p></li>
      <li><strong>个人账户养老金</strong><p>{components.personal === null ? `预计账户余额 ${money(projection.accountBalance)}元；查询到计发月数后可计算个人账户养老金。` : `预计账户余额 ${money(projection.accountBalance)} ÷ 计发月数 ${result.paymentDivisor} = ${money(components.personal)}元／月。${input.retirementAgeExtraMonths > 0 ? '计发月数采用你提供的社保口径。' : '计发月数按填写的整岁退休年龄查表。'}`}</p></li>
    </ol>
    <h3>预测假设与依据</h3><ul className="pension-assumptions">{result.assumptions.map((text) => <li key={text}>{text}</li>)}</ul><ul className="pension-sources">{result.sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul></details>
  </section>
}

// The system shell can render this calculator without router, account or history UI.
export default function PensionCalculatorContent({ initialToolId = 'pension-calc1' }) {
  const [toolId, setToolId] = useState(initialToolId)
  const [form, setForm] = useState(emptyForm)
  const [errors, setErrors] = useState([])
  const [result, setResult] = useState(null)
  const [changed, setChanged] = useState(false)
  const formRef = useRef(null)
  const resultRef = useRef(null)
  const flexible = toolId === 'pension-calc2'
  const recordLabel = /^\d{4}-\d{2}$/.test(form.recordMonth) ? `${form.recordMonth.slice(0, 4)}年${Number(form.recordMonth.slice(5))}月末` : '所选月份末'
  const hasDeemed = Number(form.deemedYears) > 0 || Number(form.deemedExtraMonths) > 0
  const needsDivisor = Number(form.retirementAgeExtraMonths) > 0
  const invalidate = () => {
    if (result) setChanged(true)
    setResult(null)
    setErrors([])
  }
  const change = (name, value) => {
    invalidate()
    setForm((previous) => ({ ...previous, [name]: value, ...(name === 'recordMonth' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? { referenceYear: Number(value.slice(0, 4)) + Number(value.endsWith('-12')) } : {}) }))
  }
  const switchType = (next) => {
    if (next === toolId) return
    invalidate()
    setToolId(next)
  }
  const reset = () => { setForm(emptyForm()); setResult(null); setChanged(false); setErrors([]) }
  const submit = (event) => {
    event.preventDefault()
    try {
      setResult(calculatePensionEstimate({ ...form, toolId }))
      setErrors([])
      setChanged(false)
      requestAnimationFrame(() => { resultRef.current?.focus({ preventScroll: true }); resultRef.current?.scrollIntoView({ block: 'start' }) })
    } catch (error) {
      setResult(null)
      const next = error instanceof PensionInputError ? error.errors : [{ field: 'currentAge', message: '本次计算未完成，请核对条件后重试。' }]
      setErrors(next)
      requestAnimationFrame(() => formRef.current?.elements.namedItem(next[0].field)?.focus())
    }
  }
  const field = (name, label, options = {}) => <Field key={name} name={name} label={label} value={form[name]} onChange={change} errors={errors} {...options} />
  const duration = (yearName, monthName, label, options = {}) => <Duration label={label} yearName={yearName} monthName={monthName} form={form} onChange={change} errors={errors} {...options} />
  return <div className="pension-content">
    <fieldset className="pension-type-selector">
      <legend>参保类型</legend>
      <div className="pension-type-options">
        <button type="button" aria-pressed={!flexible} onClick={() => switchType('pension-calc1')}>企业职工</button>
        <button type="button" aria-pressed={flexible} onClick={() => switchType('pension-calc2')}>个体工商户／灵活就业人员</button>
      </div>
    </fieldset>
      <form ref={formRef} onSubmit={submit} noValidate>
        {errors.length > 0 && <div className="pension-notice pension-error" role="alert"><strong>请补充或调整以下条件</strong><ul>{errors.map((error) => <li key={error.field}><button type="button" onClick={() => formRef.current?.elements.namedItem(error.field)?.focus()}>{error.message}</button></li>)}</ul></div>}
        <FormSection id="pension-basic-heading" title="基本信息" description="先确定记录截止时间，再填写对应年龄与退休计划。">
          {field('recordMonth', '参保记录截止年月', { type: 'month', min: '2024-12', max: '2099-12', hint: `年龄、累计缴费记录及账户余额均截至${recordLabel}；之后的缴费由工具预测。` })}
          {field('gender', '性别', { children: <><option value="">请选择</option><option value="male">男</option><option value="female">女</option></> })}
          {duration('currentAge', 'currentAgeExtraMonths', '记录截止时年龄', { age: true, min: 16, max: 70, hint: '填写截止时的周岁和余月，不是今天的年龄。' })}
          {duration('retirementAge', 'retirementAgeExtraMonths', '预计退休年龄', { age: true, min: 40, max: 70, hint: '按已确认的退休计划填写，本页不自动判断退休资格。' })}
          {needsDivisor && field('paymentDivisor', '社保口径的计发月数（选填）', { unit: '个月', min: 1, max: 600, hint: '退休年龄含余月时，需向参保地社保确认。未知可留空，先查看基础养老金和缴费预测。' })}
        </FormSection>
        <FormSection id="pension-record-heading" title="缴费记录" description={`记录截至${recordLabel}，之后的缴费由工具预测。`}>
          {duration('actualYears', 'actualExtraMonths', '实际缴费年限', { hint: '按社保缴费记录累计；例如19年6个月分别填19和6。' })}
          {duration('deemedYears', 'deemedExtraMonths', '视同缴费年限', { hint: '仅填写社保认可的年限；无则两栏填0，不与实际缴费重复。' })}
          {hasDeemed && <div className="pension-inline-help pension-notice" role="status"><strong>含视同缴费年限时，本次提供分项预测</strong><p>基础养老金及参考合计需要当地视同指数等条件，本页暂不计算。仍可查看缴费预测和个人账户分项。</p></div>}
          {field('pastAvgIndex', '历史平均缴费工资指数', { unit: '%', min: 0.01, max: 1000, placeholder: '例如指数0.8，这里填80', hint: '按社保提供的平均指数填写：1填100，0.8填80；不清楚可向社保查询，勿用某一年指数代替。无实际缴费可留空。' })}
          {field('accountBalance', '截止时个人账户储存额', { unit: '元', min: 0, placeholder: '请输入社保记录中的账户余额', hint: '包含已记账利息；这是个人账户余额，不是历年全部缴费的合计。' })}
          {field('localAvgWage', `参保地${form.referenceYear - 1}年在岗职工月平均工资`, { unit: '元／月', min: 0.01, placeholder: '请输入当地公布的工资数据', hint: '按当地官方数据填写，不是本人工资。本次也用它近似计发基数；与当地实际计发口径可能有差异。' })}
        </FormSection>
        <FormSection id="pension-assumption-heading" title="预测条件" description="未来假设可自行调整，默认0表示不增长或不计未来利息。">
          {field('wageGrowth', '未来社平工资年增长率', { unit: '%／年', min: 0, max: 14, hint: '例如每年增长3%填3；不是已公布的未来政策参数。' })}
          {field('accountInterest', '未来个人账户年记账利率', { unit: '%／年', min: 0, max: 10, hint: '用于预测账户利息；0表示不计未来利息，不代表实际利率为0。' })}
        </FormSection>
        <FormSection id="pension-contribution-heading" title={flexible ? '个体工商户／灵活就业人员填写' : '企业职工填写'} description="从记录截止次月起，按以下条件连续缴费至预计退休年龄。">
          {flexible ? <>
            {field('grade', '未来缴费档次', { unit: '%', min: 0.01, max: 1000, placeholder: '例如60%档次填60', hint: '按当地允许的缴费范围填写；0.6不是60%。所选档次用于未来缴费预测。' })}
            <div className="pension-grade-help"><span>常用比较情景</span><div>{[60, 100, 200, 300].map((grade) => <button type="button" key={grade} aria-pressed={Number(form.grade) === grade} onClick={() => change('grade', String(grade))}>{grade}%</button>)}</div><small>用于同条件比较，实际能否选择以参保地规定为准。</small></div>
            {form.grade !== '' && (Number(form.grade) < 60 || Number(form.grade) > 300) && <div className="pension-inline-help pension-notice" role="status">你填写了{form.grade}%档次，超出本页常用比较区间60%—300%。请核对百分数写法及当地允许范围；本页不会自动核定档次是否有效。</div>}
          </> : <>
            {field('currentMonthlyWage', '预测起点月缴费工资', { unit: '元／月', min: 0.01, placeholder: '请输入已核定的月缴费基数', hint: '填写起点月份的社保缴费基数，不是到手工资；首月按此数计算，之后按增长假设推算。' })}
            {field('futureWageGrowth', '未来缴费工资增长率', { unit: '%／年', min: 0, max: 14 })}
          </>}
        </FormSection>
        <div className="pension-submit-row"><button type="submit" className="pension-submit">{changed ? '重新计算' : '查看测算结果'}</button><button className="pension-reset" type="button" onClick={reset}>重置条件</button><p role="status">{changed ? '条件已修改，请重新计算。' : ''}</p></div>
      </form>
      <p className="pension-form-footnote">适用于企业职工基本养老保险的一般情景预测。未自动匹配地区政策，结果不含过渡待遇及其他补贴；实际缴费范围、退休年龄和领取条件请向参保地社保核对。</p>
      {result && <Result key={toolId} result={result} resultRef={resultRef} />}
    </div>
}
