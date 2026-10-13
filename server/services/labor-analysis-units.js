import { MAX_MODEL_OUTPUT_TOKENS } from '../../src/utils/context-budget.js'
// Request budgets belong to a work unit, rather than a whole review round.
// Calculate explicit calendar intervals instead of asking the model to count
// years. Only complete, valid dates on a contract-term line are accepted.
export function laborContractTermFacts(documents) {
  const facts = []
  const date = '(\\d{4})\\s*(?:年|[-/.])\\s*(\\d{1,2})\\s*(?:月|[-/.])\\s*(\\d{1,2})\\s*日?'
  const range = new RegExp(`${date}\\s*(?:起)?\\s*(?:至|到|—|~|～)\\s*${date}`, 'g')
  const utc = (year, month, day) => {
    const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    return value.getUTCFullYear() === Number(year) && value.getUTCMonth() === Number(month) - 1
      && value.getUTCDate() === Number(day) ? value : null
  }
  for (const document of documents) for (const line of String(document.text || '').split(/\r?\n/)) {
    if (!/合同.{0,20}(?:期限|有效期)|劳动合同.{0,12}(?:自|从)|(?:固定|无固定)期限/.test(line)) continue
    for (const match of line.matchAll(range)) {
      const start = utc(...match.slice(1, 4)); const end = utc(...match.slice(4, 7))
      if (!start || !end || end < start) continue
      const anniversary = new Date(start)
      anniversary.setUTCFullYear(start.getUTCFullYear() + 2)
      if (anniversary.getUTCMonth() !== start.getUTCMonth()) anniversary.setUTCDate(0)
      facts.push({ fileName: document.fileName, role: document.role, quote: line.trim(),
        start: start.toISOString().slice(0, 10), endInclusive: end.toISOString().slice(0, 10),
        calendarDays: (end - start) / 86400000 + 1,
        reachesTwoCalendarYears: end.getTime() + 86400000 >= anniversary.getTime() })
    }
  }
  return facts
}

export function laborReadOnlyGroupIds(groups, documents, roles) {
  let cursor = 0
  const ranges = documents.map((document) => {
    const count = String(document.text || '').split('\n').length
    const range = { start: cursor + 1, end: cursor + count, readOnly: roles.includes(document.role) }
    cursor += count + 2 // file heading plus the blank line between documents
    return range
  })
  return new Set(groups.filter((group) => ranges.some((range) => range.readOnly
    && group.lineStart <= range.end && group.lineEnd >= range.start)).map((group) => group.id))
}

// Final checks may identify an external material issue, but cannot commission
// edits to another party's contract. Repairs need an exact quote in a mutable
// generated revision; unknown targets fail rather than silently passing.
export function validateLaborRevisionCheck(payload, revisions, readOnlyIds = new Set()) {
  if (!Array.isArray(payload.conflicts)) throw unfinishedLaborOutput('最终核对缺少冲突列表')
  const byId = new Map(revisions.map((revision) => [revision.findingId, revision]))
  const conflicts = []; const reminders = []
  for (const item of payload.conflicts) {
    if (!Array.isArray(item.groupIds) || !item.groupIds.length || item.groupIds.some((id) => !byId.has(id))
      || typeof item.reason !== 'string' || !item.reason.trim()
      || !['revision', 'read_only', 'source', 'optional'].includes(item.target)) throw unfinishedLaborOutput('最终核对目标或标识不完整')
    if (item.target !== 'revision') {
      reminders.push(item.reason.trim())
      continue
    }
    if (item.groupIds.some((id) => readOnlyIds.has(id)) || typeof item.quote !== 'string' || !item.quote.trim()
      || !item.groupIds.some((id) => {
        const revision = byId.get(id)
        const text = revision.action === 'delete' ? revision.originalText : revision.rewrittenText
        return String(text || '').includes(item.quote.trim())
      })) {
      throw unfinishedLaborOutput('冲突没有定位到可修改的实际修订文字')
    }
    conflicts.push(item)
  }
  return { ...payload, conflicts, reminders }
}

export function laborPhaseOptions(taskMode, stage) {
  const mode = taskMode !== 'fast' && ['review', 'final-check'].includes(stage) ? 'thinking' : 'fast'
  return { mode, thinking: { type: mode === 'fast' ? 'disabled' : 'enabled' },
    ...(mode === 'thinking' ? { reasoningEffort: 'low' } : {}),
    // Thinking tokens share the output budget. Keep room for complete JSON;
    // page-size validation still bounds risks, and the unit deadline bounds time.
    maxTokens: MAX_MODEL_OUTPUT_TOKENS }
}

export const isRecoverableLlmError = (error) => Boolean(error?.retryable ||
  ['LLM_STREAM_READ_FAILED', 'LLM_STREAM_TIMEOUT', 'LLM_REQUEST_TIMEOUT', 'LLM_HTTP_429'].includes(error?.code) ||
  /ECONNRESET|ETIMEDOUT|terminated/.test(error?.message || ''))

export function unfinishedLaborOutput(message = '当前批次没有完整结束标记') {
  return Object.assign(new Error(message), { code: 'labor_analysis_batch_incomplete', retryable: true })
}

export async function runLaborModelUnit({ operation, mode, signal, ensureActive, emit, stage, unit, onRetry, attempts = 3, requestTimeoutMs }) {
  const timeoutMs = requestTimeoutMs || (mode === 'fast' ? 120_000 : 240_000)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ensureActive()
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let deadline
    const started = Date.now()
    const progress = { contentChars: 0, reasoningChars: 0, completed: 0, firstContentMs: null, usage: null, startedAt: started }
    const heartbeat = setInterval(() => { void Promise.resolve(emit('model.progress', { stage, unit, attempt, elapsedMs: Date.now() - started,
      contentChars: progress.contentChars, reasoningChars: progress.reasoningChars, completed: progress.completed,
      message: progress.contentChars ? '连接有数据，正在校验完整结果' : progress.reasoningChars ? '模型正在思考' : '等待模型响应' })).catch(() => {}) }, 10_000)
    heartbeat.unref?.()
    try {
      const value = await Promise.race([
        operation({ signal: controller.signal, progress, attempt, timeoutMs }),
        new Promise((_, reject) => { deadline = setTimeout(() => {
          controller.abort()
          reject(Object.assign(new Error('模型请求达到单次时间限制'), { code: 'LLM_REQUEST_TIMEOUT', retryable: true }))
        }, timeoutMs) })
      ])
      ensureActive()
      await emit('model.complete', { stage, unit, mode, attempt, elapsedMs: Date.now() - started, ...progress })
      return value
    } catch (error) {
      ensureActive()
      await emit('model.interrupted', { stage, unit, attempt, elapsedMs: Date.now() - started, code: error.code || 'request_failed',
        contentChars: progress.contentChars, reasoningChars: progress.reasoningChars, completed: progress.completed })
      if (!isRecoverableLlmError(error)) throw error
      await onRetry?.(error, attempt)
      if (attempt === attempts) {
        // The task processor must not restart a full round after this unit spent its budget.
        throw Object.assign(new Error(`当前处理批次自动重试 ${attempts} 次仍未完成，已保留完成结果。`), {
          code: 'labor_analysis_unit_exhausted', retryable: false, unitRetryExhausted: true, cause: error
        })
      }
      await emit('stage.progress', { stage, message: `当前批次连接或输出未完成，保留已校验结果，自动重试 ${attempt + 1}/${attempts}。` })
      if (error.code === 'LLM_HTTP_429') await new Promise((resolve) => {
        const timer = setTimeout(done, 1000 * attempt)
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
        signal?.addEventListener('abort', done, { once: true })
        if (signal?.aborted) done()
      })
    } finally {
      clearTimeout(deadline)
      clearInterval(heartbeat)
      controller.abort()
      signal?.removeEventListener('abort', abort)
    }
  }
}

// Unknown dependencies use the serial lane. Explicitly independent, non-overlapping
// groups can run concurrently; a shared clause or insertion anchor cannot.
export function planLaborRevisionBatches(groups, dependencyPlan) {
  const dependencies = dependencyPlan || { independentIds: [], serialIds: groups.map((group) => group.id) }
  const eligible = new Set(dependencies.independentIds || [])
  const conflicts = (left, right) => {
    if (!Number.isInteger(left.lineStart) || !Number.isInteger(right.lineStart) || left.lineStart < 0 || right.lineStart < 0) return true
    const leftEnd = Math.max(left.lineEnd ?? left.lineStart, left.clauseEnd ?? left.lineStart)
    const rightEnd = Math.max(right.lineEnd ?? right.lineStart, right.clauseEnd ?? right.lineStart)
    return left.lineStart <= rightEnd && right.lineStart <= leftEnd
  }
  const edges = dependencies.dependencies || []
  const linked = (left, right) => conflicts(left, right) || edges.some((edge) => edge.includes(left.id) && edge.includes(right.id))
  const blocked = new Set(dependencies.serialIds || [])
  for (const group of groups) if (!eligible.has(group.id) || !Number.isInteger(group.lineStart) || group.lineStart < 0) blocked.add(group.id)
  for (let i = 0; i < groups.length; i += 1) for (let j = i + 1; j < groups.length; j += 1) {
    if (linked(groups[i], groups[j])) { blocked.add(groups[i].id); blocked.add(groups[j].id) }
  }
  const serial = groups.filter((group) => blocked.has(group.id))
  const independent = groups.filter((group) => !blocked.has(group.id))
  const batches = []
  // Connected targets stay together when they fit; larger components are serial
  // and each request also receives completed revisions for consistency.
  const visited = new Set()
  let packing = []
  for (const group of serial) {
    if (visited.has(group.id)) continue
    const component = [group]
    visited.add(group.id)
    for (let index = 0; index < component.length; index += 1) for (const candidate of serial) {
      if (!visited.has(candidate.id) && linked(component[index], candidate)) { visited.add(candidate.id); component.push(candidate) }
    }
    if (packing.length + component.length > 4 && packing.length) { batches.push({ groups: packing, parallel: false }); packing = [] }
    if (component.length > 4) {
      for (let index = 0; index < component.length; index += 4) batches.push({ groups: component.slice(index, index + 4), parallel: false })
    } else packing.push(...component)
  }
  if (packing.length) batches.push({ groups: packing, parallel: false })
  for (let i = 0; i < independent.length; i += 4) batches.push({ groups: independent.slice(i, i + 4), parallel: true })
  return batches
}

export function auditLaborRevisionPositions(revisions, contractText) {
  const lines = String(contractText).split('\n')
  const conflicts = []
  const seenIds = new Set()
  const edits = []
  const compact = (value) => String(value || '').replace(/\s+/g, '')
  for (const revision of revisions) {
    const id = revision.findingId
    if (seenIds.has(id)) conflicts.push({ groupIds: [id], reason: '修订组标识重复' })
    seenIds.add(id)
    if (revision.action === 'add') {
      if (!Number.isInteger(revision.insertAfterLine) || revision.insertAfterLine < 0 || revision.insertAfterLine >= lines.length) conflicts.push({ groupIds: [id], reason: '新增条款插入位置无效' })
      continue
    }
    if (!Number.isInteger(revision.lineStart) || !Number.isInteger(revision.lineEnd) || revision.lineStart < 0 || revision.lineEnd < revision.lineStart || revision.lineEnd >= lines.length) {
      conflicts.push({ groupIds: [id], reason: '修订原文范围无效' }); continue
    }
    for (const edit of revision.localizedEdits || []) {
      const spans = edit.quoteSpans || []
      const valid = spans.length && spans.every((span) => Number.isInteger(span.line) && span.line >= revision.lineStart && span.line <= revision.lineEnd
        && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= (lines[span.line]?.length || 0))
      const extracted = valid ? spans.map((span) => lines[span.line].slice(span.start, span.end)).join('') : ''
      if (!valid || compact(extracted) !== compact(edit.targetQuote)) conflicts.push({ groupIds: [id], reason: '局部修订摘录与原文位置不一致' })
      if (edit.operation !== 'notice') edits.push({ id, spans })
    }
  }
  for (let left = 0; left < edits.length; left += 1) for (let right = left + 1; right < edits.length; right += 1) {
    const a = edits[left]; const b = edits[right]
    if (a.id !== b.id && a.spans.some((first) => b.spans.some((second) => first.line === second.line && first.start < second.end && second.start < first.end))) {
      conflicts.push({ groupIds: [a.id, b.id], reason: '不同修订组修改范围重叠，需统一方案' })
    }
  }
  return conflicts
}

// A copying-ready clause must not introduce an unapproved suggested business
// number. This is a drafting policy check, not a legal-risk grading heuristic.
export function auditLaborRevisionDefaults(revisions, contractText) {
  const source = String(contractText || '').replace(/\s+/g, '')
  return revisions.flatMap((revision) => {
    const suggestions = String(revision.rewrittenText || '').match(/建议[^。；\n）)]{0,60}(?:[0-9一二三四五六七八九十百]+)[^。；\n）)]{0,20}(?:日|天|月|年|元|%)/g) || []
    const unsupported = suggestions.filter((text) => !source.includes(text.replace(/\s+/g, '')))
    return unsupported.length ? [{ groupIds: [revision.findingId], reason: `修订条款新增了未经企业确认的数字建议：${unsupported.join('；')}。删除默认数字，保留法定条件；确需新增业务参数用____并在批注说明待确认。` }] : []
  })
}

// A process reminder does not authorize replacing an agreed monthly payment
// day with a blank. Preserve explicit valid days in a modified source range.
export function auditLaborMonthlyDates(revisions) {
  return revisions.flatMap((revision) => {
    if (revision.action !== 'modify') return []
    const original = String(revision.originalText || '').replace(/\s+/g, '')
    const rewritten = String(revision.rewrittenText || '').replace(/\s+/g, '')
    const days = [...original.matchAll(/每月(\d{1,2})日/g)].map((match) => Number(match[1])).filter((day) => day >= 1 && day <= 31)
    const missing = [...new Set(days)].filter((day) => !new RegExp(`每月0?${day}日`).test(rewritten))
    return missing.length ? [{ groupIds: [revision.findingId], reason: `修订遗漏了原文已明确的每月${missing.join('日、每月')}日安排。保留已有考勤提交和工资支付日期，不用____代替合法的已知日期；仅补充本组确有缺陷的流程。` }] : []
  })
}

// Only explicit party labels in the dispatch agreement establish this role.
// Do not infer that party A is always the agency or treat delegated assistance
// as a transfer of the using unit's statutory occupational-health duties.
export function auditLaborOccupationalResponsibilities(revisions, documents) {
  const agreements = documents.filter((document) => document.role === 'dispatch_agreement')
  const labels = [...new Set(agreements.flatMap(({ text }) => [...String(text || '').matchAll(/([甲乙丙丁]方)\s*[（(]\s*(?:劳务)?派遣(?:单位|公司)\s*[）)]/g)].map((match) => match[1])))]
  if (labels.length !== 1) return []
  const agency = labels[0]
  const pattern = new RegExp(`${agency}[^。；，,\\n]{0,12}(?:负责|承担|组织)[^。；，,\\n]{0,14}职业健康检查`, 'g')
  return revisions.flatMap((revision) => {
    const assignments = [...String(revision.rewrittenText || '').matchAll(pattern)].map((match) => match[0])
    if (!assignments.some((text) => !/委托|协助|配合/.test(text))) return []
    return [{ groupIds: [revision.findingId], reason: '修订直接将职业健康检查组织义务安排给派遣单位，未说明用工单位法定义务。依据已提供《职业病防治法》第三十五条、第八十六条，依法涉及职业病危害作业时由用工单位履行相应法定义务，派遣单位可按约配合；双方协作不转移该法定义务。未明确岗位危害时不默认存在必须检查的事实，不扩大为所有普通办公岗位均须检查。修复本组分工表述，保留合法协作与费用约定。' }]
  })
}
