import { useMemo, useRef, useState } from 'react'
import { ArrowRight, Calculator, Check, Copy, Plus, Trash2, X } from 'lucide-react'
import { useAuth } from '../components/AuthProvider'
import { calculateMedicalPeriod, describeMedicalPeriodResult, describeMedicalSegmentResult, describeMedicalInputGuidance, formatMedicalResult, prepareMedicalPeriodInput } from '../utils/medical-period-calculator.js'
import './MedicalCalculatorPage.css'

const emptySegment = () => ({ startDate: '', endDate: '', workDays: '' })
const emptyInput = () => ({
  region: '', locality: '', asOf: '', hireDate: '', totalWorkYears: '', tenYearDate: '',
  recordMode: 'intervals', leaveType: 'continuous', segments: [emptySegment()],
  summary: { firstDate: '', naturalDays: '', workDays: '' },
  historyComplete: false, specialCircumstances: false, specialNote: ''
})
const fieldId = (name) => `mp-${name.replaceAll('.', '-')}`
const todayDate = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const regionNotes = {
  shanghai: '累计天数请填病休工作日，不含休息日和法定休假日。',
  national: '病休起止日均计入，中间未病休的日期不计入。',
  other: '适用规则暂不明确时，可核对病休记录；不会借用其他地区额度。'
}

function Field({ name, label, help, hint, error, required = false, balanceNeeded = false, children }) {
  return <div className="mp-field">
    <label htmlFor={fieldId(name)}>{label}{required ? <span className="mp-required"> *</span> : <span className="mp-optional">{balanceNeeded ? '核对余额需要' : '选填'}</span>}</label>
    {children}
    <span className={hint ? 'mp-field-hint' : 'mp-sr-only'} id={`${fieldId(name)}-help`}>{hint || help}</span>
    {error && <p id={`${fieldId(name)}-error`} className="mp-field-error">{error}</p>}
  </div>
}

function Result({ result, dirty, onEdit, onCopy, onSupplement, copyText }) {
  const display = describeMedicalPeriodResult(result)
  const segments = result.segmentResults || []
  const pending = display.thirdValue === '待核对'
  const guidance = describeMedicalInputGuidance(result)
  return <section className={`mp-result${dirty ? ' mp-result-stale' : ''}`} aria-labelledby="mp-result-title">
    <header className="mp-panel-header"><h2 id="mp-result-title">测算结果</h2><div className="mp-result-actions"><button type="button" className="mp-text-button" onClick={onEdit}>修改条件</button><button type="button" className="compact-button" onClick={onCopy} disabled={dirty}><Copy size={15} />复制测算单</button></div></header>
    {dirty && <p className="mp-stale-message" role="status">条件已修改，请重新计算。上次结果暂不可复制。</p>}
    <div className="mp-result-body">
      <div className="mp-metrics">
        <div className={`mp-balance${pending ? ' mp-balance-pending' : ''}`}><span>{display.thirdLabel}</span><strong>{display.thirdValue}<small>{display.thirdUnit}</small></strong><p>{display.thirdDetail}</p></div>
        <div><span>{display.quotaLabel}</span><strong>{display.quotaValue}{typeof display.quotaValue === 'number' && <small>个月</small>}</strong></div>
        <div><span>{!result.input.historyComplete || result.records.workDays === null && result.input.region === 'shanghai' ? '已录入病休' : segments.length ? '全部录入病休' : '累计已休'}</span><strong>{display.recordValue}<small>{display.recordUnit}</small></strong>{result.input.region === 'shanghai' && result.records.workDays === null && result.records.naturalDays !== null && <p>已录入{result.records.naturalDays}自然日，病休工作日未齐</p>}</div>
      </div>
      {pending && !dirty && guidance.fields.length > 0 && <button type="button" className="mp-text-button" onClick={() => onSupplement(guidance.fields[0].field)}>补充信息</button>}
      {segments.length > 0 && <section className="mp-segment-results" aria-labelledby="mp-segment-results-title"><h3 id="mp-segment-results-title">分段结果</h3><div className="mp-segment-result-list">{segments.map((row) => {
        const segment = describeMedicalSegmentResult(result, row)
        return <article className="mp-segment-result" key={row.inputIndex} aria-label={`${segment.title}测算结果`}>
          <header><h4>{segment.title}<span>{segment.dates}</span></h4><span className="mp-period-badge">{segment.periodLabel}</span></header>
          <p className="mp-period-dates">{segment.period}</p>
          <dl className="mp-segment-values"><div><dt>基础额度</dt><dd>{segment.quota}</dd></div><div><dt>本段已休</dt><dd>{segment.recorded}</dd></div><div><dt>{result.input.region === 'shanghai' ? '截至本段累计' : '周期内累计'}</dt><dd>{segment.cumulative}</dd></div></dl>
          <div className={`mp-segment-balance${row.estimate ? '' : ' mp-segment-pending'}`}><span>{segment.balanceLabel}</span><strong>{segment.balance}</strong>{segment.balanceDetail && <p>{segment.balanceDetail}</p>}</div>
        </article>
      })}</div></section>}
      <details className="mp-result-guide"><summary>说明与依据</summary>
        <p>{display.meaning}</p><p>{display.quotaDetail}</p><p>{display.scope}</p>
        {display.referenceDetail && <p>{display.referenceDetail}</p>}
        <ul>{display.reviewReasons.filter((item) => item.code !== 'SH_MATURITY_PENDING').map((item) => <li key={item.code}>{item.message}</li>)}</ul>
        <p>医疗期届满不等于可以直接解除劳动合同。</p>
        <p>{result.rule.version} · 来源核对：{result.rule.verifiedOn}</p>
        <ul>{result.rule.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul>
      </details>
      {copyText && <div className="mp-copy-fallback"><label htmlFor="mp-copy-text">自动复制不可用，可选择全文手动复制。</label><textarea id="mp-copy-text" readOnly value={copyText} rows={8} onFocus={(event) => event.target.select()} /></div>}
    </div>
  </section>
}

export function MedicalCalculatorWorkspace() {
  const [input, setInput] = useState(emptyInput)
  const [errors, setErrors] = useState([])
  const [result, setResult] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [notice, setNotice] = useState('')
  const [copyText, setCopyText] = useState('')
  const formRef = useRef(null)
  const resultRef = useRef(null)
  const resetRef = useRef(null)
  const revision = useRef(0)
  const today = todayDate()
  const isShanghai = input.region === 'shanghai'
  const hasSupplementary = Boolean(input.locality || input.tenYearDate || input.specialCircumstances || input.specialNote || (isShanghai && input.recordMode === 'summary' && input.summary.naturalDays) || (!isShanghai && input.recordMode === 'intervals' && input.asOf))
  const errorFor = (field) => errors.find((item) => item.field === field)?.message
  const { scopePreview, needsTenYearDate } = useMemo(() => {
    const prepared = prepareMedicalPeriodInput(input)
    const candidate = calculateMedicalPeriod(prepared, { today })
    // Keep the promoted date field in place while entering or correcting its
    // value; requirement detection does not depend on that value being valid.
    const requirements = input.region === 'national' && input.tenYearDate
      ? calculateMedicalPeriod({ ...prepared, tenYearDate: '' }, { today }) : candidate
    return { scopePreview: candidate.ok ? describeMedicalPeriodResult(candidate) : null,
      needsTenYearDate: describeMedicalInputGuidance(requirements).needsTenYearDate }
  }, [input, today])

  const change = (next) => {
    revision.current++
    setInput((previous) => typeof next === 'function' ? next(previous) : next)
    setErrors([])
    setDirty(Boolean(result))
    setNotice('')
    setCopyText('')
  }
  const setField = (name, value) => change((previous) => ({ ...previous, [name]: value }))
  const setRegion = (value) => change((previous) => ({ ...previous, region: value, recordMode: value === 'shanghai' ? 'summary' : 'intervals' }))
  const setSegment = (index, name, value) => change((previous) => ({ ...previous, segments: previous.segments.map((row, rowIndex) => rowIndex === index ? { ...row, [name]: value } : row) }))
  const setSummary = (name, value) => change((previous) => ({ ...previous, summary: { ...previous.summary, [name]: value } }))
  const inputProps = (name, value, onChange, type = 'date') => ({
    name, id: fieldId(name), value, onChange: (event) => onChange(event.target.value),
    ...(type !== 'select' && type !== 'text' ? { type } : {}),
    'aria-required': ['region', 'hireDate', 'totalWorkYears'].includes(name) || name === 'summary.firstDate' && !isShanghai || name === 'asOf' && (isShanghai || input.recordMode === 'summary') || name === 'summary.naturalDays' && !isShanghai || /^segments\.\d+\.(startDate|endDate)$/.test(name),
    'aria-invalid': Boolean(errorFor(name)),
    'aria-describedby': `${fieldId(name)}-help${errorFor(name) ? ` ${fieldId(name)}-error` : ''}`,
    ...(type === 'date' ? { min: '1900-01-01', max: name === 'tenYearDate' ? '2100-12-31' : today } : {})
  })
  const focusField = (field) => {
    const element = formRef.current?.elements.namedItem(field)
    if (element && typeof element.focus === 'function') {
      let parent = element.parentElement
      while (parent && parent !== formRef.current) {
        if (parent.tagName === 'DETAILS') parent.open = true
        parent = parent.parentElement
      }
      element.focus()
      element.scrollIntoView({ block: 'center' })
    }
    else formRef.current?.scrollIntoView({ block: 'start' })
  }
  const calculate = (event) => {
    event.preventDefault()
    const next = calculateMedicalPeriod(prepareMedicalPeriodInput(input), { today })
    setNotice('')
    setCopyText('')
    if (!next.ok) {
      setErrors(next.errors)
      setDirty(Boolean(result))
      requestAnimationFrame(() => focusField(next.errors[0].field))
      return
    }
    setErrors([])
    setResult(next)
    setDirty(false)
    setCollapsed(true)
    requestAnimationFrame(() => { resultRef.current?.scrollIntoView({ block: 'start' }); resultRef.current?.focus({ preventScroll: true }) })
  }
  const reset = () => {
    revision.current++
    setInput(emptyInput()); setResult(null); setErrors([]); setDirty(false); setCollapsed(false)
    setNotice(''); setCopyText('')
    resetRef.current?.close()
    requestAnimationFrame(() => {
      formRef.current?.querySelectorAll('details').forEach((element) => { element.open = false })
      formRef.current?.elements.namedItem('region')?.focus()
    })
  }
  const requestReset = () => {
    if (JSON.stringify(input) === JSON.stringify(emptyInput()) && !result) reset()
    else resetRef.current?.showModal()
  }
  const edit = () => { setCollapsed(false); requestAnimationFrame(() => formRef.current?.elements.namedItem('region')?.focus()) }
  const supplement = (field) => { setCollapsed(false); requestAnimationFrame(() => focusField(field)) }
  const copy = async () => {
    if (!result || dirty) return
    const version = revision.current
    const text = formatMedicalResult(result)
    try {
      await navigator.clipboard.writeText(text)
      if (revision.current === version) setNotice('已复制测算条件、结果及待核对事项。')
    } catch {
      if (revision.current === version) { setCopyText(text); setNotice('自动复制不可用，请在结果下方选择全文复制。') }
    }
  }

  return <>
    <main className="medical-calculator">
      <header className="mp-page-heading"><h1>员工医疗期测算</h1><button type="button" className="mp-text-button" onClick={requestReset}>新建测算</button></header>
      <div className="mp-page">
        <section className="mp-parameters" aria-labelledby="mp-parameter-title">
          <header className="mp-panel-header"><div><h2 id="mp-parameter-title">测算条件</h2></div>{collapsed && <button type="button" className="mp-text-button" onClick={edit}>编辑条件</button>}</header>
          {collapsed && result && <div className="mp-condition-summary"><span>{result.regionLabel}</span><span>入职 {result.input.hireDate}</span>{result.input.region === 'national' && <span>累计工作{result.input.totalWorkYears}年</span>}<span>截止 {result.input.asOf}</span><span>{result.records.precision === 'summary' ? '汇总记录' : `${result.records.rows.length}段日期记录`}</span></div>}
          <form ref={formRef} noValidate onSubmit={calculate} hidden={collapsed}>
            <fieldset className="mp-region-fields"><legend>适用规则</legend><div className="mp-region-grid">
              <Field name="region" label="适用地区" help="按劳动关系适用地区选择。" error={errorFor('region')} required><select {...inputProps('region', input.region, setRegion, 'select')}><option value="">请选择适用地区</option><option value="national">全国（非上海）</option><option value="shanghai">上海</option></select></Field>

            </div></fieldset>
            <fieldset className="mp-basic-fields"><legend>工作年限</legend><div className="mp-field-grid">
              <Field name="hireDate" label="本单位入职日期" help="填写本单位工作年限的起点。" error={errorFor('hireDate')} required><input {...inputProps('hireDate', input.hireDate, (value) => setField('hireDate', value))} /></Field>
              {input.region === 'national' && <Field name="totalWorkYears" label="累计工龄（最早病休开始日）" hint="填当时已满年数，包含以前单位工龄。" help={`按最早一段病休开始日填写，含以前单位工作年限${scopePreview ? `；参考起点${scopePreview.referenceDate || '待核对'}` : ''}。`} error={errorFor('totalWorkYears')} required><div className="mp-unit-input"><input {...inputProps('totalWorkYears', input.totalWorkYears, (value) => setField('totalWorkYears', value), 'number')} min="0" max="80" step="1" placeholder="已满年数" /><span>年</span></div></Field>}
              {input.region === 'national' && needsTenYearDate && <Field name="tenYearDate" label="累计工龄满10年的日期" hint="期间可能满10年；日期未知仍可统计天数。" help="病休期间可能跨10年，核对余额需要具体日期；未知仍可统计已休天数。" error={errorFor('tenYearDate')} balanceNeeded><input {...inputProps('tenYearDate', input.tenYearDate, (value) => setField('tenYearDate', value))} /></Field>}
              {(isShanghai || input.recordMode === 'summary') && <Field name="asOf" label="计算截止日期" help="填写要统计到哪一天。" error={errorFor('asOf')} required><input {...inputProps('asOf', input.asOf, (value) => setField('asOf', value))} /></Field>}
            </div></fieldset>
            <fieldset className={`mp-record-fields${isShanghai && input.recordMode === 'summary' ? ' mp-record-summary' : ''}`}>
              <legend>病休记录</legend>
              {input.region === 'national' && <div className="mp-record-mode"><span>录入方式</span><div className="mp-choice" role="group" aria-label="病休记录方式"><button type="button" aria-pressed={input.recordMode === 'intervals'} onClick={() => setField('recordMode', 'intervals')}>有实际日期段</button><button type="button" aria-pressed={input.recordMode === 'summary'} onClick={() => setField('recordMode', 'summary')}>只有首日与累计量</button></div></div>}
              {isShanghai && input.recordMode === 'summary' && <div className="mp-field-grid">
                {isShanghai && input.recordMode === 'summary' && <Field name="summary.workDays" label="累计病休工作日" hint="填本单位考勤累计量，不含休息日和法定休假日。" help="按本单位实际考勤累计，未知不要填0。" error={errorFor('summary.workDays')} balanceNeeded><div className="mp-unit-input"><input {...inputProps('summary.workDays', input.summary.workDays, (value) => setSummary('workDays', value), 'number')} min="0" step="0.01" placeholder="例如：20" /><span>天</span></div></Field>}
              {isShanghai && input.recordMode === 'summary' && <Field name="summary.firstDate" label="本单位首次病休日期" hint="用于核对年限，不表示此后一直病休。" help="核对首次病休时的年限；未知仍可统计已提供的工作日，暂不给余额。" error={errorFor('summary.firstDate')} balanceNeeded><input {...inputProps('summary.firstDate', input.summary.firstDate, (value) => setSummary('firstDate', value))} /></Field>}
              </div>}
              {isShanghai && <div className="mp-record-heading"><span>{input.recordMode === 'summary' ? '需要逐段核对？' : '有考勤汇总量？'}</span><button type="button" className="mp-text-button" onClick={() => setField('recordMode', input.recordMode === 'summary' ? 'intervals' : 'summary')}>{input.recordMode === 'summary' ? '填写实际日期段' : '填写累计工作日'}</button></div>}
              {input.recordMode === 'intervals' ? <>
                <div className="mp-record-type"><span>病休类型</span><div className="mp-choice mp-choice-secondary" role="group" aria-label="病休类型"><button type="button" aria-pressed={input.leaveType === 'continuous'} disabled={input.segments.length > 1} onClick={() => setField('leaveType', 'continuous')}>连续病休</button><button type="button" aria-pressed={input.leaveType === 'segmented'} onClick={() => setField('leaveType', 'segmented')}>非连续分段</button></div>{!isShanghai && <p className="mp-field-help">起止日均计入，休息日和节假日计入；未病休的间隔不计。</p>}</div>
                {input.segments.map((row, index) => <div className={`mp-segment${input.leaveType === 'continuous' ? ' mp-segment-single' : ''}`} key={index}>{input.leaveType === 'segmented' && <div className="mp-segment-heading"><strong>第{index + 1}段病休</strong>{input.segments.length > 1 && <button type="button" className="mp-text-button" aria-label={`移除第${index + 1}段病休`} onClick={() => change((previous) => ({ ...previous, segments: previous.segments.filter((_, rowIndex) => rowIndex !== index) }))}><Trash2 size={14} />移除此段</button>}</div>}<div className={`mp-field-grid${isShanghai ? ' mp-three-fields' : ''}`}>
                  <Field name={`segments.${index}.startDate`} label="开始日期" help="本段实际病休的第一天，包含当天。" error={errorFor(`segments.${index}.startDate`)} required><input {...inputProps(`segments.${index}.startDate`, row.startDate, (value) => setSegment(index, 'startDate', value))} /></Field>
                  <Field name={`segments.${index}.endDate`} label="结束日期" help="本段实际病休的最后一天。" error={errorFor(`segments.${index}.endDate`)} required><input {...inputProps(`segments.${index}.endDate`, row.endDate, (value) => setSegment(index, 'endDate', value))} /></Field>
                  {isShanghai && <Field name={`segments.${index}.workDays`} label="实际病休工作日" hint="按本段考勤填写，不能用起止日期直接推算。" help="按考勤填写；未知保留自然日统计，暂不给工作日余额。" error={errorFor(`segments.${index}.workDays`)} balanceNeeded><div className="mp-unit-input"><input {...inputProps(`segments.${index}.workDays`, row.workDays, (value) => setSegment(index, 'workDays', value), 'number')} min="0" step="0.01" placeholder="考勤天数" /><span>天</span></div></Field>}
                </div></div>)}
                {input.leaveType === 'segmented' && <button type="button" className="mp-add-button" onClick={() => change((previous) => ({ ...previous, segments: [...previous.segments, emptySegment()] }))}><Plus size={16} />添加一段病休</button>}
              </> : !isShanghai && <><p className="mp-field-help">仅记录汇总量，不补成连续病休。</p><div className="mp-field-grid">
                <Field name="summary.firstDate" label="本次核算起算病休日" help="填写本次累计期间的起点，需与相关病休历史一致。" error={errorFor('summary.firstDate')} required><input {...inputProps('summary.firstDate', input.summary.firstDate, (value) => setSummary('firstDate', value))} /></Field>
                <Field name="summary.naturalDays" label="累计病休自然日" help="填写原始资料中的实际累计量，不包括中间未病休的日期。" error={errorFor('summary.naturalDays')} required><div className="mp-unit-input"><input {...inputProps('summary.naturalDays', input.summary.naturalDays, (value) => setSummary('naturalDays', value), 'number')} min="1" step="1" /><span>天</span></div></Field>
              </div></>}
              {errorFor('segments') && <p className="mp-field-error">{errorFor('segments')}</p>}
              <label className="mp-check"><input type="checkbox" name="historyComplete" checked={input.historyComplete} aria-invalid={Boolean(errorFor('historyComplete'))} aria-describedby="mp-history-complete-help" onChange={(event) => setField('historyComplete', event.target.checked)} /><span>{isShanghai ? '已包含本单位期间的全部病休工作日' : '已录入核算范围内的全部病休'}<small className="mp-sr-only" id="mp-history-complete-help">{isShanghai ? '累计工作日应包含以前病休；未勾选时仍统计已录入量，不给余额。' : '如果此前还有影响本次核算的病休，请补充日期；不确定是否齐全时先不勾选。'}</small></span></label>
              {errorFor('historyComplete') && <p className="mp-field-error">{errorFor('historyComplete')}</p>}
            </fieldset>
            <details className="mp-supplementary"><summary>补充核对信息<span>{hasSupplementary ? '已补充' : ''}</span></summary><div>
              <div className="mp-field-grid">
                {input.region === 'national' && <Field name="locality" label="具体省市（备注）" hint="仅作备注，不会切换地方规则。" help="仅作为地区备注，不会自动切换地方计算规则。"><input {...inputProps('locality', input.locality, (value) => setField('locality', value), 'text')} maxLength={100} placeholder="例如：浙江省杭州市" /></Field>}
                {!isShanghai && input.recordMode === 'intervals' && <Field name="asOf" label="病休统计截止日" hint="留空取最晚一段病休结束日。" help="默认取最晚一段结束日，需要其他统计日期再填写。" error={errorFor('asOf')}><input {...inputProps('asOf', input.asOf, (value) => setField('asOf', value))} /></Field>}
                {input.region === 'national' && !needsTenYearDate && <Field name="tenYearDate" label="累计工龄满10年的日期" help="用于核对病休期间跨档，未知可留空。" error={errorFor('tenYearDate')}><input {...inputProps('tenYearDate', input.tenYearDate, (value) => setField('tenYearDate', value))} /></Field>}
                {isShanghai && input.recordMode === 'summary' && <>
                  <Field name="summary.naturalDays" label="累计病休自然日" help="有自然日汇总资料再填，不用工作日倒推。" error={errorFor('summary.naturalDays')}><div className="mp-unit-input"><input {...inputProps('summary.naturalDays', input.summary.naturalDays, (value) => setSummary('naturalDays', value), 'number')} min="1" step="1" /><span>天</span></div></Field>
                </>}
              </div>
              <details className="mp-exceptions"><summary>特殊情况与延长约定</summary><div><label className="mp-check"><input type="checkbox" name="specialCircumstances" checked={input.specialCircumstances} onChange={(event) => setField('specialCircumstances', event.target.checked)} /><span>涉及特殊疾病、劳动能力鉴定、延长审批或更长约定<small>只展示基础参考与记录统计，延长期限交人工核对。</small></span></label><p className="mp-field-help">因工负伤、职业病涉及其他规则，请另行核对。</p></div></details>
              <Field name="specialNote" label="备注（不影响计算）" help="仅记录备注，不改变计算；特殊情况需单独勾选，无需填写姓名、联系方式或诊断隐私。"><textarea {...inputProps('specialNote', input.specialNote, (value) => setField('specialNote', value), 'text')} rows={2} maxLength={1000} /></Field>
            </div></details>
            <details className="mp-form-guide"><summary>更多说明与适用条件</summary>{scopePreview && <p>{scopePreview.scope}</p>}{isShanghai ? <p>本单位的考勤累计量应包括此前病休。首次日期和统计截止日标明核对范围，不表示期间连续病休；工作日不能从自然日或仅扣除周末推算。余额按20.67工作日/月折算。</p> : input.region === 'national' ? <><p>工龄按最早病休开始日核对，不能用今天的工龄代替。{input.recordMode === 'summary' && '汇总量没有实际日期分布，只统计记录，不给周期余额。'}</p><p>日历参考预算从本周期首个病休日起，加上基础额度月数，按实际日期天数扣减。含起点，不含下一对应日；目标月无对应日时取月末。同周期各段共用预算；地方口径、周期重启及跨档调整仍待核对，该换算区间不是届满日期。</p></> : <p>{regionNotes[input.region] || '选择员工劳动关系适用地区，填写本单位入职日期与病休记录。'}</p>}<p>记录完整性未确认时只展示已录入量，不给余额。医疗期是停工治病期间的劳动合同保护期限，实际病休以医疗证明为准。</p></details>
            {errors.length > 0 && <div className="mp-error-banner" role="alert"><strong>请核对以下条件，输入已保留：</strong><ul>{errors.map((item, index) => <li key={`${item.field}-${index}`}><button type="button" onClick={() => focusField(item.field)}>{item.message}</button></li>)}</ul></div>}
            <footer className="mp-form-actions"><button type="button" className="mp-text-button" onClick={requestReset}>清空条件</button><span>{dirty ? '条件已修改，请重新计算' : ''}</span><button type="submit" className="mp-primary"><Calculator size={17} />{dirty ? '重新计算' : '开始测算'}<ArrowRight size={16} /></button></footer>
          </form>
        </section>
        {notice && <p className="mp-notice" role="status"><Check size={16} />{notice}</p>}
        {result && <div ref={resultRef} tabIndex={-1} className="mp-result-container"><Result key={revision.current} result={result} dirty={dirty} onEdit={edit} onCopy={copy} onSupplement={supplement} copyText={copyText} /></div>}
      </div>
    </main>
    <dialog ref={resetRef} className="mp-reset-dialog" aria-labelledby="mp-reset-title"><div><h2 id="mp-reset-title">清空当前测算条件？</h2><button type="button" className="icon-button" aria-label="关闭清空确认" onClick={() => resetRef.current?.close()}><X size={18} /></button></div><p>当前填写的条件和测算结果将清空。</p><footer><button type="button" className="compact-button" onClick={() => resetRef.current?.close()}>取消</button><button type="button" className="mp-primary" onClick={reset}>清空条件</button></footer></dialog>
  </>
}

export default function MedicalCalculatorPage() {
  const { user } = useAuth()
  return user?.id === undefined || user?.id === null ? null : <MedicalCalculatorWorkspace key={user.id} />
}
