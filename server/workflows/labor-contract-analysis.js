import { MAX_MODEL_OUTPUT_TOKENS, CONTEXT_WINDOW_TOKENS, CONTEXT_SAFETY_TOKENS, estimateTokens, selectHistoryByTokens } from '../../src/utils/context-budget.js'
import { documentBlocks, formatMaterialBlocks, selectMaterialBlocks } from '../services/document-materials.js'
import { indexedMaterialText } from '../services/material-processing.js'
import { createHash } from 'node:crypto'
import { extractText } from '../services/file-parser.js'
import { searchEvidence, DEFAULT_EVIDENCE_LIMIT } from '../services/knowledge-base.js'
import { listLawsForBaseline, resolveLawStatus } from '../services/law-whitelist.js'
import { chatDetailed, getFlashModel, getProModel, streamChat } from '../services/llm-client.js'
import { buildReviewResult, extractReviewPayload, findingSimilarity } from '../services/annotation-locator.js'
import { buildRevisionGroups } from '../services/finding-consolidator.js'
import { mergeRevisions } from '../services/revision-merger.js'
import { consolidateContractFindings } from '../agents/contract-consolidator.js'
import { rewriteContract } from '../agents/contract-rewriter.js'
import { auditLaborOccupationalResponsibilities, validateLaborRevisionCheck, auditLaborMonthlyDates, auditLaborRevisionDefaults, auditLaborRevisionPositions, laborContractTermFacts, laborReadOnlyGroupIds, laborPhaseOptions, planLaborRevisionBatches, runLaborModelUnit, unfinishedLaborOutput } from '../services/labor-analysis-units.js'
import { createLaborContractRedactor, LABOR_CONTRACT_REDACTION_NOTICE } from '../services/labor-contract-redaction.js'
import {
  buildLaborContractAnalysisUserMessage,
  buildLaborContractFollowupMessage,
  LABOR_CONTRACT_FOLLOWUP_SYSTEM_PROMPT,
  LABOR_CONTRACT_REVIEW_SYSTEM_PROMPT,
  LABOR_CONTENT_QUALITY_RULES,
  LABOR_CONTRACT_ANALYSIS_TOPICS
} from '../prompts/labor-contract-analysis.js'
import { MAX_CONTRACT_TEXT, TaskCancelledError, isValidAttachment } from './contract-review.js'

const ALLOWED_TOPIC_STATUSES = new Set(['covered', 'missing', 'unclear', 'risk', 'not_applicable'])
const LAW_STATUS_LABELS = Object.freeze({
  verified: '法规记录已核实',
  provisional: '法规记录待复核',
  superseded: '法规版本已更新',
  repealed: '法规已废止',
  expired: '法规记录已失效',
  pending_effect: '法规尚未生效',
  not_found: '法规未收录，需人工核实'
})

const textValue = (value, maxLength = 1200) => typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
const listOfText = (value, maxItems = 8, maxLength = 500) => Array.isArray(value)
  ? value.map((item) => textValue(item, maxLength)).filter(Boolean).slice(0, maxItems)
  : []
const checkpointValue = (getCheckpoint, stage) => getCheckpoint?.(stage)?.result || null

function normalizeWhitespaceWithOffsets(value) {
  const source = String(value || '')
  let normalized = ''
  const starts = []
  const ends = []
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (/\s/.test(char)) {
      if (!normalized || normalized.endsWith(' ')) {
        if (normalized.endsWith(' ')) ends[ends.length - 1] = index + 1
        continue
      }
      normalized += ' '
      starts.push(index)
      ends.push(index + 1)
      continue
    }
    normalized += char
    starts.push(index)
    ends.push(index + 1)
  }
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1)
    starts.pop()
    ends.pop()
  }
  return { normalized, starts, ends }
}

function lineAt(text, offset) {
  return text.slice(0, offset).split(/\r\n|\r|\n/).length
}

/** Resolve a model quote against parsed source text; never invent a location. */
export function locateLaborContractQuote(quote, documents = []) {
  const normalizedQuote = normalizeWhitespaceWithOffsets(quote).normalized
  if (!normalizedQuote) return { status: 'not-found', matches: [] }
  const matches = []
  for (const document of documents) {
    const sourceText = String(document.text || '')
    const indexed = normalizeWhitespaceWithOffsets(sourceText)
    let from = 0
    while (from <= indexed.normalized.length - normalizedQuote.length) {
      const at = indexed.normalized.indexOf(normalizedQuote, from)
      if (at < 0) break
      const rawStart = indexed.starts[at]
      const rawEnd = indexed.ends[at + normalizedQuote.length - 1]
      if (Number.isInteger(rawStart) && Number.isInteger(rawEnd)) {
        const excerpt = sourceText.slice(rawStart, rawEnd).trim()
        if (excerpt) {
          matches.push({
            fileId: String(document.fileId || ''),
            fileName: String(document.fileName || '上传文件'),
            lineStart: lineAt(sourceText, rawStart),
            lineEnd: lineAt(sourceText, Math.max(rawStart, rawEnd - 1)),
            startOffset: rawStart,
            endOffset: rawEnd,
            excerpt: excerpt.slice(0, 800)
          })
        }
      }
      from = at + Math.max(1, normalizedQuote.length)
      if (matches.length >= 12) break
    }
    if (matches.length >= 12) break
  }
  // Models sometimes abbreviate an otherwise verbatim quote with an ellipsis.
  // Restore only exact, ordered fragments in one source paragraph, never by
  // semantic similarity or by joining different paragraphs/files.
  if (!matches.length && /…|\.{3,}/.test(normalizedQuote)) {
    const parts = normalizedQuote.split(/…+|\.{3,}/).map((part) => part.trim())
    if (parts.length >= 2 && parts.length <= 4 && parts.every((part) => part.length >= 2)
      && parts.slice(1).every((part) => part.length >= 8) && parts.join('').length >= 16) {
      for (const document of documents) {
        const source = String(document.text || '')
        for (const paragraph of source.matchAll(/[^\r\n]+/g)) {
          const indexed = normalizeWhitespaceWithOffsets(paragraph[0])
          for (let from = 0; from < indexed.normalized.length;) {
            const start = indexed.normalized.indexOf(parts[0], from)
            if (start < 0) break
            let end = start + parts[0].length
            let valid = true
            for (const part of parts.slice(1)) {
              const at = indexed.normalized.indexOf(part, end)
              if (at < 0 || indexed.normalized.indexOf(part, at + 1) >= 0) { valid = false; break }
              end = at + part.length
            }
            const rawStart = paragraph.index + indexed.starts[start]
            const rawEnd = paragraph.index + indexed.ends[end - 1]
            if (valid && rawEnd - rawStart <= 800) matches.push({
              fileId: String(document.fileId || ''), fileName: String(document.fileName || '上传文件'),
              lineStart: lineAt(source, rawStart), lineEnd: lineAt(source, rawEnd - 1),
              startOffset: rawStart, endOffset: rawEnd, excerpt: source.slice(rawStart, rawEnd)
            })
            from = start + parts[0].length
            if (matches.length >= 12) break
          }
          if (matches.length >= 12) break
        }
        if (matches.length >= 12) break
      }
    }
  }
  if (!matches.length) return { status: 'not-found', matches: [] }
  return { status: matches.length === 1 ? 'found' : 'ambiguous', matches }
}

function createAnalysisOutputError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}

function normalizeModelResponse(response) {
  if (typeof response === 'string') {
    return { content: response, finishReason: null, usage: null, empty: !response.trim() }
  }
  const content = typeof response?.content === 'string' ? response.content : ''
  return {
    content,
    finishReason: typeof response?.finishReason === 'string' ? response.finishReason : null,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : null,
    empty: response?.empty === true || !content.trim()
  }
}

function parseModelJson(raw, { afterTruncationRetry = false } = {}) {
  const source = String(raw || '').trim()
  if (!source) {
    throw createAnalysisOutputError(
      afterTruncationRetry ? '劳动合同分析精简重试后仍未返回内容，请稍后重新提交。' : '劳动合同分析未返回内容，请稍后重新提交。',
      'labor_analysis_output_empty'
    )
  }
  const withoutFence = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(withoutFence)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('根节点必须是 JSON 对象')
    return parsed
  } catch (error) {
    const message = afterTruncationRetry
      ? `劳动合同分析精简重试后仍未返回有效 JSON：${error.message}`
      : `劳动合同分析结果不是有效 JSON：${error.message}`
    throw createAnalysisOutputError(message, 'labor_analysis_output_invalid', error)
  }
}

function jsonStringEnd(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') { index += 1; continue }
    if (source[index] === '"') return index + 1
  }
  return null
}

function readJsonStringFieldProgress(source, key) {
  const keyToken = JSON.stringify(key)
  const keyStart = String(source || '').indexOf(keyToken)
  if (keyStart < 0) return { value: '', complete: false }
  const colon = source.indexOf(':', keyStart + keyToken.length)
  if (colon < 0) return { value: '', complete: false }
  let index = colon + 1
  while (/\s/.test(source[index] || '')) index += 1
  if (source[index] !== '"') return { value: '', complete: false }
  index += 1
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '"') return { value, complete: true }
    if (char !== '\\') {
      value += char
      index += 1
      continue
    }
    if (index + 1 >= source.length) break
    const escapeLength = source[index + 1] === 'u' ? 6 : 2
    if (index + escapeLength > source.length) break
    const escaped = source.slice(index, index + escapeLength)
    try { value += JSON.parse(`"${escaped}"`) } catch { break }
    index += escapeLength
  }
  return { value, complete: false }
}

function jsonValueEnd(source, start) {
  const first = source[start]
  if (first === '"') return jsonStringEnd(source, start)
  if (first === '{' || first === '[') {
    const stack = [first]
    let inString = false
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index]
      if (inString) {
        if (char === '\\') index += 1
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const opener = stack.pop()
        if ((opener === '{' && char !== '}') || (opener === '[' && char !== ']')) return null
        if (!stack.length) return index + 1
      }
    }
    return null
  }
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === ',' || source[index] === '}' || source[index] === ']') return index
  }
  return null
}

function completedArrayItems(source, start) {
  const items = []
  let index = start + 1
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index += 1
    if (source[index] === ']') return { items, complete: true, end: index + 1 }
    if (source[index] === ',') { index += 1; continue }
    const valueEnd = jsonValueEnd(source, index)
    if (valueEnd === null || valueEnd <= index) return { items, complete: false, end: null, partialStart: index }
    try { items.push(JSON.parse(source.slice(index, valueEnd))) } catch { return { items, complete: false, end: null } }
    index = valueEnd
  }
  return { items, complete: false, end: null }
}

/** Read only closed top-level JSON fields; partial array members are safe to normalize individually. */
function readStreamedAnalysisFields(source, { preview = true } = {}) {
  const rootStart = source.indexOf('{')
  if (rootStart < 0) return {}
  const fields = {}
  const arrayFields = new Set(['coverage', 'topicChecks', 'missingItems', 'findings', 'lawCandidates', 'contextQuestions'])
  let index = rootStart + 1
  while (index < source.length) {
    while (/\s|,/.test(source[index] || '')) index += 1
    if (source[index] === '}') break
    if (source[index] !== '"') break
    const keyEnd = jsonStringEnd(source, index)
    if (keyEnd === null) break
    let key
    try { key = JSON.parse(source.slice(index, keyEnd)) } catch { break }
    index = keyEnd
    while (/\s/.test(source[index] || '')) index += 1
    if (source[index] !== ':') break
    index += 1
    while (/\s/.test(source[index] || '')) index += 1
    if (arrayFields.has(key) && source[index] === '[') {
      const array = completedArrayItems(source, index)
      fields[key] = array.items
      // Display-only preview: incomplete strings never become validated findings or checkpoints.
      if (preview && key === 'findings' && array.partialStart != null && source[array.partialStart] === '{') {
        const partial = source.slice(array.partialStart)
        const finding = {}
        for (const field of ['topic', 'level', 'title', 'location', 'fileName', 'quote', 'risk', 'explanation', 'advice', 'recommendation', 'replacement', 'suggestedClause']) {
          const progress = readJsonStringFieldProgress(partial, field)
          if (progress.value) finding[field] = progress.value
        }
        if (finding.title) fields.findings = [...array.items, finding]
      }
      if (!array.complete) break
      index = array.end
      continue
    }
    const valueEnd = jsonValueEnd(source, index)
    if (valueEnd === null || valueEnd <= index) break
    if (key === 'contractInfo' || key === 'agreementInfo') {
      try { fields.contractInfo = JSON.parse(source.slice(index, valueEnd)) } catch { /* wait for a valid closed value */ }
    }
    index = valueEnd
  }
  return fields
}

function streamSectionValue(section, value, context, itemIndex = 0) {
  if (section === 'contractInfo') return normalizeAnalysisOutput({ contractInfo: value }, context).contractInfo
  if (section === 'topicChecks') {
    const topicId = LABOR_CONTRACT_ANALYSIS_TOPICS.some((topic) => topic.id === value?.id)
      ? value.id
      : LABOR_CONTRACT_ANALYSIS_TOPICS.find((topic) => topic.label === value?.topic)?.id
    return normalizeAnalysisOutput({ topicChecks: [value] }, context).topicChecks.find((item) => item.id === topicId) || null
  }
  if (section === 'findings') {
    const finding = normalizeAnalysisOutput({ findings: [value] }, context).findings[0]
    return finding ? { ...finding, id: `finding-${itemIndex + 1}` } : null
  }
  if (section === 'missingItems') {
    const item = {
      topic: textValue(value?.topic, 100) || '待确认事项',
      item: textValue(value?.item, 500),
      reason: textValue(value?.reason, 800),
      location: { status: 'not-found', matches: [] }
    }
    return item.item || item.reason ? item : null
  }
  if (section === 'lawCandidates') {
    return normalizeAnalysisOutput({ lawCandidates: [value] }, context).lawCandidates[0] || null
  }
  if (section === 'contextQuestions') return textValue(value, 600) || null
  return null
}

function assertAllTopicChecks(raw, expectedTopics = LABOR_CONTRACT_ANALYSIS_TOPICS) {
  const expectedIds = new Set(expectedTopics.map((topic) => topic.id))
  const returnedIds = new Set()
  const sourceChecks = Array.isArray(raw.coverage) && raw.coverage.length ? raw.coverage : raw.topicChecks
  for (const check of Array.isArray(sourceChecks) ? sourceChecks : []) {
    const id = expectedTopics.some((topic) => topic.id === check?.id)
      ? check.id
      : expectedTopics.find((topic) => topic.label === check?.topic)?.id
    if (id && expectedIds.has(id)) returnedIds.add(id)
  }
  const missing = expectedTopics.filter((topic) => !returnedIds.has(topic.id))
  const extraCount = (Array.isArray(sourceChecks) ? sourceChecks : []).length - returnedIds.size
  if (missing.length || extraCount > 0) {
    throw createAnalysisOutputError(
      `劳动合同分析结果${missing.length ? `缺少基础检查项：${missing.map((topic) => topic.label).join('、')}` : ''}${missing.length && extraCount > 0 ? '；' : ''}${extraCount > 0 ? `多出或重复了 ${extraCount} 项` : ''}。请重新提交分析。`,
      'labor_analysis_output_incomplete'
    )
  }
}

const normalizeLawName = (value) => String(value || '')
  .replace(/[《》\s\u3000]/g, '')
  .replace(/[（(](?:19|20)\d{2}[^）)]*[）)]/g, '')
  .trim()

function matchLaw(title, laws) {
  const target = normalizeLawName(title)
  if (!target) return null
  return laws.find((law) => [law.title, ...(Array.isArray(law.aliases) ? law.aliases : [])]
    .some((candidate) => normalizeLawName(candidate) === target)) || null
}

function normalizeAuthorities(value, laws, resolveStatus) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).map((authority) => {
    const requestedTitle = textValue(authority?.title, 160)
    const law = matchLaw(requestedTitle, laws)
    if (!law) return null
    const status = resolveStatus(law)
    const articleText = textValue(authority?.article, 80)
    const article = articleText.match(/第[0-9一二三四五六七八九十百千万零〇]+条(?:第[0-9一二三四五六七八九十百千万零〇]+款)?/)?.[0] || ''
    const sourceUrl = /^https:\/\//i.test(String(law?.sourceUrl || '')) ? law.sourceUrl : ''
    return {
      title: law.title,
      article,
      lawStatus: status,
      lawStatusLabel: LAW_STATUS_LABELS[status] || LAW_STATUS_LABELS.not_found,
      articleApplicability: 'pending-mentor-and-legal-review',
      sourceUrl
    }
  }).filter(Boolean)
}

/** Product trial score, deliberately separate from the model's legal conclusions. */
export function scoreLaborContractAnalysis(topicChecks = [], findings = []) {
  const applicable = topicChecks.filter((check) => check.status !== 'not_applicable')
  if (!applicable.length) return { value: null, status: 'unavailable', rubricVersion: 'labor-nine-evidence-v1', breakdown: [], unscoredFindingIds: findings.map((item) => item.id) }
  const unit = 100 / applicable.length
  const breakdown = applicable.map((check) => {
    const baseFactor = check.status === 'missing' ? 0 : check.status === 'unclear' ? 0.5 : 1
    const supported = findings.find((finding) => finding.topic === check.topic
      && finding.location?.status === 'found'
      && finding.authorities?.some((authority) => authority.lawStatus === 'verified'))
    const evidenceDeduction = supported ? Math.min(0.5, baseFactor) * unit : 0
    return {
      id: check.id,
      topic: check.topic,
      status: check.status,
      possible: Number(unit.toFixed(2)),
      baseDeduction: Number(((1 - baseFactor) * unit).toFixed(2)),
      evidenceDeduction: Number(evidenceDeduction.toFixed(2)),
      awarded: Number((baseFactor * unit - evidenceDeduction).toFixed(2)),
      findingId: supported?.id || ''
    }
  })
  const scoredIds = new Set(breakdown.map((item) => item.findingId).filter(Boolean))
  return {
    value: Math.max(0, Math.min(100, Math.round(breakdown.reduce((sum, item) => sum + item.awarded, 0)))),
    status: 'trial',
    rubricVersion: 'labor-nine-evidence-v1',
    breakdown,
    excludedTopicIds: topicChecks.filter((check) => check.status === 'not_applicable').map((check) => check.id),
    unscoredFindingIds: findings.filter((finding) => !scoredIds.has(finding.id)).map((finding) => finding.id)
  }
}

function sanitizeEvidence(items = []) {
  return items.slice(0, DEFAULT_EVIDENCE_LIMIT).map((item, index) => ({
    id: String(item.evidenceId || `labor-evidence-${index + 1}`),
    sourceType: item.kind === 'risk_rule' ? 'risk-rule' : 'template-clause',
    title: textValue(item.title || item.sourceName || item.category || '劳动合同参考资料', 180),
    sourceName: textValue(item.sourceName, 180),
    referenceRole: textValue(item.referenceRole, 60),
    topicLabels: listOfText(item.topicLabels, 9, 80),
    text: textValue(item.text, 1800)
  }))
}

function normalizeAnalysisOutput(raw, { documents, evidence, laws, resolveStatus }) {
  const checksById = new Map()
  const sourceChecks = Array.isArray(raw.coverage) && raw.coverage.length ? raw.coverage : raw.topicChecks
  for (const check of Array.isArray(sourceChecks) ? sourceChecks : []) {
    const id = LABOR_CONTRACT_ANALYSIS_TOPICS.some((topic) => topic.id === check?.id)
      ? check.id
      : LABOR_CONTRACT_ANALYSIS_TOPICS.find((topic) => topic.label === check?.topic)?.id
    if (id && !checksById.has(id)) checksById.set(id, check)
  }
  const topicChecks = LABOR_CONTRACT_ANALYSIS_TOPICS.map((topic) => {
    const source = checksById.get(topic.id)
    const status = ALLOWED_TOPIC_STATUSES.has(source?.status) ? source.status : 'unclear'
    return {
      id: topic.id,
      topic: topic.label,
      status,
      summary: textValue(source?.summary, 800) || '模型未返回此项的可用检查结论，需人工复核。'
    }
  })

  const contractInfoSource = raw.contractInfo && typeof raw.contractInfo === 'object' ? raw.contractInfo : {}
  // Accept semantic aliases from older model outputs. Party A/B and dispatchUnit
  // are intentionally excluded: they do not establish who the employer is.
  const infoAliases = {
    employer: ['employerName', '用人单位'], employee: ['employeeName', '劳动者'],
    contractType: ['合同类型'], term: ['contractTerm', '合同期限'], probation: ['probationPeriod', '试用期'],
    position: ['jobPosition', '工作岗位'], workLocation: ['工作地点'], remuneration: ['劳动报酬'],
    workingHours: ['工作时间'], socialInsurance: ['社会保险'], signedDate: ['signDate', '签订日期'],
    applicabilityContext: ['适用前提']
  }
  const infoValue = (field) => {
    const value = textValue([field, ...(infoAliases[field] || [])].map((key) => contractInfoSource[key])
      .find((item) => typeof item === 'string' && item.trim()), 1200)
    return /^(未填写|未填|未明确约定|未约定|不明确|待确认|待核实|未知)$/.test(value) ? '' : value
  }
  const contractInfo = Object.fromEntries([
    'employer', 'employee', 'contractType', 'term', 'probation', 'position', 'workLocation',
    'remuneration', 'workingHours', 'socialInsurance', 'signedDate', 'applicabilityContext'
  ].map((field) => [field, infoValue(field)]))

  const missingItems = (Array.isArray(raw.missingItems) ? raw.missingItems : []).slice(0, 30).map((item) => ({
    topic: textValue(item?.topic, 100) || '待确认事项',
    item: textValue(item?.item, 500),
    reason: textValue(item?.reason, 800),
    location: { status: 'not-found', matches: [] }
  })).filter((item) => item.item || item.reason)

  const evidenceById = new Map(evidence.map((item) => [item.id, item]))
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).map((item, index) => {
    const requestedFile = textValue(item?.fileName || item?.sourceFileName, 200)
    const located = locateLaborContractQuote(textValue(item?.quote, 800), documents)
    const requestedMatches = requestedFile
      ? located.matches.filter((match) => match.fileName === requestedFile || match.fileName.includes(requestedFile)) : []
    const requestedMatch = requestedMatches.length === 1 ? requestedMatches[0] : null
    const location = requestedMatch
      ? { status: 'found', matches: [requestedMatch] }
      : located
    const matchingQuote = location.status === 'found' ? location.matches[0].excerpt : null
    const supportingMaterials = [...new Set(listOfText(item?.supportingEvidenceIds, 12, 160))]
      .map((id) => evidenceById.get(id))
      .filter(Boolean)
      .map((source) => ({
        id: source.id,
        sourceType: source.sourceType,
        title: source.title,
        sourceName: source.sourceName,
        referenceRole: source.referenceRole
      }))
    return {
      id: `finding-${index + 1}`,
      topic: textValue(item?.topic, 100) || '劳动合同条款',
      level: ['高', '中', '低'].includes(item?.level) ? item.level : null,
      title: textValue(item?.title, 180) || '需要核对的条款',
      explanation: textValue(item?.explanation || item?.risk, 2400),
      locationText: textValue(item?.location, 400),
      quote: matchingQuote,
      location,
      applicableConditions: listOfText(item?.applicableConditions, 8, 600),
      authorities: normalizeAuthorities(item?.authorities, laws, resolveStatus),
      supportingMaterials,
      recommendation: textValue(item?.recommendation || item?.advice, 1600),
      dependsOn: listOfText(item?.dependsOn, 20, 100),
      suggestedClause: textValue(item?.suggestedClause || item?.replacement, 2400)
    }
  })

  const warnings = [
    ...listOfText(raw.analysisNotes, 10, 500),
    '法规白名单覆盖度不代表完整；法规记录状态不等于具体条文适用性已核验。结论待 Mentor/法务复核。'
  ]
  if (topicChecks.some((item) => item.status === 'unclear')) warnings.push('部分基础检查项缺少明确结论，请补充材料或人工核对。')
  if (findings.some((item) => item.location.status !== 'found')) warnings.push('有风险项未能唯一定位到上传原文；请先核对对应摘录和位置。')

  const suggestedLaws = [
    ...(Array.isArray(raw.lawCandidates) ? raw.lawCandidates : []),
    ...(Array.isArray(raw.findings) ? raw.findings : []).flatMap((item) =>
      (Array.isArray(item?.authorities) ? item.authorities : [])
        .map((authority) => ({ title: authority?.title, reason: '模型曾将此项列为依据，但当前法规库未收录；请先核对官方原文。' })))
  ]
  const lawCandidates = [...new Map(suggestedLaws.slice(0, 24)
    .map((item) => ({ title: textValue(item?.title, 160), reason: textValue(item?.reason, 600), status: 'unverified' }))
    .filter((item) => item.title && !matchLaw(item.title, laws))
    .map((item) => [item.title, item])).values()].slice(0, 12)
  return {
    schemaVersion: 2,
    productId: 'labor-contract-analysis',
    kind: 'analysis',
    analysisStatus: 'completed',
    contractInfo,
    conclusion: textValue(raw.conclusion, 1000),
    topicChecks,
    missingItems,
    findings,
    lawCandidates,
    score: raw.score !== null && raw.score !== undefined && raw.score !== '' && Number.isFinite(Number(raw.score))
      ? { value: Math.max(0, Math.min(100, Math.round(Number(raw.score)))), status: 'model-reference' }
      : { value: null, status: 'unavailable' },
    contextQuestions: listOfText(raw.contextQuestions, 12, 600),
    warnings: [...new Set(warnings)],
    reviewStatus: 'draft-pending-mentor-and-legal-review',
    generatedAt: new Date().toISOString()
  }
}

const LABOR_REVIEW_ROUNDS = 3
const LABOR_REWRITE_SYSTEM_PROMPT = `你是法飞飞劳动合同局部修订助手，默认服务企业用工方。只处理已经过服务端原文定位的风险批注，不输出或重写整份合同。依据输入的修订组，为每组提供一条局部修订方案和对应原文位置；不能编造业务事实、金额、期限、工作地点或法规结论。不得擅自排除劳动者法定权利；事实不明时使用 ____ 占位或只给核对提醒。旧风险分析及最终复核意见均为待核对草案，不因它声称违法就盲目修改；复核的修复指令若与提供的明确规则矛盾，按明确规则修复并在riskNote说明，不照抄错误法条或扩大义务；结合完整条款复核限定条件、例外、适用主体和相关条款。工资与经济补偿等款项分别保留各自合法支付条件；试用期解除不能扩大法定事由范围；派遣两企业之间的约定不能替代依法需要的劳动者同意。不得把未经核实的旷工天数、金额、比例写成推荐默认值；不能为模板添加无依据的法定义务。无法确认修订合法性时保留原文并用 notice 给出具体核对提醒。严格遵守商业合同修订 Agent 的 JSON revisions 协议，输出合法 JSON 对象，不要 Markdown 围栏。`

const dedupeFindingKey = (finding = {}) => `${String(finding.title || '').replace(/\s+/g, '').trim()}::${String(finding.quote || '').replace(/\s+/g, '').trim()}`
const findingSummary = (finding = {}) => ({
  level: ['高', '中', '低'].includes(finding.level) ? finding.level : null,
  title: textValue(finding.title, 180) || '未命名问题',
  location: textValue(finding.location || finding.locationText, 260),
  fileName: textValue(finding.fileName, 260),
  topic: textValue(finding.topic, 60),
  quote: textValue(finding.quote, 400),
  risk: textValue(finding.risk || finding.explanation, 220),
  advice: textValue(finding.advice || finding.recommendation, 220)
})

function mergeLaborRoundPayload(target, source) {
  const next = { ...target }
  for (const key of ['contractInfo', 'agreementInfo', 'score', 'conclusion']) {
    if (source?.[key] !== undefined && source[key] !== null && source[key] !== '') {
      next[key] = ['contractInfo', 'agreementInfo'].includes(key) && typeof source[key] === 'object'
        ? { ...(next[key] || {}), ...Object.fromEntries(Object.entries(source[key]).filter(([, value]) => value !== '')) }
        : source[key]
    }
  }
  const arrayKeys = ['coverage', 'topicChecks', 'missingItems', 'findings', 'lawCandidates', 'analysisNotes', 'contextQuestions']
  for (const key of arrayKeys) {
    const incoming = Array.isArray(source?.[key]) ? source[key] : []
    if (!incoming.length) continue
    const current = Array.isArray(next[key]) ? [...next[key]] : []
    const keyOf = key === 'coverage' || key === 'topicChecks'
      ? (item) => String(item?.id || '')
      : key === 'findings'
        ? dedupeFindingKey
        : (item) => JSON.stringify(item)
    const indexByKey = new Map(current.map((item, index) => [keyOf(item), index]))
    for (const item of incoming) {
      const itemKey = keyOf(item)
      if (indexByKey.has(itemKey)) {
        if (key === 'coverage' || key === 'topicChecks') current[indexByKey.get(itemKey)] = item
      } else {
        indexByKey.set(itemKey, current.length)
        current.push(item)
      }
    }
    next[key] = current
  }
  return next
}

function buildLaborContractSourceText(documents = []) {
  return documents.map((document) => `=== 文件：${document.fileName || '上传文件'} ===\n${document.text || ''}`).join('\n\n')
}

function makeLaborAnnotationResult(analysis, contractText) {
  const candidates = (analysis.findings || []).filter((item) => item.location?.status === 'found' && item.location.matches?.length === 1 && item.level)
  const modelOutput = JSON.stringify({
    conclusion: analysis.conclusion || '已完成劳动合同审查。',
    completeness: (analysis.missingItems || []).map((item) => [item.topic, item.item, item.reason].filter(Boolean).join('：')),
    findings: candidates.map((item) => ({
      level: item.level,
      title: item.title,
      location: [item.location.matches[0].fileName, item.locationText, `第 ${item.location.matches[0].lineStart} 行`].filter(Boolean).join(' · '),
      quote: item.quote,
      risk: item.explanation,
      advice: item.recommendation,
      replacement: item.suggestedClause,
      evidence: [
        ...(item.authorities || []).map((authority) => `${authority.title}${authority.article ? ` ${authority.article}` : ''}（${authority.lawStatusLabel}；适用性仍需核对）`),
        ...(item.supportingMaterials || []).map((source) => source.id)
      ]
    }))
  })
  const located = buildReviewResult({ contractText, modelOutput })
  const remaining = [...(analysis.findings || [])]
  located.findings = located.findings.map((finding) => {
    const normalizedQuote = String(finding.quoteText || finding.originalText || '').replace(/\s+/g, '')
    const index = remaining.findIndex((candidate) => candidate.title === finding.title
      && String(candidate.quote || '').replace(/\s+/g, '') === normalizedQuote)
    if (index < 0) return finding
    const [source] = remaining.splice(index, 1)
    return {
      ...finding,
      id: source.id,
      topic: source.topic,
      applicableConditions: source.applicableConditions,
      authorities: source.authorities,
      supportingMaterials: source.supportingMaterials,
      suggestedClause: source.suggestedClause
    }
  })
  const alreadyUnresolved = new Set(located.unresolved.map((item) => item.title))
  const unlocated = remaining.filter((item) => !alreadyUnresolved.has(item.title)).map((item, index) => ({
    sourceIndex: candidates.length + index + 1,
    title: item.title || '劳动合同事项',
    reason: !item.level ? '模型未给出风险等级；风险说明已保留，未生成批注。' : item.location?.status === 'ambiguous' ? '原文摘录出现多处，无法唯一定位；未生成批注。' : !item.quote ? '模型没有返回可核对的原文摘录；未生成批注。' : '无法将摘录唯一定位到原文；未生成批注。'
  }))
  located.unresolved.push(...unlocated)
  located.stats.generated = (analysis.findings || []).length
  located.stats.unresolved = located.unresolved.length
  located.stats.confirmed = located.findings.length
  return located
}

function renderLaborContractReviewReport(analysis, reviewResult) {
  const lines = [analysis.analysisType === 'labor_dispatch_agreement' ? '# 劳务派遣协议分析结果' : '# 劳动合同分析结果']
  if (analysis.score?.value !== null && analysis.score?.value !== undefined) lines.push(`**参考分数**：${analysis.score.value}/100`)
  const infoLabels = [
    ['employer', '用人单位'], ['employee', '劳动者'], ['contractType', '合同类型'], ['term', '合同期限'],
    ['probation', '试用期'], ['position', '岗位 / 工作内容'], ['workLocation', '工作地点'],
    ['remuneration', '劳动报酬'], ['workingHours', '工作时间'], ['socialInsurance', '社会保险'], ['signedDate', '签订日期']
  ]
  const knownInfo = infoLabels.filter(([key]) => analysis.contractInfo?.[key])
  if (knownInfo.length) lines.push('', '## 合同基本信息', ...knownInfo.map(([key, label]) => `- **${label}**：${analysis.contractInfo[key]}`))
  if (analysis.contractInfo?.applicabilityContext) lines.push(`- **适用前提**：${analysis.contractInfo.applicabilityContext}`)
  lines.push('', '## 重点风险与处理建议')
  if (!analysis.findings?.length) lines.push('本次没有生成风险批注；请结合下方未确认事项及合同全文复核。')
  for (const finding of analysis.findings || []) {
    const location = finding.location?.matches?.length === 1
      ? `${finding.location.matches[0].fileName} · 第 ${finding.location.matches[0].lineStart} 行`
      : finding.location?.status === 'ambiguous' ? '原文出现多处，需人工确认位置' : '原文位置尚未确认'
    lines.push('', `### 【${finding.level || '待判断'}风险】${finding.title}`, `- **位置**：${location}`)
    if (finding.quote) lines.push(`- **原文**：“${finding.quote}”`)
    lines.push(`- **风险**：${finding.explanation || '需结合实际情况核对。'}`)
    if (finding.applicableConditions?.length) lines.push(`- **适用前提**：${finding.applicableConditions.join('；')}`)
    if (finding.authorities?.length) lines.push(`- **法规记录**：${finding.authorities.map((authority) => `${authority.title}${authority.article ? ` ${authority.article}` : ''}（${authority.lawStatusLabel}；具体适用性仍需核对）`).join('；')}`)
    if (finding.supportingMaterials?.length) lines.push(`- **范本 / 风险规则参考**：${finding.supportingMaterials.map((source) => `${source.title}（仅作对照参考）`).join('；')}`)
    if (finding.recommendation) lines.push(`- **建议**：${finding.recommendation}`)
    if (finding.suggestedClause) lines.push(`- **建议条款**：${finding.suggestedClause}`)
  }
  if (analysis.missingItems?.length) {
    lines.push('', '## 需要补充或确认')
    analysis.missingItems.forEach((item) => lines.push(`- **${item.topic || '待确认事项'}**：${item.item || item.reason}`))
  }
  if (analysis.lawCandidates?.length) {
    lines.push('', '## 待用户核验的法规线索')
    analysis.lawCandidates.forEach((item) => lines.push(`- ${item.title}${item.reason ? `：${item.reason}` : ''}（尚未核验，不作为已确认法律依据）`))
  }
  if (reviewResult.unresolved?.length) {
    lines.push('', '## 未生成批注的事项', `以下 ${reviewResult.unresolved.length} 项尚不满足批注生成条件，风险说明仍保留在报告中；请按各项原因补充或核对。`)
    reviewResult.unresolved.forEach((item) => lines.push(`- **${item.title || '风险事项'}**：${item.reason || '无法唯一定位到合同原文。'}`))
  }
  lines.push('', '分析结果供企业完善合同参考；适用地区、日期及具体事实需要结合实际核验。')
  return lines.join('\n')
}

function renderLaborContractProgressReport(analysis, reviewResult = { unresolved: [] }) {
  const lines = []
  const infoLabels = [
    ['employer', '用人单位'], ['employee', '劳动者'], ['contractType', '合同类型'], ['term', '合同期限'],
    ['probation', '试用期'], ['position', '岗位 / 工作内容'], ['workLocation', '工作地点'],
    ['remuneration', '劳动报酬'], ['workingHours', '工作时间'], ['socialInsurance', '社会保险'], ['signedDate', '签订日期']
  ]
  const knownInfo = infoLabels.filter(([key]) => analysis.contractInfo?.[key])
  if (knownInfo.length) {
    lines.push('## 合同基本信息', ...knownInfo.map(([key, label]) => `- **${label}**：${analysis.contractInfo[key]}`))
    if (analysis.contractInfo?.applicabilityContext) lines.push(`- **适用前提**：${analysis.contractInfo.applicabilityContext}`)
  }
  if (Number.isFinite(analysis.score?.value)) lines.push(`**参考分数：${analysis.score.value}/100**`)
  if (analysis.findings?.length) {
    lines.push('', '## 重点风险与处理建议')
    for (const finding of analysis.findings) {
      const location = finding.location?.matches?.length === 1
        ? `${finding.location.matches[0].fileName} · 第 ${finding.location.matches[0].lineStart} 行`
        : finding.location?.status === 'ambiguous' ? '原文出现多处，需人工确认位置' : '原文位置尚未确认'
      lines.push('', `### 【${finding.level || '待判断'}风险】${finding.title}`, `- **位置**：${location}`)
      if (finding.quote) lines.push(`- **原文**：“${finding.quote}”`)
      if (finding.explanation) lines.push(`- **风险**：${finding.explanation}`)
      if (finding.applicableConditions?.length) lines.push(`- **适用前提**：${finding.applicableConditions.join('；')}`)
      if (finding.authorities?.length) lines.push(`- **法规记录**：${finding.authorities.map((authority) => `${authority.title}${authority.article ? ` ${authority.article}` : ''}（${authority.lawStatusLabel}；具体适用性仍需核对）`).join('；')}`)
      if (finding.supportingMaterials?.length) lines.push(`- **范本 / 风险规则参考**：${finding.supportingMaterials.map((source) => `${source.title}（仅作对照参考）`).join('；')}`)
      if (finding.recommendation) lines.push(`- **建议**：${finding.recommendation}`)
      if (finding.suggestedClause) lines.push(`- **建议条款**：${finding.suggestedClause}`)
    }
  }
  if (analysis.missingItems?.length) {
    lines.push('', '## 需要补充或确认')
    analysis.missingItems.forEach((item) => lines.push(`- **${item.topic || '待确认事项'}**：${item.item || item.reason}`))
  }
  if (analysis.lawCandidates?.length) {
    lines.push('', '## 待用户核验的法规线索')
    analysis.lawCandidates.forEach((item) => lines.push(`- ${item.title}${item.reason ? `：${item.reason}` : ''}（尚未核验，不作为已确认法律依据）`))
  }
  if (reviewResult.unresolved?.length) {
    lines.push('', '## 原文位置待人工核对', `以下 ${reviewResult.unresolved.length} 项没有唯一、可核验的原文定位，因此没有生成高亮批注；未高亮不代表原文位置已确认。`)
    reviewResult.unresolved.forEach((item) => lines.push(`- **${item.title || '风险事项'}**：${item.reason || '无法唯一定位到合同原文。'}`))
  }
  return lines.join('\n')
}

export async function executeLaborContractReview({
  task, input, documents, focus, evidence, laws, lawPromptCatalog, resolveStatus, privacyRedactor,
  emit, checkpoint, getCheckpoint, ensureActive, fakeLlm, generateCompletion, streamCompletion,
  signal, consolidate = consolidateContractFindings, rewrite = rewriteContract,
  reviewTopics = LABOR_CONTRACT_ANALYSIS_TOPICS, reviewSystemPrompt = LABOR_CONTRACT_REVIEW_SYSTEM_PROMPT,
  messageBuilder = buildLaborContractAnalysisUserMessage, normalizeResult = normalizeAnalysisOutput, extraContext = {},
  rewriteSystemPrompt = LABOR_REWRITE_SYSTEM_PROMPT, readOnlyDocumentRoles = []
}) {
  const safeDocuments = privacyRedactor.maskDocuments(documents).map(({ fileName, text, role }) => ({ fileName, text, role }))
  const safeFocus = privacyRedactor.mask(focus + '\n' + (input.materialNotice || '') + '\n【已遍历材料的逐字摘录，须结合本块原文核对】\n' + indexedMaterialText(input.materialIndex))
  const contentBlocks = documentBlocks(documents).map((b) => ({ ...b, fileName: privacyRedactor.mask(b.fileName), text: privacyRedactor.mask(b.text), context: privacyRedactor.mask(b.context) }))
  const relatedDocuments = (query) => {
    const selected = selectMaterialBlocks(safeDocuments, query)
    return [{ fileName: '相关原文与逐字条件', text: formatMaterialBlocks(selected.blocks) + '\n' + privacyRedactor.mask(indexedMaterialText(input.materialIndex)) }]
  }
  const documentGroups = safeDocuments.reduce((sum, d) => sum + estimateTokens(d.text), 0) > 6000 ? contentBlocks.map((b) => [{ fileName: b.fileName, role: safeDocuments.find((d) => d.fileName === b.fileName)?.role, text: formatMaterialBlocks([b]) }]) : [safeDocuments]
  const safeEvidence = privacyRedactor.maskDeep(evidence)
  const safeLaws = lawPromptCatalog
  const termFacts = laborContractTermFacts(safeDocuments)
  const termContext = termFacts.length ? `\n程序核对的原文明示期限（不是适用性结论）：${JSON.stringify(termFacts)}。必须按各自文件核对；reachesTwoCalendarYears=false不能写成已满二年，派遣协议期限不能代替派遣劳动合同期限。` : ''
  const mode = task.mode === 'fast' ? 'fast' : 'thinking'
  const optionsForPhase = (stage) => laborPhaseOptions(mode, stage)
  const contractText = buildLaborContractSourceText(documents)
  const reviewCheckpoint = checkpointValue(getCheckpoint, 'review')
  let generated = reviewCheckpoint?.generated && typeof reviewCheckpoint.generated === 'object' ? reviewCheckpoint.generated : null
  let analysisOverview = textValue(checkpointValue(getCheckpoint, 'analysis-overview')?.text || generated?.conclusion, 1000)
  const publishOverview = async (value, recovered = false) => {
    const next = textValue(value, 1000)
    if (!next) return
    analysisOverview = next
    await emit('analysis.delta', {
      content: `## 审查摘要\n${privacyRedactor.restore(next)}`,
      replace: true,
      recovered
    })
  }
  if (analysisOverview) await publishOverview(analysisOverview, true)
  let combinedFindings = Array.isArray(reviewCheckpoint?.combinedFindings) ? [...reviewCheckpoint.combinedFindings] : []
  let roundSnapshots = Array.isArray(reviewCheckpoint?.roundSnapshots) ? [...reviewCheckpoint.roundSnapshots] : []
  let totalRoundsExecuted = Number(reviewCheckpoint?.totalRoundsExecuted) || 0
  const normalizationContext = { documents, evidence, laws, resolveStatus, ...extraContext }
  const normalize = (value) => normalizeResult(value, normalizationContext)

  const unit = (stage, name, operation, onRetry) => runLaborModelUnit({
    operation, mode: optionsForPhase(stage).mode, signal, ensureActive, emit, stage, unit: name, onRetry
  })
  const callModel = async ({ userMessage, systemPrompt = `${reviewSystemPrompt}\n${LABOR_CONTENT_QUALITY_RULES}`, phase = 'review', onContent, signal: requestSignal, progress, timeoutMs, attempt = 1 }) => {
    const request = { systemPrompt: systemPrompt + termContext, userMessage, ...optionsForPhase(phase), phase, compact: attempt > 1, signal: requestSignal,
      requestTimeoutMs: timeoutMs }
    let content = ''
    let finishReason = null
    if (streamCompletion) {
      for await (const chunk of streamCompletion(request)) {
        ensureActive()
        if (requestSignal.aborted) throw unfinishedLaborOutput('当前请求已中止')
        if (chunk?.reasoning) progress.reasoningChars += chunk.reasoning.length
        if (chunk?.usage) progress.usage = chunk.usage
        if (typeof chunk?.content === 'string' && chunk.content) {
          content += chunk.content
          progress.contentChars = content.length
          progress.firstContentMs ??= Date.now() - progress.startedAt
          if (onContent) await onContent(content)
        }
        if (typeof chunk?.finishReason === 'string') finishReason = chunk.finishReason
        // The final content/usage chunk already establishes completion. Do not
        // depend on a later transport terminator arriving on a healthy socket.
        if (finishReason === 'stop') break
      }
    } else {
      const response = normalizeModelResponse(await generateCompletion(request))
      ensureActive()
      if (requestSignal.aborted) throw unfinishedLaborOutput('当前请求已中止')
      content = response.content
      finishReason = response.finishReason
      progress.contentChars = content.length
      progress.usage = response.usage
      if (onContent && content) await onContent(content)
    }
    if (finishReason !== 'stop') throw unfinishedLaborOutput(`当前批次未完整返回（${finishReason || '缺少结束标记'}）`)
    return parseModelJson(content)
  }
  const auxiliary = (phase, systemPrompt, data, validate = (value) => value) => unit(phase, phase, async (request) => {
    const payload = await callModel({ ...request, phase, systemPrompt,
      userMessage: JSON.stringify(privacyRedactor.maskDeep({ ...data, outputRequirement: '完整JSON必须显式包含complete:true；不能省略这个字段。',
        ...(request.attempt > 1 ? { retryRequirement: '上次结果未完整结束；本次先输出complete:true，再输出其它字段和闭合JSON。' } : {}) })) })
    if (payload.complete !== true) throw unfinishedLaborOutput()
    return validate(payload)
  })

  const reviewOneRound = async (round, previousFindings) => {
    const saved = checkpointValue(getCheckpoint, 'review-pages')
    let payload = saved?.version === 1 && saved.round === round ? saved.payload : {}
    let page = saved?.version === 1 && saved.round === round ? saved.page : 0
    let materialGroup = saved?.version === 1 && saved.round === round ? saved.materialGroup || 0 : 0
    let noProgress = saved?.version === 1 && saved.round === round ? saved.noProgress || 0 : 0
    let audit = saved?.version === 1 && saved.round === round && saved.audit === true
    let dropped = 0
    const countedDuplicates = new Set()
    const save = () => checkpoint('review-pages', { version: 1, round, page, payload, noProgress, audit, materialGroup })
    const publish = async (previewFields = {}) => {
      const preview = mergeLaborRoundPayload(mergeLaborRoundPayload(generated || {}, payload), previewFields)
      await emit('review.delta', { content: renderLaborContractProgressReport(normalize(privacyRedactor.restoreDeep(preview))), replace: true, streaming: true })
    }
    const accept = async (fields, requestSignal) => {
      if (requestSignal.aborted) throw unfinishedLaborOutput('当前请求已中止')
      const valid = []
      let incomplete = false
      for (const candidate of fields.findings || []) {
        if (!candidate || !textValue(candidate.title) || !['高', '中', '低', '高风险', '中风险', '低风险'].includes(candidate.level)
          || !textValue(candidate.risk || candidate.explanation) || !textValue(candidate.advice || candidate.recommendation)
          || (!textValue(candidate.quote) && !(candidate.omission === true && textValue(candidate.omissionReason)))) {
          incomplete = true
          continue
        }
        const { replacement, suggestedClause, ...finding } = candidate
        const known = [...combinedFindings, ...(payload.findings || []), ...valid]
        if (known.some((item) => dedupeFindingKey(item) === dedupeFindingKey(finding) || findingSimilarity(finding, item).similar)) {
          const key = dedupeFindingKey(finding)
          if (combinedFindings.some((item) => dedupeFindingKey(item) === key || findingSimilarity(finding, item).similar) && !countedDuplicates.has(key)) { countedDuplicates.add(key); dropped += 1 }
          continue
        }
        valid.push(finding)
      }
      const { score, conclusion, roundComplete, findings, ...metadata } = fields
      const next = mergeLaborRoundPayload(payload, { ...metadata, findings: valid })
      if (JSON.stringify(next) !== JSON.stringify(payload)) {
        payload = next
        await save()
        await emit('stage.progress', { stage: 'review', message: `第 ${round} 轮已保存 ${payload.findings?.length || 0} 条新问题，继续核对全文。`, validResults: payload.findings?.length || 0 })
      }
      if (incomplete) throw unfinishedLaborOutput('风险缺少必要字段或缺失事项说明，正在补齐')
    }
    await emit('review.round', { round, total: LABOR_REVIEW_ROUNDS, phase: 'start', accumulated: combinedFindings.length, message: `正在进行第 ${round} 轮审查` })
    await publish()
    let complete = false
    while (!complete) {
      ensureActive()
      const progressSignature = () => JSON.stringify({ findings: payload.findings?.length || 0,
        coverage: (payload.coverage || payload.topicChecks || []).map(({ id, status }) => [id, status]).sort(([left], [right]) => String(left).localeCompare(String(right))) })
      const before = progressSignature()
      page += 1
      await save()
      const response = await unit('review', `round-${round}-page-${page}`, async (request) => {
        let lastPreviewAt = 0
        let lastPreview = ''
        const userMessage = messageBuilder({ documents: documentGroups[materialGroup], focus: safeFocus + (documentGroups.length > 1 ? '\n当前只审查此内容块及提供的逐字关联摘录，不能因本块缺少某条款而断言全文缺失。' : ''),
          evidence: safeEvidence, lawCatalog: safeLaws, round, previousFindings: [...previousFindings, ...(payload.findings || []).map(findingSummary)],
          batchSize: request.attempt === 1 ? 6 : request.attempt === 2 ? 3 : 1,
          contractInfo: { ...(generated?.contractInfo || {}), ...(payload.contractInfo || {}) },
          agreementInfo: { ...(generated?.agreementInfo || {}), ...(payload.agreementInfo || {}) },
          topics: reviewTopics, ...extraContext,
          coverage: payload.coverage || payload.topicChecks || generated?.coverage || generated?.topicChecks || [], coverageAudit: audit })
        const enteredBlocks = documentGroups.length > 1 ? contentBlocks.slice(0, materialGroup + 1) : contentBlocks
        const checkedBlocks = documentGroups.length > 1 ? contentBlocks.slice(0, materialGroup) : []
        await checkpoint('material-coverage', { parsed: contentBlocks.length, indexed: (input.materialIndex || []).map((e) => e.blockId),
          selected: enteredBlocks.map((b) => b.id), entered: fakeLlm ? [] : enteredBlocks.map((b) => b.id), checked: checkedBlocks.map((b) => b.id),
          simulated: Boolean(fakeLlm), round, partial: true })
        const onContent = async (raw) => {
          await accept(readStreamedAnalysisFields(raw, { preview: false }), request.signal)
          request.progress.completed = payload.findings?.length || 0
          if (Date.now() - lastPreviewAt < 120) return
          const fields = readStreamedAnalysisFields(raw)
          const signature = JSON.stringify(fields)
          if (signature === lastPreview) return
          lastPreviewAt = Date.now(); lastPreview = signature
          await publish(fields)
        }
        const value = await callModel({ ...request, userMessage, onContent })
        if (typeof value.roundComplete !== 'boolean' || (value.findings?.length || 0) > (request.attempt === 1 ? 6 : request.attempt === 2 ? 3 : 1)) throw unfinishedLaborOutput('缺少轮次完成标记或当前批次超出大小，正在继续补齐')
        await accept(value, request.signal)
        return value
      })
      complete = response.roundComplete
      if (complete) {
        const completedBlocks = documentGroups.length > 1 ? contentBlocks.slice(0, materialGroup + 1) : contentBlocks
        await checkpoint('material-coverage', { parsed: contentBlocks.length, indexed: (input.materialIndex || []).map((e) => e.blockId),
          selected: completedBlocks.map((b) => b.id), entered: fakeLlm ? [] : completedBlocks.map((b) => b.id), checked: completedBlocks.map((b) => b.id),
          simulated: Boolean(fakeLlm), round, partial: completedBlocks.length !== contentBlocks.length || Boolean(input.materialIncomplete) })
      }
      if (complete && materialGroup + 1 < documentGroups.length) {
        materialGroup++; complete = false; noProgress = 0; audit = false
        await emit('stage.progress', { stage: 'review', message: `继续审查内容块 ${materialGroup + 1}/${documentGroups.length}` })
      }
      const after = progressSignature()
      noProgress = before === after ? noProgress + 1 : 0
      if (!complete && noProgress >= 2) {
        if (audit) throw Object.assign(new Error('覆盖核对仍无法完整结束，已保存完成结果。'), { code: 'labor_analysis_no_progress', unitRetryExhausted: true })
        audit = true
        await emit('stage.progress', { stage: 'review', message: '续查未增加有效结果，正在做全文覆盖核对。' })
      }
      await save()
    }
    await checkpoint('material-coverage', { parsed: contentBlocks.length, selected: contentBlocks.map((b) => b.id), checked: contentBlocks.map((b) => b.id), round, partial: Boolean(input.materialIncomplete) })
    if (round === 1) assertAllTopicChecks(payload, reviewTopics)
    const newFindings = payload.findings || []
    combinedFindings.push(...newFindings)
    generated = mergeLaborRoundPayload(generated || {}, payload)
    roundSnapshots.push({ round, newCount: newFindings.length, dropped, newFindings: newFindings.map(findingSummary) })
    totalRoundsExecuted = round
    await checkpoint('review', { generated, combinedFindings, roundSnapshots, totalRoundsExecuted })
    await publish()
    await emit('review.round', { ...roundSnapshots.at(-1), total: LABOR_REVIEW_ROUNDS, phase: 'end', accumulated: combinedFindings.length,
      message: newFindings.length ? `第 ${round} 轮新增 ${newFindings.length} 项` : `第 ${round} 轮没有发现新问题` })
    return newFindings.length
  }

  if (fakeLlm) {
    generated = buildFakeAnalysis(documents)
    roundSnapshots = [{ round: 1, newCount: 0, newFindings: [], fake: true }]
    totalRoundsExecuted = 1
  } else {
    await emit('stage.start', { stage: 'review', label: '正在按合同审查方式进行最多三轮增量审查' })
    for (const snapshot of roundSnapshots) {
      await emit('review.round', { ...snapshot, total: LABOR_REVIEW_ROUNDS, phase: 'end', recovered: true })
    }
    // A saved round is a resume point, not a completed review. In particular a
    // connection failure during round 2 must never turn round 1 into the final result.
    const stoppedEarly = roundSnapshots.at(-1)?.newCount === 0
    for (let round = totalRoundsExecuted + 1; round <= LABOR_REVIEW_ROUNDS; round += 1) {
      if (stoppedEarly) break
      ensureActive()
      const previous = combinedFindings.map(findingSummary)
      const added = await reviewOneRound(round, previous)
      if (added === 0) break
    }
  }

  let qualityReminders = []
  let qualitySignature = ''
  if (!fakeLlm && combinedFindings.length) {
    // Compare reported claims to the supplied text before commissioning any
    // rewrites. This does not discover new risks or import new legal rules.
    const candidates = combinedFindings.map((finding, index) => ({ ...finding, candidateId: `candidate-${index + 1}` }))
    qualitySignature = createHash('sha256').update(JSON.stringify(candidates)).digest('hex')
    const savedQuality = checkpointValue(getCheckpoint, 'finding-quality')
    const decisions = savedQuality?.signature === qualitySignature ? [...savedQuality.decisions] : []
    const decisionMap = new Map(decisions.map((decision) => [decision.candidateId, decision]))
    for (let offset = decisions.length; offset < candidates.length; offset += 6) {
      ensureActive()
      const batch = candidates.slice(offset, offset + 6)
      await emit('stage.progress', { stage: 'review', message: `正在核对问题与原文的一致性（${offset}/${candidates.length}）。` })
      const kept = candidates.filter((candidate) => decisionMap.get(candidate.candidateId)?.kind === 'risk')
        .map((candidate) => ({ candidateId: candidate.candidateId, ...findingSummary(candidate) }))
      const reviewed = await unit('quality', `findings-${offset + 1}`, async (request) => {
        const payload = await callModel({ ...request, phase: 'quality',
          systemPrompt: `你只整理已有审查草案，不能发现新风险、生成条款或推定未提供的事实。逐项对照完整原文和本项risk/advice，选择risk、reminder或duplicate。risk：原文中有明确不当约定、重要遗漏、具体矛盾或实际商业缺陷；重要事实不明而影响既有问题判断时保留risk并说明条件。reminder：条款已符合给定条件，理由仅为执行时核对地区规则、留存证据、确认岗位比例或可选流程；“材料未附”不等于“实际未履行”。如二年期限已合规却只需核对三性、病假较高标准已优先却还提醒查地区、社保已按实际工资却还提醒留凭证，应为reminder。duplicate：与此前保留或本批选择保留为risk的问题具有同一缺陷、同一法律原因和处理方向；换标题或重复风险后果不是独立问题。同条款法律原因不同必须保留risk。拿不准是否独立或是否为实质缺陷时保留risk，不能为减少数量而删除。只按输入数据判断，不作新的法律结论。每个输入candidateId必须恰好返回一次，reason说明原文与理由的具体关系；duplicateOf只能指向此前保留或本批明确标为risk的候选，不受本批输出顺序限制，不指向duplicate/reminder或未输入的ID。返回完整JSON {"decisions":[{"candidateId":"输入ID","kind":"risk|reminder|duplicate","reason":"具体说明","duplicateOf":"仅duplicate时的目标ID"}],"complete":true}。\n${LABOR_CONTENT_QUALITY_RULES}`,
          userMessage: JSON.stringify(privacyRedactor.maskDeep({ ...extraContext, documents: relatedDocuments(JSON.stringify(batch)), candidates: batch, kept,
            outputRequirement: '返回的JSON顶层先写complete:true，再写decisions。所有候选必须逐项返回；完整闭合后才结束。',
            ...(request.attempt > 1 ? { retryRequirement: '上次标识或完成字段不完整；务必按当前批次ID逐项输出，包含complete:true，不重做其它批次。' } : {}) })) })
        if (payload.complete !== true || !Array.isArray(payload.decisions) || payload.decisions.length !== batch.length) throw unfinishedLaborOutput('问题核验未完整覆盖当前批次')
        const byCandidate = new Map(payload.decisions.map((decision) => [decision?.candidateId, decision]))
        if (byCandidate.size !== batch.length || batch.some(({ candidateId }) => !byCandidate.has(candidateId))) throw unfinishedLaborOutput('问题核验标识重复或遗漏')
        const ordered = batch.map(({ candidateId }) => byCandidate.get(candidateId))
        // Validate the whole batch first. A duplicate may point to a retained
        // risk later in this batch; output order is not a semantic dependency.
        const accepted = new Set([...kept.map((candidate) => candidate.candidateId),
          ...ordered.filter((decision) => decision.kind === 'risk').map((decision) => decision.candidateId)])
        for (let index = 0; index < batch.length; index += 1) {
          const decision = ordered[index]
          if (decision?.candidateId !== batch[index].candidateId || !['risk', 'reminder', 'duplicate'].includes(decision.kind)
            || !textValue(decision.reason) || (decision.kind === 'duplicate' && !accepted.has(decision.duplicateOf))) throw unfinishedLaborOutput('问题核验标识或去重依据不完整')
          if (decision.kind === 'risk') accepted.add(decision.candidateId)
        }
        return ordered
      })
      decisions.push(...reviewed)
      reviewed.forEach((decision) => decisionMap.set(decision.candidateId, decision))
      await checkpoint('finding-quality', { signature: qualitySignature, decisions })
    }
    const retained = candidates.filter((candidate) => decisionMap.get(candidate.candidateId)?.kind === 'risk')
    qualityReminders = candidates.filter((candidate) => decisionMap.get(candidate.candidateId)?.kind === 'reminder')
      .map((candidate) => `执行核对：${candidate.title}。${decisionMap.get(candidate.candidateId).reason}`)
    combinedFindings = retained.map(({ candidateId, ...finding }) => finding)
    generated = { ...generated, findings: combinedFindings }
    const retainedKeys = new Set(combinedFindings.map(dedupeFindingKey))
    roundSnapshots = roundSnapshots.map((snapshot) => {
      const newFindings = snapshot.newFindings.filter((finding) => retainedKeys.has(dedupeFindingKey(finding)))
      return { ...snapshot, newFindings, newCount: newFindings.length }
    })
    await emit('review.delta', { content: renderLaborContractProgressReport(normalize(privacyRedactor.restoreDeep(generated))), replace: true })
  }

  if (!fakeLlm) {
    assertAllTopicChecks(generated, reviewTopics)
    let assessment = checkpointValue(getCheckpoint, 'assessment')
    if (!assessment || assessment.qualitySignature !== qualitySignature) {
      await emit('stage.start', { stage: 'assessment', label: '正在综合已确认问题判断整体分数' })
      assessment = await auxiliary('assessment', '你是企业合同审查助手。根据完整材料、已确认问题和用户关注点统一给出整体参考分数和简短结论，不新增问题、不改写条款。只返回 JSON {"score":0到100整数,"conclusion":"简短结论","complete":true}。',
        { ...extraContext, documents: relatedDocuments(JSON.stringify(combinedFindings)), focus: safeFocus, findings: combinedFindings.map(findingSummary), coverage: generated.coverage || generated.topicChecks })
      if (!Number.isInteger(assessment.score) || assessment.score < 0 || assessment.score > 100 || !assessment.conclusion?.trim()) throw createAnalysisOutputError('整体评估字段不完整', 'labor_analysis_assessment_invalid')
      assessment.qualitySignature = qualitySignature
      await checkpoint('assessment', assessment)
    }
    generated = { ...generated, score: assessment.score, conclusion: assessment.conclusion }
    await publishOverview(assessment.conclusion)
    await checkpoint('analysis-overview', { text: analysisOverview })
    await emit('stage.complete', { stage: 'assessment', summary: '整体评估完成' })
  }
  const restored = privacyRedactor.restoreDeep({ ...(generated || {}),
    contractInfo: privacyRedactor.restoreMetadataDeep(generated?.contractInfo),
    agreementInfo: privacyRedactor.restoreMetadataDeep(generated?.agreementInfo) })
  const result = normalize(restored)
  result.warnings = [...new Set([...result.warnings, ...privacyRedactor.restoreDeep(qualityReminders)])]
  result.analysisType = input.analysisType || 'ordinary_labor_contract'
  result.privacyNotice = LABOR_CONTRACT_REDACTION_NOTICE
  result.sourceTaskId = ['reanalyze', 'restart-analysis'].includes(input.action) ? input.sourceTaskId : task.id
  const reviewResult = makeLaborAnnotationResult(result, contractText)
  await emit('stage.complete', {
    stage: 'review',
    summary: `增量审查完成，执行 ${totalRoundsExecuted} 轮；${reviewResult.stats.confirmed} 项已定位到原文${reviewResult.stats.unresolved ? `，${reviewResult.stats.unresolved} 项待核对` : ''}`,
    annotationCount: reviewResult.stats.confirmed,
    reviewStats: { ...reviewResult.stats, rounds: totalRoundsExecuted },
    roundSnapshots
  })

  let revisionGroups = []
  let revisionStats = { uniqueIssues: 0, groups: 0, consolidated: 0, fallbackUsed: false }
  if (reviewResult.findings.length) {
    await emit('stage.start', { stage: 'consolidation', label: '正在归并同一条款的相关问题' })
    let consolidated = checkpointValue(getCheckpoint, 'consolidation')
    if (!consolidated) {
      let consolidationOutput = ''
      if (!fakeLlm && reviewResult.findings.length > 1) {
        try {
          consolidationOutput = await unit('consolidation', 'groups', ({ signal: unitSignal, timeoutMs }) =>
            consolidate(privacyRedactor.maskDeep(reviewResult.findings), getFlashModel(), { ...optionsForPhase('consolidation'), signal: unitSignal, requestTimeoutMs: timeoutMs, maxAttempts: 1 }))
        } catch (error) {
          ensureActive()
          await emit('stage.progress', { stage: 'consolidation', message: '智能归并暂不可用，正在按可信原文位置归并。' })
        }
      }
      consolidated = buildRevisionGroups({ findings: reviewResult.findings, agentOutput: consolidationOutput, contractText })
      await checkpoint('consolidation', consolidated)
    }
    revisionGroups = consolidated.groups
    revisionStats = consolidated.stats
    await emit('stage.complete', { stage: 'consolidation', summary: `归并为 ${revisionGroups.length} 组原文批注`, consolidationStats: revisionStats })
  }

  const reviewReport = renderLaborContractReviewReport(result, reviewResult)
  await emit('review.delta', { content: reviewReport, replace: true })
  let revisions = []
  let revisionTally = { modify: 0, add: 0, delete: 0 }
  if (!fakeLlm && revisionGroups.length) {
    const analysisReport = [result.conclusion, ...Object.entries(result.contractInfo || {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`)].join('\n')
    const savedRewrites = checkpointValue(getCheckpoint, 'rewrite-batches')
    const byId = new Map((savedRewrites?.revisions || []).map((item) => [item.findingId, item]))
    const readOnlyIds = laborReadOnlyGroupIds(revisionGroups, documents, readOnlyDocumentRoles)
    let serialOnly = savedRewrites?.serialOnly === true
    let commits = Promise.resolve()
    const snapshot = () => revisionGroups.map((group) => byId.get(group.id)).filter(Boolean)
    const commit = (items) => {
      const next = commits.then(async () => {
        ensureActive()
        for (const item of items) byId.set(item.findingId, item)
        await checkpoint('rewrite-batches', { revisions: snapshot(), serialOnly })
        await emit('rewrite.result', { revisions: snapshot(), partial: true, stats: { groups: revisionGroups.length, blocks: byId.size } })
        await emit('stage.progress', { stage: 'rewrite', message: `已完成 ${byId.size}/${revisionGroups.length} 组局部修订，批注已补到完整原文。`, validResults: byId.size })
      })
      commits = next.catch(() => {})
      return next
    }
    if (readOnlyIds.size) {
      const readOnlyGroups = revisionGroups.filter((group) => readOnlyIds.has(group.id))
      const notices = mergeRevisions(readOnlyGroups, JSON.stringify({ revisions: readOnlyGroups.map((group) => ({ findingId: group.id,
        action: 'modify', rewrittenText: group.originalText,
        riskNote: `配套材料仅用于交叉核对，保留原文；请要求签约方核对并依法处理：${group.advice || group.risk}` })) }), contractText).revisions
      notices.forEach((revision) => {
        revision.localizedEdits = revision.localizedEdits.map((edit) => ({ ...edit, operation: 'notice', replacementText: '' }))
      })
      await commit(notices)
    }
    const rewriteBatch = async (batch, repair = false) => {
      let pending = batch.filter((group) => repair || !byId.get(group.id)?.hasRewrite)
      if (!pending.length) return
      try {
        await unit('rewrite', pending.map((group) => group.id).join(','), async ({ signal: unitSignal, timeoutMs, progress }) => {
          pending = pending.filter((group) => repair || !byId.get(group.id)?.hasRewrite)
          if (!pending.length) return
          const output = await rewrite(privacyRedactor.maskDeep({ contractText, analysisReport, reviewReport, findings: pending,
            completedRevisions: snapshot().filter((revision) => !pending.some((group) => group.id === revision.findingId)) }),
            (content) => { progress.contentChars += content.length }, getFlashModel(), {
              systemPromptSuffix: `${rewriteSystemPrompt}\n${LABOR_CONTENT_QUALITY_RULES}${termContext}`, requireComplete: true,
              ...optionsForPhase('rewrite'),
              signal: unitSignal, requestTimeoutMs: timeoutMs, maxAttempts: 1
            })
          ensureActive()
          if (unitSignal.aborted) throw unfinishedLaborOutput('当前修订请求已中止')
          let parsed
          try { parsed = privacyRedactor.restoreDeep(JSON.parse(String(output).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))) }
          catch { throw unfinishedLaborOutput('修订数据不完整') }
          const allowed = new Set(pending.map((group) => group.id))
          const raw = Array.isArray(parsed.revisions) ? parsed.revisions : []
          if (raw.some((item) => !allowed.has(item.findingId)) || new Set(raw.map((item) => item.findingId)).size !== raw.length) throw unfinishedLaborOutput('修订标识不匹配')
          const validIds = new Set(raw.filter((item) => ['modify', 'add', 'delete'].includes(item.action)
            && typeof item.riskNote === 'string' && item.riskNote.trim()
            && (item.action === 'delete' || typeof item.rewrittenText === 'string' && item.rewrittenText.trim())).map((item) => item.findingId))
          const validGroups = pending.filter((group) => validIds.has(group.id))
          const merged = mergeRevisions(validGroups, JSON.stringify({ revisions: raw.filter((item) => validIds.has(item.findingId)) }), contractText)
          for (const item of merged.revisions) {
            // A deletion is complete without replacement text. Its source location is still mandatory.
            item.hasRewrite = item.action === 'delete' || item.hasRewrite
            if (item.action === 'add' && item.anchorStatus !== 'exact' && item.insertAfterLine < 0) throw unfinishedLaborOutput('新增条款缺少可信插入位置')
          }
          if (merged.revisions.length) await commit(merged.revisions)
          progress.completed = merged.revisions.length
          if (validGroups.length !== pending.length) throw unfinishedLaborOutput('当前修订批次缺少部分完整条款')
        }, async (error) => {
          if (error.code === 'LLM_HTTP_429' || /ECONNRESET|terminated/.test(error.message || '')) {
            serialOnly = true
            await commit([])
            await emit('stage.progress', { stage: 'rewrite', message: '模型连接不稳定，剩余修订自动改为逐批处理。' })
          }
        })
      } catch (error) {
        ensureActive()
        if (error.code === 'rewrite_output_truncated' && pending.length > 1) {
          const middle = Math.ceil(pending.length / 2)
          await rewriteBatch(pending.slice(0, middle), repair)
          await rewriteBatch(pending.slice(middle), repair)
        } else throw error
      }
    }
    await emit('stage.start', { stage: 'rewrite', label: '正在生成局部修订并补入完整原文' })
    await commit([])
    let dependencyPlan = checkpointValue(getCheckpoint, 'rewrite-dependencies')
    if (!dependencyPlan) {
      try {
        dependencyPlan = await auxiliary('dependencies', '核对企业合同修订组的条款依赖。只有明确互不依赖的组才能并行；原文范围重叠、相同插入位置、引用或前提相互依赖均串行，无法确定也串行。只返回 JSON {"independentIds":[组ID],"serialIds":[组ID],"dependencies":[[相关组ID,相关组ID]],"complete":true}，两个数组必须不重复且完整覆盖输入所有组。',
          { ...extraContext, documents: relatedDocuments(JSON.stringify(revisionGroups)), groups: revisionGroups.map(({ id, title, lineStart, lineEnd, originalText, risk, advice }) => ({ id, title, lineStart, lineEnd, originalText, risk, advice })) })
        const ids = [...(dependencyPlan.independentIds || []), ...(dependencyPlan.serialIds || [])]
        if (dependencyPlan.dependencies?.some((edge) => !Array.isArray(edge) || edge.some((id) => !ids.includes(id)))) throw new Error('依赖标识无效')
        if (ids.length !== revisionGroups.length || new Set(ids).size !== ids.length || ids.some((id) => !revisionGroups.some((group) => group.id === id))) throw new Error('依赖判定未完整覆盖修订组')
      } catch (error) {
        ensureActive()
        dependencyPlan = { independentIds: [], serialIds: revisionGroups.map((group) => group.id), complete: true }
        await emit('stage.progress', { stage: 'rewrite', message: '条款依赖未能确认，按逐批处理继续。' })
      }
      await checkpoint('rewrite-dependencies', dependencyPlan)
    }
    const batches = planLaborRevisionBatches(revisionGroups.filter((group) => !byId.get(group.id)?.hasRewrite), dependencyPlan)
    let cursor = 0
    while (cursor < batches.length) {
      ensureActive()
      const wave = [batches[cursor++]]
      if (!serialOnly && wave[0].parallel && batches[cursor]?.parallel) wave.push(batches[cursor++])
      const settled = await Promise.allSettled(wave.map((batch) => rewriteBatch(batch.groups)))
      const failed = settled.find((item) => item.status === 'rejected')
      if (failed) throw failed.reason
    }
    revisions = snapshot()
    await emit('stage.complete', { stage: 'rewrite', summary: `生成 ${revisions.length} 组原文批注`, revisionCount: revisions.length })
    await emit('stage.start', { stage: 'final-check', label: '正在核对批注位置及条款一致性' })
    let finalCheck = checkpointValue(getCheckpoint, 'revision-final-check')
    if (!finalCheck?.complete) {
      // Bound selective repairs, including a defect introduced by the preceding
      // repair. Passing a second check must not depend on rewriting all groups.
      const maxRepairPasses = 2
      for (let pass = 0; pass <= maxRepairPasses; pass += 1) {
        finalCheck = await auxiliary('final-check', `核对已生成修订的可执行性、条款一致性和重复修改。原合同仅作溯源：被modify/delete替代的旧表述不再生效，不把旧文字与新文字不同当作冲突。同组rewrittenText是完整条款，localizedEdits是它的局部表示，属于同一份修改的两种展示，不是重复执行两次；不能因同一句在两种表示中都出现而判冲突。只指出有效修订互相矛盾、同一处重复修改、修订与未修改条款直接冲突，或修订本身违反已提供的明确规则/仍未解决本组风险（如漏掉劳动者同意、扩大试用期解除范围）。不得从头审查合同、发现新的原合同问题或仅优化措辞；不因事实占位未填而报冲突。程序日期核对只描述原合同；有效修订已经替换原期限时，不把原来的短期限当成仍然生效的冲突。不少于二年并明确具体终止日期由双方书面确认的待确认方案，不要求替企业选定新日期；未填具体日期属于待确认事实。已合法划分主体且未排除法定义务，不能因没有写出全部配合事项就重复修复。不得凭记忆提出未给出的法律限制；每条冲突必须点明实际有效文字如何与给出的明确规则矛盾，不能仅以可能被理解、边界不完整为由扩写。notice仅是保留原文待核对，不当成生效修改。依据不足时不推定违法。不得重新生成修订。readOnlyMaterials和readOnlyNotices是所选企业无权修改的配套材料，只作交叉核对；其中已指出的不足仍须签约方处理，不要求在本次修订中消除。主协议要求签约方依法纠正配套合同不足，是纠正义务，不是与旧配套文字相冲突；不得因此要求同步改配套合同。返回 JSON {"conflicts":[{"groupIds":[输入中真实存在的findingId],"target":"revision|read_only|source|optional","quote":"target为revision时逐字引用可修改修订中的错误文字；仅delete操作可引用本次被删除的原文，modify不得引用旧表述","reason":"具体条件及修复要求"}],"complete":true}。target=revision才是本次必须修复的错误；仅配套原件不合规、原合同新发现问题、可选措辞优化分别标read_only/source/optional，不得混入revision。conflicts仅放必须修复的问题，绝对不能放“无冲突”“符合规则”“核对通过”等通过记录；全部通过时必须返回{"conflicts":[],"complete":true}，不需要逐组解释。\n${LABOR_CONTENT_QUALITY_RULES}`,
          { ...extraContext, documents: relatedDocuments(JSON.stringify(revisionGroups)), laws: safeLaws,
            readOnlyMaterials: safeDocuments.filter((document) => readOnlyDocumentRoles.includes(document.role)).map(({ fileName, role }) => ({ fileName, role })),
            readOnlyNotices: snapshot().filter((revision) => readOnlyIds.has(revision.findingId)).map(({ findingId, originalText, riskNote }) => ({ findingId, originalText, riskNote })),
            groups: revisionGroups.filter((group) => !readOnlyIds.has(group.id)).map(({ id, title, risk, advice }) => ({ id, title, risk, advice })),
            revisions: snapshot().filter((revision) => !readOnlyIds.has(revision.findingId)).map(({ findingId, action, lineStart, lineEnd, insertAfterLine, rewrittenText, localizedEdits }) => ({
            findingId, action, lineStart, lineEnd, insertAfterLine, rewrittenText,
            localizedEdits: (localizedEdits || []).map(({ operation, targetQuote, replacementText }) => ({ operation, targetQuote, replacementText }))
          })) }, (payload) => validateLaborRevisionCheck(privacyRedactor.restoreDeep(payload), snapshot(), readOnlyIds))
        for (const reminder of finalCheck.reminders || []) if (!result.warnings.includes(reminder)) result.warnings.push(reminder)
        if (!Array.isArray(finalCheck.conflicts)) throw createAnalysisOutputError('最终核对字段不完整', 'labor_revision_check_invalid')
        finalCheck.conflicts.push(...auditLaborRevisionPositions(snapshot(), contractText))
        finalCheck.conflicts.push(...auditLaborRevisionDefaults(snapshot(), contractText))
        finalCheck.conflicts.push(...auditLaborMonthlyDates(snapshot()))
        finalCheck.conflicts.push(...auditLaborOccupationalResponsibilities(snapshot(), documents))
        if (!finalCheck.conflicts.length) break
        const repairIds = new Set(finalCheck.conflicts.flatMap((item) => item.groupIds || []))
        if (!repairIds.size || [...repairIds].some((id) => !revisionGroups.some((group) => group.id === id))) throw createAnalysisOutputError('冲突组标识无效', 'labor_revision_check_invalid')
        if (pass === maxRepairPasses) throw Object.assign(new Error('条款冲突修复后仍未通过核对，已保留批注成果。'), { code: 'labor_revision_conflict', unitRetryExhausted: true })
        for (const group of revisionGroups.filter((item) => repairIds.has(item.id))) {
          const reasons = finalCheck.conflicts.filter((item) => item.groupIds.includes(group.id)).map((item) => item.reason).join('；')
          await rewriteBatch([{ ...group, repairInstructions: reasons }], true)
        }
      }
      await checkpoint('revision-final-check', finalCheck)
    }
    revisions = snapshot()
    revisions.forEach((revision) => { revisionTally[revision.action] = (revisionTally[revision.action] || 0) + (Number(revision.issueCount) || 1) })
    await emit('stage.complete', { stage: 'final-check', summary: '批注位置及条款一致性核对完成' })
  }

  result.schemaVersion = 3
  result.reviewReport = renderLaborContractReviewReport(result, reviewResult)
  result.analysisOverview = privacyRedactor.restore(analysisOverview || result.conclusion || '')
  result.analysis = result.reviewReport
  result.review = result.reviewReport
  result.reviewRounds = roundSnapshots
  result.reviewStoppedEarly = totalRoundsExecuted < LABOR_REVIEW_ROUNDS && roundSnapshots.at(-1)?.newCount === 0
  // The annotated original belongs to the durable conversation. Uploaded files
  // and parsing/redaction scratch checkpoints follow the material retention policy.
  result.sourceDocuments = documents.map(({ fileId, fileName, role, text }) => ({ fileId, fileName, role, text }))
  result.reviewStats = { ...reviewResult.stats, rounds: totalRoundsExecuted }
  result.revisions = revisions
  result.revisionStats = {
    rounds: totalRoundsExecuted,
    uniqueIssues: revisionStats.uniqueIssues || reviewResult.findings.length,
    groups: revisionGroups.length,
    blocks: revisions.length,
    ...revisionTally
  }
  result.annotationStats = reviewResult.stats
  result.evidenceReferences = evidence.map((item) => ({ evidenceId: item.id, name: item.sourceName, title: item.title, kind: item.sourceType, referenceRole: item.referenceRole || '' }))
  result.lawRecords = lawPromptCatalog.map((law) => ({ title: law.title, effectiveFrom: law.effectiveFrom, effectiveTo: law.effectiveTo, verificationStatus: law.verificationStatus, sourceUrl: law.sourceUrl }))
  result.warnings = [...new Set(result.warnings || [])]
  if (fakeLlm) result.fake = true

  await checkpoint('analysis', { result })
  await emit('rewrite.result', { revisions, stats: result.revisionStats })
  await emit('analysis.result', { resultAvailable: true, findingCount: result.findings.length, annotationCount: reviewResult.stats.confirmed })
  await emit('stage.complete', { stage: 'analysis', summary: `劳动合同分析完成：${result.findings.length} 项提示，${revisions.length} 条原文批注` })
  return result
}

function buildFakeAnalysis(documents) {
  const source = documents.map((item) => item.text).join('\n')
  const employer = source.match(/(?:甲方|用人单位)[：:]\s*([^\n]+)/)?.[1]?.trim() || ''
  const employee = source.match(/(?:乙方|劳动者)[：:]\s*([^\n]+)/)?.[1]?.trim() || ''
  return {
    contractInfo: { employer, employee, contractType: '劳动合同', applicabilityContext: 'Fake LLM 测试结果，不包含法律判断。' },
    topicChecks: LABOR_CONTRACT_ANALYSIS_TOPICS.map(({ id, label }) => ({ id, topic: label, status: 'unclear', summary: 'Fake LLM 测试结果；未执行法律判断。' })),
    missingItems: [],
    findings: [],
    contextQuestions: [],
    analysisNotes: ['Fake LLM 测试结果；未执行法律判断。']
  }
}

function createLawPromptCatalog(laws, resolveStatus) {
  return laws.slice(0, 80).map((law) => ({
    title: law.title,
    aliases: Array.isArray(law.aliases) ? law.aliases : [],
    versionLabel: law.versionLabel || '',
    effectiveFrom: law.effectiveFrom || '',
    effectiveTo: law.effectiveTo || '',
    status: law.status || '',
    reviewStatus: law.reviewStatus || 'pending',
    verificationStatus: resolveStatus(law),
    sourceUrl: /^https:\/\//i.test(String(law.sourceUrl || '')) ? law.sourceUrl : ''
  }))
}

export function createLaborContractAnalysisWorkflow({
  parseFile = extractText,
  retrieveEvidence = searchEvidence,
  getLawCatalog = listLawsForBaseline,
  resolveStatus = resolveLawStatus,
  generate,
  streamGenerate,
  consolidate = consolidateContractFindings,
  rewrite = rewriteContract,
} = {}) {
  const optionsFor = ({ mode, signal, requestTimeoutMs, maxTokens }) => ({
    model: mode === 'fast' ? getFlashModel() : getProModel(), temperature: 0.15,
    maxTokens: maxTokens || MAX_MODEL_OUTPUT_TOKENS,
    thinking: { type: mode === 'fast' ? 'disabled' : 'enabled' },
    ...(mode === 'fast' ? {} : { reasoningEffort: 'low' }),
    responseFormat: { type: 'json_object' }, signal, requestTimeoutMs, maxAttempts: 1
  })
  const generateCompletion = generate || (async (request) => chatDetailed(request.systemPrompt, request.userMessage, optionsFor(request)))
  const streamCompletion = streamGenerate || (!generate ? async function* (request) {
    yield* streamChat(request.systemPrompt, request.userMessage, optionsFor(request))
  } : null)
  return async function runLaborContractAnalysis({
    task,
    input = {},
    files = [],
    sourceDocuments = [],
    privacyAliases = [],
    emit = async () => {},
    checkpoint = async () => {},
    getCheckpoint = () => null,
    isCancellationRequested = () => false,
    updateFileParseStatus = () => {},
    signal,
    fakeLlm = false
  } = {}) {
    if (!task?.id) throw new Error('缺少任务信息')
    if (!files.length && !sourceDocuments.length) throw new Error('请至少上传一个劳动合同文件')
    for (const file of files) {
      if (!isValidAttachment(file)) throw new Error(`${file.originalname || '文件'} 文件类型暂不支持`)
    }
    const ensureActive = () => { if (signal?.aborted || isCancellationRequested?.()) throw new TaskCancelledError() }
    const warnings = []

    let parsed = checkpointValue(getCheckpoint, 'parsing')
    if (!Array.isArray(parsed?.documents) || !parsed.documents.some((item) => item.text?.trim())) {
      await emit('stage.start', { stage: 'parsing', label: '正在读取劳动合同文件' })
      const documents = []
      const parseErrors = []
      const fileRefsById = new Map((Array.isArray(input.fileRefs) ? input.fileRefs : []).map((fileRef) => [String(fileRef?.id || ''), fileRef]))
      for (const file of files) {
        ensureActive()
        await emit('stage.progress', { stage: 'parsing', message: `正在解析：${file.originalname || '上传文件'}` })
        try {
          const result = await parseFile(file)
          const text = String(result?.text || '').trim()
          updateFileParseStatus(file.id, text ? 'succeeded' : 'empty')
          if (text) documents.push({
            fileId: String(file.id || ''),
            fileName: String(file.originalname || file.originalName || '上传文件'),
            role: String(file.role || fileRefsById.get(String(file.id || ''))?.role || ''),
            pageCount: Number(result?.pageCount) || null,
            text, parseMetadata: result.metadata
          })
          else parseErrors.push(`${file.originalname || '上传文件'}：未提取到可分析文本`)
        } catch (error) {
          updateFileParseStatus(file.id, 'failed')
          parseErrors.push(`${file.originalname || '上传文件'}：${textValue(error.message, 400) || '解析失败'}`)
        }
      }
      if (!files.length && sourceDocuments.length) {
        documents.push(...sourceDocuments.filter((item) => item?.text?.trim()))
      }
      if (!documents.length) {
        const failure = new Error(`文件解析失败：${parseErrors.join('；') || '未提取到可用文字'}`)
        failure.code = 'labor_contract_parse_failed'
        throw failure
      }
      const totalLength = documents.reduce((sum, item) => sum + item.text.length, 0)
      if (totalLength > MAX_CONTRACT_TEXT) {
        const failure = new Error(`劳动合同正文超过 ${MAX_CONTRACT_TEXT} 字符，请拆分文件后重试`)
        failure.code = 'labor_contract_text_too_long'
        throw failure
      }
      parsed = { documents, parseErrors, totalLength }
      // Reanalysis borrows the original task's text. Do not create a second
      // full-text checkpoint that would silently extend the source lifetime.
      if (files.length && !['reanalyze', 'restart-analysis'].includes(input.action)) await checkpoint('parsing', parsed)
      await emit('stage.complete', { stage: 'parsing', summary: `解析完成，提取 ${totalLength} 个字符`, fileCount: documents.length })
    } else {
      parsed.totalLength = parsed.totalLength || parsed.documents.reduce((sum, item) => sum + String(item.text || '').length, 0)
      await emit('stage.start', { stage: 'parsing', label: '正在恢复已保存的文本解析结果' })
      await emit('stage.complete', { stage: 'parsing', summary: `已恢复 ${parsed.totalLength} 个字符`, recovered: true })
    }
    warnings.push(...listOfText(parsed.parseErrors, 6, 500))
    ensureActive()

    const isDispatchEmploymentContract = parsed.documents.some((document) => document.role === 'dispatch_employment_contract')
    const dispatchMaterial = parsed.documents.some((document) =>
      /劳务派遣(?:劳动)?(?:合同|协议)|(?:派遣单位|用工单位).{0,40}(?:被派遣劳动者|派遣劳动者)/s.test(document.text))
    if (dispatchMaterial && input.analysisType !== 'labor_dispatch_agreement' && !isDispatchEmploymentContract) {
      await emit('stage.start', { stage: 'analysis', label: '正在确认材料是否属于首版范围' })
      const result = {
        schemaVersion: 1,
        productId: 'labor-contract-analysis',
        analysisStatus: 'scope-confirmation-required',
        contractInfo: { contractType: '疑似劳务派遣合同/协议' },
        topicChecks: LABOR_CONTRACT_ANALYSIS_TOPICS.map(({ id, label }) => ({
          id, topic: label, status: 'unclear', summary: '材料类型是否纳入首版范围尚待确认，未作此项分析。'
        })),
        missingItems: [{
          topic: '材料类型', item: '请确认劳务派遣合同/协议是否纳入首版分析范围。',
          reason: '当前首版范围限于普通劳动合同。', location: { status: 'not-found', matches: [] }
        }],
        findings: [],
        contextQuestions: ['劳务派遣合同/协议是否纳入首版分析范围，待 Mentor 确认。'],
        warnings: [...new Set([...warnings, '检测到劳务派遣相关材料；范围未确认前不生成风险结论。'])],
        reviewStatus: 'draft-pending-mentor-and-legal-review',
        generatedAt: new Date().toISOString()
      }
      await checkpoint('analysis', { result })
      await emit('stage.complete', { stage: 'analysis', summary: '材料范围待确认，未执行风险分析' })
      return result
    }

    const focus = textValue(input.focus || task.prompt, 16000)
    const existingPrivacyAliases = [
      ...(Array.isArray(privacyAliases) ? privacyAliases : []),
      ...(Array.isArray(input.privacyAliases) ? input.privacyAliases : []),
      ...(checkpointValue(getCheckpoint, 'privacy')?.aliases || [])
    ]
    let privacyRedactor = createLaborContractRedactor({
      documents: parsed.documents,
      aliases: existingPrivacyAliases,
      extraTexts: [focus]
    })
    let knowledge = checkpointValue(getCheckpoint, 'knowledge')
    if (!knowledge) {
      await emit('stage.start', { stage: 'knowledge', label: '正在检索劳动合同范本与风险规则' })
      let evidence = []
      let laws = []
      let retrievalFailure = ''
      try {
        const topics = LABOR_CONTRACT_ANALYSIS_TOPICS.map((topic) => ({ ...topic }))
        if (focus) topics.push({ id: 'user-focus', label: '用户侧重点', query: privacyRedactor.mask(focus).slice(0, 500) })
        const retrieved = await retrieveEvidence({ contractType: '劳动合同', topics }, {
          limit: DEFAULT_EVIDENCE_LIMIT,
          perDocumentCap: 5
        })
        // 防止检索器降级或索引元数据异常时把商业合同资料混进结果。
        evidence = (Array.isArray(retrieved) ? retrieved : [])
          .filter((item) => item.contractType === '劳动合同' && ['clause', 'risk_rule'].includes(item.kind))
      } catch (error) {
        retrievalFailure = `劳动合同范本/风险规则检索不可用：${textValue(error.message, 300) || '未知原因'}`
        warnings.push(retrievalFailure)
        await emit('stage.progress', { stage: 'knowledge', message: '劳动合同参考资料暂时不可用；结果会明确标注该来源缺失' })
      }
      try {
        const listed = await getLawCatalog()
        laws = Array.isArray(listed) ? listed : []
      } catch (error) {
        const message = `法规白名单暂时不可用：${textValue(error.message, 300) || '未知原因'}`
        warnings.push(message)
        await emit('stage.progress', { stage: 'knowledge', message })
      }
      const safeEvidence = sanitizeEvidence(evidence)
      const lawPromptCatalog = createLawPromptCatalog(laws, resolveStatus)
      knowledge = { evidence: safeEvidence, laws, lawPromptCatalog, retrievalFailure }
      await checkpoint('knowledge', knowledge)
      await emit('stage.complete', {
        stage: 'knowledge',
        summary: `劳动合同参考资料 ${safeEvidence.length} 条；法规白名单记录 ${lawPromptCatalog.length} 条`,
        evidenceCount: safeEvidence.length,
        lawCount: lawPromptCatalog.length
      })
    } else {
      await emit('stage.start', { stage: 'knowledge', label: '正在恢复劳动合同专属资料检索结果' })
      await emit('stage.complete', {
        stage: 'knowledge',
        summary: `已恢复参考资料 ${knowledge.evidence?.length || 0} 条和法规记录 ${knowledge.lawPromptCatalog?.length || 0} 条`,
        recovered: true
      })
      if (knowledge.retrievalFailure) warnings.push(knowledge.retrievalFailure)
    }
    if (!knowledge.evidence?.length && !knowledge.retrievalFailure) warnings.push('没有检索到劳动合同范本或风险规则；该辅助对照来源未参与本次分析。')
    privacyRedactor = createLaborContractRedactor({
      documents: parsed.documents,
      aliases: privacyRedactor.aliases,
      extraTexts: [focus, knowledge.evidence || [], knowledge.lawPromptCatalog || []]
    })
    await checkpoint('privacy', { aliases: privacyRedactor.aliases, version: 'selective-pseudonymization-v1' })
    ensureActive()

    const savedAnalysis = checkpointValue(getCheckpoint, 'analysis')?.result
    if (savedAnalysis) {
      await emit('stage.start', { stage: 'analysis', label: '正在恢复已保存的结构化分析结果' })
      await emit('analysis.result', { resultAvailable: true, recovered: true })
      await emit('stage.complete', { stage: 'analysis', summary: '已恢复结构化风险分析结果', recovered: true })
      return { ...savedAnalysis, warnings: [...new Set([...(savedAnalysis.warnings || []), ...warnings])] }
    }

    await emit('stage.start', { stage: 'analysis', label: '正在按最多三轮增量方式审查劳动合同' })
    if (!checkpointValue(getCheckpoint, 'review') && !checkpointValue(getCheckpoint, 'analysis-overview')) {
      await emit('analysis.reset', { reason: 'generation-start' })
    }
    const evidence = knowledge.evidence || []
    const lawPromptCatalog = knowledge.lawPromptCatalog || createLawPromptCatalog(knowledge.laws || [], resolveStatus)
    const result = await executeLaborContractReview({
      task,
      input,
      documents: parsed.documents,
      focus,
      evidence,
      laws: knowledge.laws || [],
      lawPromptCatalog,
      resolveStatus,
      privacyRedactor,
      emit,
      checkpoint,
      getCheckpoint,
      ensureActive,
      signal,
      fakeLlm,
      generateCompletion,
      streamCompletion,
      consolidate,
      rewrite
    })
    result.warnings = [...new Set([...(result.warnings || []), ...warnings])]
    await checkpoint('analysis', { result })
    return result
  }
}

export const runLaborContractAnalysis = createLaborContractAnalysisWorkflow()

export function createLaborContractFollowupWorkflow({
  generate,
  streamGenerate,
  systemPrompt = LABOR_CONTRACT_FOLLOWUP_SYSTEM_PROMPT,
  messageBuilder = buildLaborContractFollowupMessage,
  expiredSourceMessage = '这段历史没有保存可回看的合同原文。现在只能解释旧报告；要核对条款、发现新风险或重新评分，请重新上传合同生成新版报告。'
} = {}) {
  const generateCompletion = generate || ((userMessage, mode, signal) => chatDetailed(
    systemPrompt,
    userMessage,
    {
      model: mode === 'fast' ? getFlashModel() : getProModel(),
      temperature: 0.2,
      maxTokens: MAX_MODEL_OUTPUT_TOKENS,
      thinking: { type: mode === 'fast' ? 'disabled' : 'enabled' },
      ...(mode === 'fast' ? {} : { reasoningEffort: 'low' }),
      signal
    }
  ))
  const streamCompletion = streamGenerate || (!generate ? async function* (userMessage, mode, signal) {
    yield* streamChat(systemPrompt, userMessage, {
      model: mode === 'fast' ? getFlashModel() : getProModel(),
      temperature: 0.2,
      maxTokens: MAX_MODEL_OUTPUT_TOKENS,
      thinking: { type: mode === 'fast' ? 'disabled' : 'enabled' },
      ...(mode === 'fast' ? {} : { reasoningEffort: 'low' }),
      signal
    })
  } : null)

  return async function runLaborContractFollowup({
    task, input = {}, report, sourceDocuments = [], history = [],
    privacyAliases = [], emit = async () => {}, checkpoint = async () => {}, getCheckpoint = () => null,
    isCancellationRequested = () => false, signal, fakeLlm = false
  } = {}) {
    if (!report || report.productId !== 'labor-contract-analysis' || report.analysisStatus !== 'completed') {
      throw new Error('原分析报告不可用，请重新上传合同分析。')
    }
    const question = textValue(input.message || task?.prompt, 16000)
    if (!question) throw new Error('请输入追问内容')
    const saved = checkpointValue(getCheckpoint, 'analysis')?.result
    if (saved) return saved
    await emit('stage.start', { stage: 'analysis', label: sourceDocuments.length ? '正在结合合同原文回答' : '正在解释已保存的报告' })
    const privacyRedactor = createLaborContractRedactor({
      documents: sourceDocuments,
      aliases: privacyAliases,
      extraTexts: [report, history, question]
    })
    const messageContext = {
      question: privacyRedactor.mask(question),
      report: privacyRedactor.maskDeep(report),
      documents: sourceDocuments.length ? [{ fileName: '本轮相关原文', text: formatMaterialBlocks(selectMaterialBlocks(privacyRedactor.maskDocuments(sourceDocuments), question, 24000).blocks) + '\n' + privacyRedactor.mask(indexedMaterialText(input.materialIndex)) + '\n' + (input.materialNotice || '') }] : [],
      history: []
    }
    // Each serialized item is a complete question/answer pair. Preserve all
    // pairs that fit alongside the actual report, source excerpts and output.
    const selectedHistory = selectHistoryByTokens(privacyRedactor.maskDeep(history)
      .map((item) => ({ role: 'user', content: JSON.stringify(item) })),
    CONTEXT_WINDOW_TOKENS - MAX_MODEL_OUTPUT_TOKENS - CONTEXT_SAFETY_TOKENS
      - estimateTokens(systemPrompt + messageBuilder(messageContext)) - 64)
    const userMessage = messageBuilder({ ...messageContext, history: selectedHistory.history.map((item) => JSON.parse(item.content)) })
    const reportOnlyExplanation = /解释|说明|理解|含义|什么意思|为什么|扣分原因|报告中的/.test(question)
      && !/重新分析|重新评分|重新打分|重新核对|新风险|新增风险|再检查|有没有遗漏/.test(question)
    let response = !sourceDocuments.length && !reportOnlyExplanation
      ? { content: expiredSourceMessage }
      : fakeLlm
        ? { content: sourceDocuments.length ? '这是基于合同原文与已有报告的测试追问回复。' : '这是对旧报告的解释；历史没有保存合同原文，不能重新判断合同。' }
        : null
    let streamedAnswer = ''
    if (!response && streamCompletion) {
      let pending = ''
      let lastEmitAt = Date.now()
      let emittedRawLength = 0
      const emitRestorablePrefix = async (final = false) => {
        let safeEnd = final ? streamedAnswer.length : Math.max(0, streamedAnswer.length - Math.max(1, privacyRedactor.maxTokenLength))
        if (!final && safeEnd > emittedRawLength) {
          for (const alias of privacyRedactor.aliases) {
            if (!alias.token) continue
            let at = streamedAnswer.indexOf(alias.token, Math.max(0, emittedRawLength - alias.token.length + 1))
            while (at >= 0 && at < safeEnd) {
              const end = at + alias.token.length
              if (at < safeEnd && end > safeEnd) safeEnd = at
              at = streamedAnswer.indexOf(alias.token, at + alias.token.length)
            }
          }
        }
        if (safeEnd <= emittedRawLength) return
        pending += privacyRedactor.restore(streamedAnswer.slice(emittedRawLength, safeEnd))
        emittedRawLength = safeEnd
        if (pending.length >= 96 || (pending && Date.now() - lastEmitAt >= 140) || final) {
          await emit('followup.delta', { content: pending })
          pending = ''
          lastEmitAt = Date.now()
        }
      }
      for await (const chunk of streamCompletion(userMessage, task?.mode, signal)) {
        if (signal?.aborted || isCancellationRequested()) throw new TaskCancelledError()
        const content = typeof chunk?.content === 'string' ? chunk.content : ''
        streamedAnswer += content
        await emitRestorablePrefix()
        if (chunk?.finishReason === 'length') response = { content: streamedAnswer, finishReason: 'length' }
      }
      await emitRestorablePrefix(true)
      if (!response) response = { content: streamedAnswer }
    } else if (!response && !fakeLlm) {
      response = normalizeModelResponse(await generateCompletion(userMessage, task?.mode, signal))
      if (response.content) await emit('followup.delta', { content: privacyRedactor.restore(response.content) })
    } else if (response?.content) {
      await emit('followup.delta', { content: response.content })
    }
    if (signal?.aborted || isCancellationRequested()) throw new TaskCancelledError()
    if (response.finishReason === 'length') throw createAnalysisOutputError('劳动合同追问回复达到长度限制，未生成完整答案。', 'labor_followup_output_truncated')
    const answerText = String(privacyRedactor.restore(response.content) || '').trim()
    const answer = answerText && (selectedHistory.droppedMessages
      ? `本轮上下文未纳入较早的 ${selectedHistory.droppedMessages} 次完整问答；如需结合早期讨论，请补充相关内容。\n\n${answerText}`
      : answerText)
    if (!answer) throw createAnalysisOutputError('劳动合同追问未返回内容，请稍后重试。', 'labor_followup_output_empty')
    const result = {
      schemaVersion: 2,
      productId: 'labor-contract-analysis',
      kind: 'followup',
      analysisType: input.analysisType || report.analysisType || 'ordinary_labor_contract',
      reviewPerspective: input.reviewPerspective || report.reviewPerspective || '',
      sourceTaskId: input.sourceTaskId,
      reportTaskId: input.reportTaskId,
      sourceAvailable: sourceDocuments.length > 0,
      answer,
      generatedAt: new Date().toISOString()
    }
    await checkpoint('analysis', { result })
    await emit('stage.complete', { stage: 'analysis', summary: '追问回复已保存' })
    return result
  }
}

export const runLaborContractFollowup = createLaborContractFollowupWorkflow()
