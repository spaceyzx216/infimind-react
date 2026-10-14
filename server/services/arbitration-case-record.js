import { createHash } from 'node:crypto'

export const list = (value) => Array.isArray(value) ? value : []
export const str = (value) => typeof value === 'string' ? value.trim() : ''
export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const clean = (value) => str(value).replace(/\s+/g, '')

// Text stays in the existing source checkpoint. Snapshots contain cited excerpts,
// identities and hashes, not another copy of every uploaded document.
export function buildCaseSources(documents, userMessages) {
  const sources = documents.map((doc) => ({
    id: `file:${doc.fileId || hash([doc.sourceTaskId, doc.fileName]).slice(0, 20)}`,
    kind: 'document', fileId: doc.fileId || '', taskId: doc.sourceTaskId || '',
    name: doc.fileName, text: str(doc.text), partial: Boolean(doc.partial || doc.truncated),
    originalText: str(doc.originalText || doc.text)
  }))
  for (const message of userMessages) if (str(message.content)) sources.push({
    id: `user:${message.taskId}`, kind: 'company_statement', taskId: message.taskId,
    name: '企业用户陈述', text: str(message.content), originalText: str(message.content), partial: false
  })
  return [...new Map(sources.map((source) => [source.id, source])).values()]
}

export function materialSignature(sources, excludedFileIds = []) {
  return hash({ files: sources.filter((source) => source.kind === 'document').map((source) => ({
    id: source.id, digest: hash(source.originalText), partial: source.partial
  })).sort((a, b) => a.id.localeCompare(b.id)), excluded: [...excludedFileIds].sort() })
}

export function affectedRequestIds(record, previous, previousClaims = []) {
  if (!previous || hash([record.caseInfo, record.conflicts, record.region, record.relevantDate]) !== hash([previous.caseInfo, previous.conflicts, previous.region, previous.relevantDate])) return record.requests.map((request) => request.id)
  const changedDocuments = record.sources.filter((source) => source.kind === 'document'
    && previous.sources.find((old) => old.id === source.id)?.digest !== source.digest)
  // A newly read document without a reliable request association cannot be
  // declared irrelevant just because extraction omitted it. Reanalyse all.
  if (changedDocuments.some((source) => !record.requests.some((request) => request.sources.some((ref) => ref.located && ref.sourceId === source.id))
    && !record.facts.some((fact) => fact.kind !== 'unknown' && fact.requestIds.length && fact.sources.some((ref) => ref.located && ref.sourceId === source.id)))) return record.requests.map((request) => request.id)
  const dependencies = (snapshot, request) => {
    const facts = snapshot.facts.filter((fact) => !fact.requestIds.length || fact.requestIds.includes(request.id))
    const sourceIds = new Set([...request.sources, ...facts.flatMap((fact) => fact.sources)].map((ref) => ref.sourceId))
    for (const id of list(previousClaims.find((claim) => claim.requestId === request.id)?.sourceIds)) sourceIds.add(id)
    return { text: request.text, subitems: request.subitems, sources: request.sources, facts,
      documents: snapshot.sources.filter((source) => sourceIds.has(source.id)).map((source) => [source.id, source.digest]) }
  }
  return record.requests.filter((request) => {
    const prior = previous.requests.find((item) => item.id === request.id)
    return !prior || hash(dependencies(record, request)) !== hash(dependencies(previous, prior))
  }).map((request) => request.id)
}

export function calculationIssues(calculations) {
  const issues = []
  for (const calculation of list(calculations)) {
    if (!calculation || typeof calculation !== 'object') { issues.push('金额算式格式无效'); continue }
    const numbers = list(calculation.operands)
    if (!numbers.length || !numbers.every((value) => typeof value === 'number' && Number.isFinite(value)) || typeof calculation.result !== 'number' || !Number.isFinite(calculation.result)) { issues.push('金额算式缺少有效数值'); continue }
    const computed = calculation.operation === 'sum' ? numbers.reduce((n, value) => n + value, 0)
      : calculation.operation === 'difference' && numbers.length === 2 ? numbers[0] - numbers[1]
        : calculation.operation === 'product' ? numbers.reduce((n, value) => n * value, 1)
          : calculation.operation === 'quotient' && numbers.length === 2 && numbers[1] !== 0 ? numbers[0] / numbers[1] : NaN
    if (!Number.isFinite(computed) || Math.abs(computed - calculation.result) > 0.011) issues.push(`金额计算错误：${str(calculation.purpose) || '待核对算式'}`)
  }
  return issues
}

// Parse only numeric arithmetic; never eval model text or determine legal bases.
export function inlineArithmeticIssues(value) {
  const issues = []
  const visit = (item, key = '') => {
    if (['sources', 'facts', 'caseInfo', 'references', 'retrievalSnapshot', 'caseRecord'].includes(key)) return
    if (Array.isArray(item)) { item.forEach((child) => visit(child)); return }
    if (item && typeof item === 'object') { Object.entries(item).forEach(([name, child]) => visit(child, name)); return }
    if (typeof item !== 'string' || /(?:原文|原意见|参考意见|主张|声称|单方)[^。\n]*(?:有误|待核|错误|不能确认)/.test(item)) return
    for (const match of item.matchAll(/((?:\d+(?:\.\d+)?\s*)(?:[+\-×÷*/]\s*\d+(?:\.\d+)?\s*)+)\s*[=＝]\s*(-?\d+(?:\.\d+)?)/g)) {
      const tokens = match[1].replace(/×/g, '*').replace(/÷/g, '/').match(/\d+(?:\.\d+)?|[+\-*/]/g)
      const terms = [Number(tokens[0])], operators = []
      for (let i = 1; i < tokens.length; i += 2) {
        const op = tokens[i], number = Number(tokens[i + 1])
        if (op === '*' || op === '/') terms[terms.length - 1] = op === '*' ? terms.at(-1) * number : terms.at(-1) / number
        else { operators.push(op); terms.push(number) }
      }
      const computed = terms.slice(1).reduce((sum, number, index) => operators[index] === '+' ? sum + number : sum - number, terms[0])
      if (!Number.isFinite(computed) || Math.abs(computed - Number(match[2])) > 0.011) issues.push(`正文金额算术错误：${match[0]}`)
    }
  }
  visit(value)
  return issues
}

export function locateCitation(citation, sources) {
  const source = sources.find((item) => item.id === citation?.sourceId)
  const quote = str(citation?.quote).slice(0, 1200)
  // A guess from a non-sent portion is not a valid citation.
  const locate = (text, excerpt) => {
    const direct = text.indexOf(excerpt)
    if (direct >= 0) return { offset: direct, end: direct + excerpt.length }
    const compact = text.replace(/\s/g, ''), needle = excerpt.replace(/\s/g, '')
    const index = needle ? compact.indexOf(needle) : -1
    if (index < 0) return { offset: -1, end: -1 }
    let position = 0, offset = -1
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue
      if (position === index) offset = i
      position++
      if (position === index + needle.length) return { offset, end: i + 1 }
    }
    return { offset: -1, end: -1 }
  }
  const visible = source && quote ? locate(source.text, quote) : { offset: -1 }
  const located = visible.offset >= 0 ? locate(source.originalText, quote) : { offset: -1, end: -1 }
  const offset = located.offset
  return {
    sourceId: str(citation?.sourceId), quote: offset >= 0 ? source.originalText.slice(offset, located.end) : quote, located: offset >= 0,
    sourceName: source?.name || '来源未定位', sourceKind: source?.kind || 'unknown',
    fileId: source?.fileId || '', taskId: source?.taskId || '',
    offset,
    line: offset >= 0 ? source.originalText.slice(0, offset).split('\n').length : null
  }
}

export function normalizeCaseRecord(raw, sources, previous, { taskId, materialHash }) {
  const issues = []
  const citations = (items) => list(items).map((item) => locateCitation(item, sources))
  const previousRequests = list(previous?.requests)
  const usedIds = new Set()
  const requests = list(raw.requests).filter((item) => str(item?.text)).map((item, index) => {
    const refs = citations(item.sources)
    if (!refs.some((ref) => ref.located)) issues.push(`请求未能对应已读取原文：${str(item.text).slice(0, 60)}`)
    const prior = previousRequests.find((request) => request.id === item.previousRequestId)
      || previousRequests.find((request) => clean(request.text) === clean(item.text))
    const id = prior && !usedIds.has(prior.id) ? prior.id : `r-${hash([taskId, index, item.text]).slice(0, 16)}`
    usedIds.add(id)
    return { id, text: str(item.text), subitems: list(item.subitems).map(str).filter(Boolean), sources: refs,
      supersedes: list(item.supersedes).filter((oldId) => previousRequests.some((request) => request.id === oldId)) }
  })
  const facts = list(raw.facts).filter((fact) => str(fact?.text)).map((fact, index) => {
    const refs = citations(fact.sources)
    const kinds = ['applicant_statement', 'company_statement', 'document_record', 'unknown']
    let kind = kinds.includes(fact.kind) ? fact.kind : 'unknown'
    if (!refs.some((ref) => ref.located)) kind = 'unknown'
    if (refs.some((ref) => ref.sourceKind === 'company_statement') && kind === 'document_record') kind = 'company_statement'
    return { id: `f-${hash([fact.text, refs.map((ref) => ref.sourceId)]).slice(0, 16)}`,
      text: str(fact.text), kind, sources: refs, requestIds: list(fact.requestIndexes).map((i) => requests[Number(i)]?.id).filter(Boolean), order: index }
  })
  const caseInfo = list(raw.caseInfo).filter((item) => str(item?.label)).map((item) => {
    const refs = citations(item.sources)
    const located = refs.filter((ref) => ref.located)
    return { label: str(item.label), value: str(item.value) || '待核实', sources: refs,
      status: located.length ? 'claimed' : 'unknown', source: located.map((ref) => `${ref.sourceName}${ref.line ? `第${ref.line}行` : ''}`).join('；') }
  })
  const infoValue = (label, proposed) => caseInfo.some((item) => item.label.includes(label) && clean(item.value) === clean(proposed) && item.sources.some((ref) => ref.located)) ? str(proposed) : ''
  const record = {
    schemaVersion: 2, version: (Number(previous?.version) || 0) + 1, taskId, materialSignature: materialHash,
    requests, facts, caseInfo, region: infoValue('地区', raw.region), relevantDate: infoValue('日期', raw.relevantDate),
    conflicts: list(raw.conflicts).map(str).filter(Boolean),
    relation: ['same', 'uncertain', 'different'].includes(raw.relation) ? raw.relation : 'uncertain',
    excludedSourceIds: list(raw.excludedSourceIds).filter((id) => sources.some((source) => source.id === id)),
    followUpQuestions: list(raw.followUpQuestions).map(str).filter(Boolean).slice(0, 3),
    sources: sources.map(({ text, originalText, ...source }) => ({ ...source, digest: hash(originalText) }))
  }
  if (record.relation !== 'same' && requests.length) issues.push('案件归属尚未澄清，不能合并请求和生成本案结论')
  const validIds = new Set(record.sources.filter((source) => !record.excludedSourceIds.includes(source.id)).map((source) => source.id))
  for (const request of requests) if (!request.sources.some((ref) => ref.located && validIds.has(ref.sourceId))) issues.push('请求仅来自待澄清或排除的材料')
  return { record, issues }
}

// 纯文本问答（没有任何上传文件）时，模型容易把企业聊天陈述写成“已上传证据”。
// 直接判失败会让整个案件分析报错，且重试往往仍然照抄；但也不能放任它把聊天陈述
// 说成已上传材料。这里先降级为“拟补充”，保持结论诚实，再由校验继续检查其它问题。
export function downgradeUnavailableEvidence(result, record) {
  const knownSources = new Map(list(record?.sources).map((source) => [source.id, source]))
  const documents = new Set([...knownSources.values()]
    .filter((source) => source.kind === 'document' && !list(record.excludedSourceIds).includes(source.id))
    .map((source) => source.id))
  const notes = []
  for (const claim of list(result?.claims)) {
    if (!claim || typeof claim !== 'object') continue
    for (const item of list(claim.evidence)) {
      if (!item || typeof item !== 'object' || item.status !== 'uploaded') continue
      if (documents.has(item.sourceId)) continue
      const source = knownSources.get(item.sourceId)
      // 只降级“来源真实存在、但不是上传文件”的情形（例如企业聊天陈述）。
      // 编造出来的 sourceId 属于无依据引用，仍交给校验判失败，不能靠降级掩盖。
      if (!source || source.kind === 'document') continue
      item.status = 'proposed'
      notes.push(`${str(item.name) || '未命名证据'}降级为“拟补充”：${source.kind === 'company_statement' ? '企业聊天陈述不是上传文件' : '本轮没有对应的上传文件'}。`)
    }
  }
  return notes
}

export function validateAnalysisSources(result, record, referenceIds) {
  const issues = []
  const requests = record.requests
  const claims = list(result.claims).filter((claim) => claim && typeof claim === 'object')
  const ids = claims.map((claim) => claim.requestId)
  if (new Set(ids).size !== ids.length) issues.push('分析重复回应同一请求')
  for (const request of requests) {
    const claim = claims.find((item) => item.requestId === request.id)
    if (!claim) { issues.push(`分析遗漏请求：${request.text}`); continue }
    claim.claim = request.text
    claim.subitems = request.subitems
    claim.sources = request.sources
    if (!str(claim.companyPosition) || !str(claim.reasoning)) issues.push(`请求缺少答辩立场或分析：${request.text}`)
    if (!list(claim.sourceIds).length || list(claim.sourceIds).some((id) => !record.sources.some((source) => source.id === id && !record.excludedSourceIds.includes(id)))) issues.push(`请求材料依据不存在：${request.text}`)
    if (list(claim.factIds).some((id) => !record.facts.some((fact) => fact.id === id && fact.kind !== 'unknown'
      && fact.sources.some((ref) => ref.located && !record.excludedSourceIds.includes(ref.sourceId))))) issues.push(`请求引用了未定位或停用材料的事实：${request.text}`)
    if (list(claim.referenceIds).some((id) => !referenceIds.has(id))) issues.push(`请求引用了未提供参考资料：${request.text}`)
    for (const item of list(claim.evidence)) {
      if (!item || typeof item !== 'object') { issues.push('证据格式无效'); continue }
      if (item.status === 'uploaded') {
        const source = record.sources.find((source) => source.id === item.sourceId && !record.excludedSourceIds.includes(source.id))
        if (source?.kind === 'company_statement') issues.push(`${request.id}：企业聊天陈述${item.sourceId}不是上传文件，请从evidence中移除，保留在facts/sourceIds；不能写成uploaded证据`)
        else if (source?.kind !== 'document') issues.push(`${request.id}：${str(item.name)}没有对应有效上传文件，不得将拟补充证据写成已上传`)
      }
    }
    if (claim.riskLevel !== 'unknown' && !str(claim.riskReason)) issues.push(`风险分级缺少本案理由：${request.text}`)
  }
  if (claims.some((claim) => !requests.some((request) => request.id === claim.requestId))) issues.push('分析添加了案件记录之外的请求')
  return issues
}

const requiredFields = ['conclusion', 'advice', 'legalBasis', 'analysis']
export function validateDraftParts(parts, record) {
  const issues = []
  for (const key of ['respondent', 'requestsSummary', 'closing']) if (!str(parts[key])) issues.push(`文书缺少${key}`)
  const items = list(parts.items).filter((item) => item && typeof item === 'object')
  const ids = items.map((item) => item.requestId)
  if (new Set(ids).size !== ids.length || ids.length !== record.requests.length) issues.push('文书请求编号不完整或重复')
  for (const request of record.requests) {
    const item = items.find((part) => part.requestId === request.id)
    if (!item) { issues.push(`文书遗漏请求：${request.text}`); continue }
    for (const key of requiredFields) if (!str(item[key])) issues.push(`请求文书缺少${key}：${request.text}`)
    for (const subitem of request.subitems) if (!list(item.coveredSubitems).includes(subitem)) issues.push(`文书遗漏费用子项：${subitem}`)
  }
  if (ids.some((id) => !record.requests.some((request) => request.id === id))) issues.push('文书添加了未知请求')
  return issues
}

export function composeArbitrationDraft(parts, record) {
  const sections = record.requests.map((request) => {
    const part = parts.items.find((item) => item.requestId === request.id)
    return `#### 关于${request.text}请求\n\n**答辩结论**：${str(part.conclusion)}\n\n**答辩建议**：${str(part.advice)}\n\n**法条依据**：${str(part.legalBasis)}\n\n**具体分析**：${str(part.analysis)}`
  })
  return ['### 劳动人事争议仲裁答辩意见书', `答辩人：${str(parts.respondent) || '【待补充】'}`,
    `申请人：${str(parts.applicant) || '【待补充】'}`, `案号：${str(parts.caseNumber) || '【待补充】'}`,
    `#### 答辩请求\n\n${str(parts.requestsSummary)}`, sections.join('\n\n---\n\n'),
    `#### 证据及证明目的\n\n${str(parts.evidence) || '【待核实已上传证据，拟补充材料另列】'}`,
    `#### 结语\n\n${str(parts.closing)}`, `此致\n\n${str(parts.committee) || '【待补充】劳动人事争议仲裁委员会'}`,
    '答辩人：【企业名称待确认】\n\n日期：【待补充】',
    '**提交前复核**：本草稿供企业内部准备，事实、企业承诺、具体条文及适用性须由专业人员核对。'].join('\n\n')
}
