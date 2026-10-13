/**
 * 改写结果配对与校验。
 *
 * 设计纪律（与 annotation-locator.js 一致）：
 * - 原句、行号、风险等级等"可信字段"一律来自服务端 buildReviewResult 产出的 finding；
 *   绝不被 Agent 3 的输出覆盖。
 * - Agent 3 只负责"如何修订"：action(改/增/删)、rewrittenText、riskNote。
 * - 漏配或解析失败的 finding，用 advice/replacement 兜底，保证每条风险都有对应的修订块。
 */
import { findQuoteRanges, findQuoteSpansInRange, isClauseHeadingLine, locationTokens, normalizeForMatch } from './annotation-locator.js'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 从可能被 maxTokens 截断的 JSON 文本中抢救出完整的 revisions 数组。
 *
 * 截断通常发生在某个 revision 的字符串值中间（如 rewrittenText 写到一半），
 * 此时整体 JSON.parse 必然失败。但前面已经完整结束的 `},` 边界可以抢救：
 * 通过字符级扫描，跟踪字符串内外状态与括号深度，找到最后一个"完整的 revision 对象"
 * 的结束位置，截断到那里后补全 `]}` 即可重新解析。
 *
 * @param {string} text - Agent 3 的原始输出（可能含 ```json 围栏）
 * @returns {Array|null} 抢救出的 revisions 数组；无法抢救时返回 null
 */
const recoverTruncatedRevisions = (text = '') => {
  const trimmed = String(text).trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || trimmed

  // 定位 "revisions" 数组的起始 `[`
  const revisionsKey = candidate.match(/"revisions"\s*:\s*\[/)
  if (!revisionsKey) return null
  const arrayStart = revisionsKey.index + revisionsKey[0].length - 1 // 指向 `[`
  if (arrayStart < 0 || arrayStart >= candidate.length) return null

  let inString = false
  let escape = false
  let depth = 0
  let lastCompleteObjEnd = -1 // 最后一个完整 revision 对象结束后的位置（`]` 之前）

  for (let i = arrayStart + 1; i < candidate.length; i += 1) {
    const ch = candidate[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = false }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { depth += 1; continue }
    if (ch === '}') {
      depth -= 1
      // depth 回到数组层（顶层 revision 对象刚结束）：记录这个完整边界
      if (depth === 0) lastCompleteObjEnd = i
      continue
    }
    // 遇到顶层的 `]`（数组结束）或 `}`（对象结束，说明 revisions 已正常关闭）
    if (ch === ']' && depth === 0) {
      // 数组正常结束，无需截断修复，直接尝试整体解析
      break
    }
  }

  if (lastCompleteObjEnd < 0) return null
  // 截断到最后一个完整对象，补全 `]}` 闭合 revisions 数组和外层对象
  const recovered = candidate.slice(0, lastCompleteObjEnd + 1) + ']}'
  try {
    const parsed = JSON.parse(recovered)
    return Array.isArray(parsed?.revisions) ? parsed.revisions : null
  } catch {
    return null
  }
}

const extractRevisionJson = (output = '') => {
  const trimmed = String(output).trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || trimmed
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('改写模型没有返回 JSON 对象')
  try {
    return JSON.parse(candidate.slice(first, last + 1))
  } catch {
    throw new Error('改写模型返回的 JSON 格式不完整')
  }
}

const normalizeAction = (value) => {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'add' || text === '新增' || text === '补充' || text === '插入') return 'add'
  if (text === 'delete' || text === '删除' || text === 'remove' || text === '移除') return 'delete'
  return 'modify'
}

const asSequence = (value, fallback) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

// add 锚点解析：优先使用 Agent 3 给出的逐字 insertAfterQuote；无法唯一确认时，
// 标题锚点插入到所属条款末尾，普通锚点插入到 finding 行后；再失败则 unresolved，不猜位置。
const resolveAddAnchor = ({ finding, matched, contractLines }) => {
  const lineStart = Number.isInteger(finding?.lineStart) ? finding.lineStart : -1
  const lineEnd = Number.isInteger(finding?.lineEnd) ? finding.lineEnd : lineStart
  const clauseEnd = Number.isInteger(finding?.clauseEnd) ? finding.clauseEnd : -1
  const insertAfterQuote = asText(matched?.insertAfterQuote)

  if (insertAfterQuote && contractLines.length) {
    const ranges = findQuoteRanges(contractLines, insertAfterQuote)
    let chosen = null
    let anchorStatus = 'verified'
    if (ranges.length === 1) {
      chosen = ranges[0]
    } else if (ranges.length > 1) {
      const tokens = locationTokens(finding?.location || '')
      const locationLines = tokens.length
        ? contractLines.map((line, index) => ({ line, index })).filter(({ line }) => tokens.some((token) => line.includes(token))).map(({ index }) => index)
        : []
      chosen = ranges.toSorted((left, right) => {
        const distance = (range) => locationLines.length
          ? Math.min(...locationLines.map((line) => Math.abs(range.end - line)))
          : Math.abs(range.end - lineEnd)
        return distance(left) - distance(right)
      })[0]
      anchorStatus = 'code-located'
    }
    if (chosen && Number.isInteger(chosen.end) && contractLines[chosen.end]) {
      return {
        insertAfterLine: chosen.end,
        anchorText: String(contractLines[chosen.end] || '').trim(),
        anchorStatus
      }
    }
  }

  if (lineStart >= 0 && contractLines[lineStart] && isClauseHeadingLine(contractLines[lineStart]) && clauseEnd >= lineStart && contractLines[clauseEnd]) {
    return {
      insertAfterLine: clauseEnd,
      anchorText: String(contractLines[lineStart] || '').trim(),
      anchorStatus: 'code-located'
    }
  }

  if (lineEnd >= 0 && contractLines[lineEnd]) {
    return {
      insertAfterLine: lineEnd,
      anchorText: String(contractLines[lineEnd] || '').trim() || asText(finding?.originalText),
      anchorStatus: 'code-located'
    }
  }

  return { insertAfterLine: -1, anchorText: asText(finding?.originalText), anchorStatus: 'unresolved' }
}

const normalizeEditOperation = (value, fallbackAction = 'modify') => {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'delete' || text === '删除') return 'delete'
  if (text === 'notice' || text === '提示' || text === '提醒') return 'notice'
  if (text === 'insert-after' || text === 'insert' || text === 'add' || text === '新增' || text === '插入') return 'insert-after'
  return fallbackAction === 'delete' ? 'delete' : 'replace'
}

const nearestQuoteMatch = ({ contractLines, quote, preferredLines = [], allowedStart = 0, allowedEnd = contractLines.length - 1 }) => {
  const ranges = findQuoteRanges(contractLines, quote)
    .filter((range) => range.start >= allowedStart && range.end <= allowedEnd)
  if (!ranges.length) return null
  const chosen = ranges.toSorted((left, right) => {
    const distance = (range) => preferredLines.length
      ? Math.min(...preferredLines.map((line) => Math.abs(range.start - line)))
      : Math.abs(range.start - allowedStart)
    return distance(left) - distance(right)
  })[0]
  const spanInfo = findQuoteSpansInRange(contractLines, chosen, quote)
  if (spanInfo.quoteStatus !== 'exact' || !spanInfo.quoteSpans.length) return null
  return {
    lineStart: chosen.start,
    lineEnd: chosen.end,
    targetQuote: spanInfo.quoteText,
    quoteSpans: spanInfo.quoteSpans
  }
}

const compactNotes = (members, field) => {
  const notes = [...new Set(members.map((member) => asText(member?.[field])).filter(Boolean))]
  if (notes.length <= 1) return notes[0] || ''
  return notes.map((note, index) => `${CIRCLED_NUMBERS[index] || `${index + 1}.`}${note}`).join(' ')
}

const buildFallbackLocalizedEdits = ({ finding, contractLines, usedIds, fallbackAction }) => {
  const members = Array.isArray(finding.memberFindings) && finding.memberFindings.length
    ? finding.memberFindings
    : [finding]
  const groups = new Map()
  members.forEach((member) => {
    if (!member?.id || usedIds.has(member.id)) return
    const quote = asText(member.quoteText)
    const spans = Array.isArray(member.quoteSpans) ? member.quoteSpans.filter((span) =>
      span && Number.isInteger(span.line) && Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start
    ) : []
    if (!quote || !spans.length) return
    const key = `${spans[0].line}:${spans.at(-1).line}:${normalizeForMatch(quote)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(member)
  })

  const edits = []
  groups.forEach((groupMembers) => {
    const first = groupMembers[0]
    const spans = first.quoteSpans
    const replacement = asText(first.replacement)
    const usableReplacement = replacement && replacement.length <= 900 ? replacement : ''
    const operation = fallbackAction === 'delete' ? 'delete' : usableReplacement ? 'replace' : 'notice'
    const memberFindingIds = groupMembers.map((member) => member.id)
    memberFindingIds.forEach((id) => usedIds.add(id))
    edits.push({
      editId: `${finding.id}-local-${edits.length + 1}`,
      memberFindingIds,
      operation,
      targetQuote: asText(first.quoteText),
      replacementText: operation === 'replace' ? usableReplacement : '',
      riskNote: compactNotes(groupMembers, 'advice') || compactNotes(groupMembers, 'risk'),
      lineStart: spans[0].line,
      lineEnd: spans.at(-1).line,
      quoteSpans: spans.map((span) => ({ ...span })),
      localizationStatus: 'finding-fallback'
    })
  })
  return edits
}

// 把 Agent 3 的完整条款改写拆成可就近展示的局部编辑。模型字段只在逐字锚点、成员覆盖和长度
// 全部通过代码校验后采用；缺失或不合规成员回退到 Agent 2 已验证的 quoteSpans。
const resolveLocalizedEdits = ({ finding, matched, contractLines, action }) => {
  if (action === 'add') return []
  const allowedIds = new Set(
    Array.isArray(finding.memberFindingIds) && finding.memberFindingIds.length
      ? finding.memberFindingIds
      : [finding.id]
  )
  const members = Array.isArray(finding.memberFindings) && finding.memberFindings.length
    ? finding.memberFindings
    : [finding]
  const membersById = new Map(members.map((member) => [member.id, member]))
  const allowedStart = Number.isInteger(finding.lineStart) ? finding.lineStart : 0
  // 局部编辑只能落在当前修订组已经确认的行范围内。clauseEnd 可能覆盖整个大条款，
  // 若用它作上界，同名短句可能被错误匹配到组内问题之外，重新制造“大段标注”。
  const allowedEnd = Number.isInteger(finding.lineEnd) && finding.lineEnd >= allowedStart
    ? finding.lineEnd
    : allowedStart
  const usedIds = new Set()
  const edits = []

  const rawEdits = Array.isArray(matched?.localizedEdits) ? matched.localizedEdits : []
  rawEdits.forEach((rawEdit) => {
    const memberFindingIds = [...new Set(
      (Array.isArray(rawEdit?.memberFindingIds) ? rawEdit.memberFindingIds : [])
        .filter((id) => typeof id === 'string' && allowedIds.has(id) && !usedIds.has(id))
    )]
    if (!memberFindingIds.length) return
    const targetQuote = asText(rawEdit?.targetQuote)
    const replacementText = asText(rawEdit?.replacementText)
    let operation = normalizeEditOperation(rawEdit?.operation, action)
    if (!targetQuote || targetQuote.length > 600 || (operation !== 'delete' && operation !== 'notice' && !replacementText) || replacementText.length > 900) return
    const preferredLines = memberFindingIds
      .map((id) => membersById.get(id)?.lineStart)
      .filter(Number.isInteger)
    const located = nearestQuoteMatch({ contractLines, quote: targetQuote, preferredLines, allowedStart, allowedEnd })
    if (!located) return
    // 兼容模型未使用 notice 的旧输出：若“替换文字”与原片段没有实质区别，
    // 这不是改写而是提醒，避免前端把原句照抄渲染成“改为”。
    if (operation === 'replace' && replacementText && normalizeForMatch(replacementText) === normalizeForMatch(targetQuote)) {
      operation = 'notice'
    }
    // replacementText 若等于完整 rewrittenText 且明显长于目标片段，说明模型没有执行局部化协议。
    const fullRewrite = normalizeForMatch(matched?.rewrittenText || '')
    if (fullRewrite && normalizeForMatch(replacementText) === fullRewrite && replacementText.length > located.targetQuote.length * 1.5) return
    memberFindingIds.forEach((id) => usedIds.add(id))
    const editMembers = memberFindingIds.map((id) => membersById.get(id)).filter(Boolean)
    edits.push({
      editId: `${finding.id}-local-${edits.length + 1}`,
      memberFindingIds,
      operation,
      targetQuote: located.targetQuote,
      replacementText: operation === 'delete' || operation === 'notice' ? '' : replacementText,
      riskNote: asText(rawEdit?.riskNote) || compactNotes(editMembers, 'advice') || compactNotes(editMembers, 'risk'),
      lineStart: located.lineStart,
      lineEnd: located.lineEnd,
      quoteSpans: located.quoteSpans,
      localizationStatus: 'agent-verified'
    })
  })

  edits.push(...buildFallbackLocalizedEdits({ finding, contractLines, usedIds, fallbackAction: action }))
  return edits
    .sort((left, right) => left.lineStart - right.lineStart || left.quoteSpans[0].start - right.quoteSpans[0].start)
    .map((edit, index) => ({ ...edit, editId: `${finding.id}-local-${index + 1}` }))
}

const sortLineForRevision = (revision) => {
  if (revision.action === 'add') return revision.insertAfterLine >= 0 ? revision.insertAfterLine : Number.MAX_SAFE_INTEGER
  return Number.isInteger(revision.lineStart) ? revision.lineStart : Number.MAX_SAFE_INTEGER
}

const sortRevisions = (revisions) => revisions.sort((left, right) => {
  const lineDiff = sortLineForRevision(left) - sortLineForRevision(right)
  if (lineDiff) return lineDiff
  const sequenceDiff = (left.sequence || 0) - (right.sequence || 0)
  if (sequenceDiff) return sequenceDiff
  return String(left.findingId).localeCompare(String(right.findingId))
})

/**
 * 把可信的 findings 与 Agent 3 的 revisions 按 findingId（或顺序）配对。
 *
 * @param {Array} findings - canonical findings 或归并后的修订组（含可信 originalText/lineStart/lineEnd/quoteSpans）
 * @param {string} agentOutput - Agent 3 返回的完整 JSON 文本，形如 { revisions: [{ findingId, action, rewrittenText, riskNote, insertAfterQuote?, sequence? }] }
 * @param {string} contractText - 原合同全文，用于解析 add 的 insertAfterQuote 与条款末尾锚点
 * @returns {{ revisions: Array, stats: object, recovered: boolean, matchedIds: string[] }}
 */
export function mergeRevisions(findings = [], agentOutput = '', contractText = '') {
  const contractLines = String(contractText || '').split('\n')
  let payload = { revisions: [] }
  let recovered = false
  try {
    payload = extractRevisionJson(agentOutput)
  } catch (error) {
    // 整体解析失败：尝试从被截断的 JSON 中抢救完整的 revisions
    const salvaged = recoverTruncatedRevisions(agentOutput)
    if (salvaged && salvaged.length) {
      payload = { revisions: salvaged }
      recovered = true
      console.warn(`[revision-merger] Recovered ${salvaged.length} revisions from truncated JSON`)
    } else {
      console.warn('[revision-merger] Agent 3 output parse failed:', error.message)
    }
  }
  const rawRevisions = Array.isArray(payload?.revisions) ? payload.revisions : []

  // 按 findingId 建索引；同时保留原始顺序，用于 findingId 缺失时按位置回退。
  const revisionById = new Map()
  rawRevisions.forEach((rev) => {
    const id = asText(rev?.findingId)
    if (id) revisionById.set(id, rev)
  })

  const revisions = []
  const tally = { modify: 0, add: 0, delete: 0 }
  const matchedIds = []

  findings.forEach((finding, index) => {
    const positional = rawRevisions[index]
    const matched =
      revisionById.get(finding.id) ||
      revisionById.get(`finding-${index + 1}`) ||
      // Legacy outputs may omit the ID. An explicitly different ID is not
      // evidence that this rewrite belongs to the finding at the same index.
      (!asText(positional?.findingId) ? positional : null)

    const action = matched ? normalizeAction(matched.action) : 'modify'
    const agentRewrittenText = asText(matched?.rewrittenText)
    const rewrittenText = agentRewrittenText || asText(finding.replacement) || ''
    // 批注说明优先用 Agent 3 的 riskNote，兜底用 finding 的 advice / risk。
    const riskNote = asText(matched?.riskNote) || asText(finding.advice) || asText(finding.risk) || ''
    const sequence = asSequence(matched?.sequence, index + 1)
    const addAnchor = action === 'add'
      ? resolveAddAnchor({ finding, matched, contractLines })
      : { insertAfterLine: -1, anchorText: '', anchorStatus: 'not-applicable' }
    const localizedEdits = resolveLocalizedEdits({ finding, matched, contractLines, action })

    if (matched) matchedIds.push(finding.id)
    tally[action] += 1
    revisions.push({
      findingId: finding.id,
      // 归并追踪字段：单条 finding 也统一保留为一成员组，便于统计和审计。
      memberFindingIds: Array.isArray(finding.memberFindingIds) && finding.memberFindingIds.length
        ? finding.memberFindingIds.slice()
        : [finding.id],
      issueCount: Number.isInteger(finding.issueCount) && finding.issueCount > 0
        ? finding.issueCount
        : (Array.isArray(finding.memberFindingIds) && finding.memberFindingIds.length ? finding.memberFindingIds.length : 1),
      relation: asText(finding.relation) || 'independent',
      memberFindings: Array.isArray(finding.memberFindings) ? finding.memberFindings.map((member) => ({ ...member })) : [],
      // 可信字段：来自服务端 finding，强制覆盖
      level: finding.level,
      title: finding.title,
      location: finding.location,
      anchor: finding.anchor,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      originalText: finding.originalText,
      quoteText: asText(finding.quoteText),
      quoteSpans: Array.isArray(finding.quoteSpans) ? finding.quoteSpans : [],
      quoteStatus: finding.quoteStatus === 'exact' ? 'exact' : 'none',
      clauseEnd: Number.isInteger(finding.clauseEnd) ? finding.clauseEnd : -1,
      risk: finding.risk,
      advice: finding.advice,
      evidence: finding.evidence,
      // Agent 3 产出字段
      action,
      rewrittenText,
      riskNote,
      localizedEdits,
      sequence,
      insertAfterLine: addAnchor.insertAfterLine,
      anchorText: addAnchor.anchorText,
      anchorStatus: addAnchor.anchorStatus,
      // 标记本条是否成功匹配到 Agent 3 的改写输出（用于分批补全判断）
      hasRewrite: Boolean(agentRewrittenText)
    })
  })

  sortRevisions(revisions)

  return {
    revisions,
    stats: {
      total: revisions.length,
      matched: matchedIds.length,
      modify: tally.modify,
      add: tally.add,
      delete: tally.delete
    },
    recovered,
    matchedIds
  }
}

const LEVEL_RANK = { 高: 3, 中: 2, 低: 1 }
const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

// 同锚点 add 合并：纯粹是"渲染前的展示归并"，必须在匹配/分批补全全部完成后调用。
// insertAfterLine 相同的多条 add（如围绕同一条款的补充约定）按 sequence 排序后合并为一个修订块：
// rewrittenText 依序拼接成连贯段落，riskNote 编号罗列，level 取最高，findingId 用复合形式。
// stats 不做调整——统计口径始终保持 per-finding，与审查报告一致。
export function coalesceAdjacentAdds(revisions = []) {
  const groupsByAnchor = new Map()
  revisions.forEach((rev) => {
    if (rev?.action !== 'add' || !Number.isInteger(rev.insertAfterLine) || rev.insertAfterLine < 0) return
    if (!groupsByAnchor.has(rev.insertAfterLine)) groupsByAnchor.set(rev.insertAfterLine, [])
    groupsByAnchor.get(rev.insertAfterLine).push(rev)
  })

  // findingId -> 合并块（组首）或 null（被吞并的成员）
  const mergedByFindingId = new Map()
  groupsByAnchor.forEach((group) => {
    if (group.length < 2) return
    const sorted = group.slice().sort((left, right) => (left.sequence || 0) - (right.sequence || 0))
    const first = sorted[0]
    const texts = sorted.map((rev) => asText(rev.rewrittenText)).filter(Boolean)
    const notes = sorted.map((rev) => asText(rev.riskNote)).filter(Boolean)
    const memberFindingIds = [...new Set(sorted.flatMap((rev) =>
      Array.isArray(rev.memberFindingIds) && rev.memberFindingIds.length ? rev.memberFindingIds : [rev.findingId]
    ))]
    const issueCount = sorted.reduce((sum, rev) => sum + (Number(rev.issueCount) || 1), 0)
    mergedByFindingId.set(first.findingId, {
      ...first,
      findingId: sorted.map((rev) => rev.findingId).join('+'),
      memberFindingIds,
      issueCount,
      mergedFindingIds: memberFindingIds,
      mergedCount: issueCount,
      level: sorted.reduce((top, rev) => (LEVEL_RANK[rev.level] || 0) > (LEVEL_RANK[top] || 0) ? rev.level : top, first.level),
      rewrittenText: texts.join('\n'),
      riskNote: notes.length > 1
        ? notes.map((note, index) => `${CIRCLED_NUMBERS[index] || `${index + 1}.`}${note}`).join(' ')
        : (notes[0] || asText(first.riskNote)),
      hasRewrite: sorted.every((rev) => rev.hasRewrite)
    })
    sorted.slice(1).forEach((rev) => mergedByFindingId.set(rev.findingId, null))
  })

  if (!mergedByFindingId.size) return revisions
  return revisions
    .map((rev) => mergedByFindingId.has(rev.findingId) ? mergedByFindingId.get(rev.findingId) : rev)
    .filter(Boolean)
}
