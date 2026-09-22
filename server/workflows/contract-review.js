import { extractText } from '../services/file-parser.js'
import { searchEvidence, DEFAULT_EVIDENCE_LIMIT } from '../services/knowledge-base.js'
import { buildReviewPlan, withTypeNoticeInResult, withTypeNoticeInReport } from '../services/review-plan.js'
import { buildReviewResult, renderReviewReport, extractReviewPayload, findingSimilarity } from '../services/annotation-locator.js'
import { buildRevisionGroups } from '../services/finding-consolidator.js'
import { mergeRevisions, coalesceAdjacentAdds } from '../services/revision-merger.js'
import { createReviewSession, publicReviewSession } from '../services/review-session-store.js'
import { analyzeContract } from '../agents/contract-analyzer.js'
import { reviewContract } from '../agents/contract-reviewer.js'
import { consolidateContractFindings } from '../agents/contract-consolidator.js'
import { rewriteContract } from '../agents/contract-rewriter.js'
import { getFlashModel, getProModel } from '../services/llm-client.js'

export const MAX_CONTRACT_TEXT = 60000
export const REVIEW_ROUNDS = 3

export const ACCEPTED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'application/json',
  'application/xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/gif'
]

export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message)
    this.name = 'TaskCancelledError'
    this.code = 'TASK_CANCELLED'
  }
}

const dedupeKey = (item) => {
  const title = String(item?.title || '').replace(/\s+/g, '').trim()
  const quote = String(item?.quote || '').replace(/\s+/g, '').trim()
  return `${title}::${quote}`
}

const modelFor = (mode) => mode === 'fast'
  ? { model: getFlashModel(), thinking: { type: 'disabled' }, maxTokens: 2048 }
  : { model: getProModel(), thinking: { type: 'enabled' }, reasoningEffort: 'high', maxTokens: 4096 }

const isValidAttachment = (file) => ACCEPTED_TYPES.includes(file?.mimetype) ||
  /\.(pdf|doc|docx|rtf|odt|xls|xlsx|ods|ppt|pptx|odp|txt|md|markdown|csv|tsv|json|xml|html|htm|png|jpg|jpeg|webp|bmp|tif|tiff|gif)$/i.test(file?.originalname || '')

const checkpointValue = (getCheckpoint, stage) => {
  const value = getCheckpoint?.(stage)
  return value?.result || null
}

const fakeRevision = (text) => {
  const lines = String(text || '').split('\n')
  const line = lines.findIndex((item) => item.trim())
  if (line < 0) return []
  const original = lines[line]
  const start = original.search(/\S|$/)
  const end = original.length
  return [{
    findingId: 'fake-finding-1',
    memberFindingIds: ['fake-finding-1'],
    action: 'modify',
    level: '中',
    title: '示例风险：请结合交易背景复核该条款',
    location: `第 ${line + 1} 行`,
    quoteText: original.trim(),
    originalText: original.trim(),
    rewrittenText: `${original.trim()}（请补充明确的履约和违约责任）`,
    riskNote: '这是 Fake LLM 的演示结果，正式环境需配置模型并由人工复核。',
    lineStart: line,
    lineEnd: line,
    quoteSpans: [{ line, start, end }],
    localizedEdits: []
  }]
}

const runFakeWorkflow = async ({ task, files, emit, checkpoint, getCheckpoint, isCancellationRequested }) => {
  const ensure = () => { if (isCancellationRequested?.()) throw new TaskCancelledError() }
  ensure()
  let parsedText = checkpointValue(getCheckpoint, 'parsing')?.parsedText || ''
  if (!parsedText) {
    await emit('stage.start', { stage: 'parsing', label: '正在解析上传的合同文件' })
    const parts = []
    for (const file of files) {
      ensure()
      await emit('stage.progress', { stage: 'parsing', message: `正在解析: ${file.originalname}` })
      const parsed = await extractText(file)
      if (parsed?.text?.trim()) parts.push(parsed.text.trim())
    }
    parsedText = parts.join('\n\n')
    if (!parsedText) throw new Error('文件解析失败：未提取到可用文字')
    if (parsedText.length > MAX_CONTRACT_TEXT) throw new Error(`合同正文超过 ${MAX_CONTRACT_TEXT} 字符，请拆分文件后重试`)
    await checkpoint('parsing', { parsedText })
    await emit('stage.complete', { stage: 'parsing', summary: `文件解析完成，共提取 ${parsedText.length} 个字符`, textLength: parsedText.length })
  } else {
    await emit('stage.start', { stage: 'parsing', label: '正在恢复文件解析检查点' })
    await emit('stage.complete', { stage: 'parsing', summary: '已从检查点恢复文件解析结果', textLength: parsedText.length, recovered: true })
  }

  ensure()
  let analysis = checkpointValue(getCheckpoint, 'analysis')?.analysisReport || ''
  if (!analysis) {
    await emit('stage.start', { stage: 'analysis', label: '正在分析合同结构与要素完整性' })
    analysis = 'Fake LLM：已完成合同结构分析。正式环境将由结构分析 Agent 输出详细报告。'
    await emit('analysis.delta', { content: analysis })
    await checkpoint('analysis', { analysisReport: analysis })
    await emit('stage.complete', { stage: 'analysis', summary: '合同结构分析完成', reportLength: analysis.length })
  } else {
    await emit('stage.start', { stage: 'analysis', label: '正在恢复合同分析检查点' })
    await emit('analysis.delta', { content: analysis })
    await emit('stage.complete', { stage: 'analysis', summary: '已从检查点恢复合同分析结果', reportLength: analysis.length, recovered: true })
  }

  ensure()
  await emit('stage.start', { stage: 'knowledge', label: '正在检索合同条款与风险证据' })
  await emit('stage.progress', { stage: 'knowledge', message: 'Fake LLM 模式：使用空证据集完成平台链路验证' })
  await checkpoint('knowledge', { evidence: [], reviewPlan: null })
  await emit('templates.found', { count: 0, names: [], references: [] })
  await emit('stage.complete', { stage: 'knowledge', summary: '匹配到 0 条可追溯知识证据' })

  ensure()
  const review = 'Fake LLM：已完成风险审查。请在正式环境配置模型后复核具体风险结论。'
  const findings = fakeRevision(parsedText).map((revision) => ({
    level: revision.level,
    title: revision.title,
    location: revision.location,
    quote: revision.quoteText,
    risk: revision.riskNote,
    suggestion: revision.rewrittenText
  }))
  await emit('stage.start', { stage: 'review', label: '正在进行三轮合同合规与履约风险审查' })
  await emit('review.round', { round: 1, total: 1, phase: 'start', accumulated: 0, message: 'Fake LLM 正在进行示例审查' })
  await emit('review.delta', { content: review })
  await emit('review.round', { round: 1, total: 1, phase: 'end', newFindings: findings, newCount: findings.length, accumulated: findings.length, message: 'Fake LLM 示例审查完成' })
  const reviewResult = {
    conclusion: 'Fake LLM 示例结果，仅用于任务平台开发测试',
    findings,
    completeness: [],
    stats: { generated: findings.length, confirmed: findings.length, unresolved: 0 }
  }
  await checkpoint('review', { reviewResult, roundSnapshots: [{ round: 1, newCount: findings.length, newFindings: findings }] })
  await emit('stage.complete', { stage: 'review', summary: `示例审查完成，${findings.length} 条批注已定位到原文`, annotationCount: findings.length, reviewStats: reviewResult.stats, roundSnapshots: [{ round: 1, newCount: findings.length, newFindings: findings }] })

  ensure()
  await emit('stage.start', { stage: 'consolidation', label: '正在汇总重复及关联问题' })
  const revisions = fakeRevision(parsedText)
  const reviewReport = findings.length ? `### 风险审查\n\n- **${findings[0].title}**：${findings[0].risk}` : review
  await checkpoint('consolidation', { revisions, reviewReport, consolidationStats: { uniqueIssues: revisions.length, groups: revisions.length, fallbackUsed: true } })
  await emit('review.delta', { content: reviewReport })
  await emit('stage.complete', { stage: 'consolidation', summary: `问题归并完成，${revisions.length} 个修订组`, consolidationStats: { uniqueIssues: revisions.length, groups: revisions.length, fallbackUsed: true } })

  ensure()
  await emit('stage.start', { stage: 'rewrite', label: '正在依据审查结果生成修订稿' })
  const rewritePayload = { contractText: parsedText, revisions, stats: { rounds: 1, total: revisions.length, groups: revisions.length, blocks: revisions.length, matched: revisions.length, modify: revisions.length, add: 0, delete: 0, fake: true } }
  await checkpoint('rewrite', { rewritePayload })
  await emit('stage.complete', { stage: 'rewrite', summary: `示例修订稿生成完成，共 ${revisions.length} 个标记`, revisionCount: revisions.length, blockCount: revisions.length })
  const reviewSession = { id: task.id, stats: reviewResult.stats }
  await emit('review.original', { text: parsedText, reviewSession })
  await emit('rewrite.result', rewritePayload)
  await emit('done', { elapsed: '0.0', mode: task.mode, model: 'fake', reportLength: reviewReport.length, stages: ['parsing', 'analysis', 'knowledge', 'review', 'consolidation', 'rewrite'] })
  return { ...rewritePayload, analysis, review, reviewRounds: [{ round: 1, newCount: findings.length, newFindings: findings }], reviewStats: reviewResult.stats, reviewReport, reviewSession, fake: true }
}

export async function runContractReview({
  task,
  files = [],
  emit = async () => {},
  checkpoint = async () => {},
  getCheckpoint = () => null,
  isCancellationRequested = () => false,
  updateFileParseStatus = () => {},
  fakeLlm = String(process.env.TASK_FAKE_LLM || '').toLowerCase() === 'true'
} = {}) {
  if (!task?.id) throw new Error('缺少任务信息')
  if (!files.length) throw new Error('请至少上传一个合同文件')
  for (const file of files) {
    if (!isValidAttachment(file)) throw new Error(`${file.originalname || '文件'} 文件类型暂不支持`)
  }
  if (fakeLlm) return runFakeWorkflow({ task, files, emit, checkpoint, getCheckpoint, isCancellationRequested })

  const startedAt = Date.now()
  const mode = task.mode === 'fast' ? 'fast' : 'thinking'
  const modelProfile = modelFor(mode)
  const ensure = () => { if (isCancellationRequested?.()) throw new TaskCancelledError() }

  let parsedText = checkpointValue(getCheckpoint, 'parsing')?.parsedText || ''
  if (!parsedText) {
    await emit('stage.start', { stage: 'parsing', label: '正在解析上传的合同文件' })
    const parseErrors = []
    const parts = []
    for (const file of files) {
      ensure()
      await emit('stage.progress', { stage: 'parsing', message: `正在解析: ${file.originalname}` })
      try {
        const result = await extractText(file)
        updateFileParseStatus(file.id, result?.text?.trim() ? 'succeeded' : 'empty')
        if (result?.text?.trim()) parts.push(result.text.trim())
        else parseErrors.push(`${file.originalname}: 未提取到文本内容`)
      } catch (error) {
        updateFileParseStatus(file.id, 'failed')
        parseErrors.push(`${file.originalname}: ${error.message}`)
      }
    }
    parsedText = parts.join('\n\n')
    if (!parsedText) throw new Error(`文件解析失败：${parseErrors.join('；') || '未提取到可用文字'}`)
    if (parsedText.length > MAX_CONTRACT_TEXT) throw new Error(`合同正文超过 ${MAX_CONTRACT_TEXT} 字符，暂不支持一次性审查；请拆分文件后重试`)
    if (parseErrors.length) await emit('stage.progress', { stage: 'parsing', message: `部分文件解析异常: ${parseErrors.join('；')}` })
    await checkpoint('parsing', { parsedText, parseErrors })
    await emit('stage.complete', { stage: 'parsing', summary: `文件解析完成，共提取 ${parsedText.length} 个字符`, textLength: parsedText.length })
  } else {
    await emit('stage.start', { stage: 'parsing', label: '正在恢复文件解析检查点' })
    await emit('stage.complete', { stage: 'parsing', summary: '已从检查点恢复文件解析结果', textLength: parsedText.length, recovered: true })
  }

  ensure()
  let analysisReport = checkpointValue(getCheckpoint, 'analysis')?.analysisReport || ''
  if (!analysisReport) {
    await emit('stage.start', { stage: 'analysis', label: '正在分析合同结构与要素完整性' })
    analysisReport = await analyzeContract(parsedText, (chunk) => emit('analysis.delta', { content: chunk }), modelProfile.model)
    await checkpoint('analysis', { analysisReport })
    await emit('stage.complete', { stage: 'analysis', summary: '合同结构分析完成', reportLength: analysisReport.length })
  } else {
    await emit('stage.start', { stage: 'analysis', label: '正在恢复合同分析检查点' })
    await emit('analysis.delta', { content: analysisReport })
    await emit('stage.complete', { stage: 'analysis', summary: '已从检查点恢复合同分析结果', reportLength: analysisReport.length, recovered: true })
  }

  ensure()
  let evidence = checkpointValue(getCheckpoint, 'knowledge')?.evidence || []
  let reviewPlan = checkpointValue(getCheckpoint, 'knowledge')?.reviewPlan || null
  await emit('stage.start', { stage: 'knowledge', label: '正在检索合同条款与风险证据' })
  if (!reviewPlan) {
    reviewPlan = buildReviewPlan({ analysisReport, contractText: parsedText, userInstruction: task.prompt })
    await emit('stage.progress', { stage: 'knowledge', message: `审查计划：${reviewPlan.contractType}｜${reviewPlan.topics.map((topic) => topic.label).join('、')}` })
    try {
      // 证据条数取自 knowledge-base.js 的唯一定义，避免生产与评测各写一个值
      evidence = await searchEvidence(reviewPlan, { limit: DEFAULT_EVIDENCE_LIMIT, subType: reviewPlan.subType })
      await emit('templates.found', {
        count: evidence.length,
        // 内部诊断：类型判定的来源、Agent 1 声明过但库内没有的类型名、是否需要问用户。
        // 前端不渲染这个字段；留痕是为了出问题时能回放到具体某次请求。
        diagnostics: { typeResolution: reviewPlan.typeResolution, subType: reviewPlan.subType },
        names: [...new Set(evidence.map((item) => item.sourceName))],
        references: evidence.map((item) => ({ evidenceId: item.evidenceId, name: item.sourceName, contractType: item.contractType, role: item.referenceRole || 'reference', kind: item.kind, clauseNo: item.clauseNo, category: item.category }))
      })
    } catch (error) {
      console.warn('[task-workflow] Knowledge base search failed:', error.message)
      evidence = []
      await emit('stage.progress', { stage: 'knowledge', message: '知识库检索暂时不可用，将继续进行审查' })
    }
    await checkpoint('knowledge', { evidence, reviewPlan })
  } else {
    await emit('stage.progress', { stage: 'knowledge', message: '已从检查点恢复审查计划和风险证据' })
  }
  await emit('stage.complete', { stage: 'knowledge', summary: `匹配到 ${evidence.length} 条可追溯知识证据`, recovered: Boolean(checkpointValue(getCheckpoint, 'knowledge')) })

  ensure()
  const reviewCheckpoint = checkpointValue(getCheckpoint, 'review')
  const combinedFindings = Array.isArray(reviewCheckpoint?.combinedFindings) ? [...reviewCheckpoint.combinedFindings] : []
  const accumulatedSummary = Array.isArray(reviewCheckpoint?.accumulatedSummary) ? [...reviewCheckpoint.accumulatedSummary] : []
  const roundSnapshots = Array.isArray(reviewCheckpoint?.roundSnapshots) ? [...reviewCheckpoint.roundSnapshots] : []
  const seenKeys = new Set(combinedFindings.map(dedupeKey))
  let totalRoundsExecuted = Number(reviewCheckpoint?.totalRoundsExecuted) || 0
  let reviewResult = reviewCheckpoint?.reviewResult || null
  await emit('stage.start', { stage: 'review', label: '正在进行三轮合同合规与履约风险审查' })

  if (!reviewResult) {
    for (let round = totalRoundsExecuted + 1; round <= REVIEW_ROUNDS; round += 1) {
      ensure()
      await emit('review.round', { round, total: REVIEW_ROUNDS, phase: 'start', accumulated: combinedFindings.length, message: `正在进行第 ${round} 轮审查（共 ${REVIEW_ROUNDS} 轮）${round > 1 ? `，前 ${round - 1} 轮已发现 ${combinedFindings.length} 条问题` : ''}` })
      const roundOutput = await reviewContract({
        contractText: parsedText,
        analysisReport,
        evidence,
        reviewPlan,
        userInstruction: task.prompt,
        round,
        previousFindings: accumulatedSummary
      }, modelProfile.model)
      let roundPayload
      try { roundPayload = extractReviewPayload(roundOutput) } catch (error) {
        console.warn(`[task-workflow] review round ${round} payload parse failed:`, error.message)
        roundSnapshots.push({ round, newCount: 0, newFindings: [] })
        totalRoundsExecuted = round
        await checkpoint('review', { combinedFindings, accumulatedSummary, roundSnapshots, totalRoundsExecuted })
        await emit('review.round', { round, total: REVIEW_ROUNDS, phase: 'end', newFindings: [], newCount: 0, accumulated: combinedFindings.length, message: `第 ${round} 轮审查结果解析异常，已跳过` })
        continue
      }
      const newFindings = []
      let dropped = 0
      for (const candidate of Array.isArray(roundPayload.findings) ? roundPayload.findings : []) {
        const key = dedupeKey(candidate)
        if (seenKeys.has(key)) continue
        if (combinedFindings.some((existing) => findingSimilarity(candidate, existing).similar)) { dropped += 1; continue }
        seenKeys.add(key)
        combinedFindings.push(candidate)
        accumulatedSummary.push({ level: String(candidate?.level || '').trim() || '风险', title: String(candidate?.title || '').trim() || '未命名问题', location: String(candidate?.location || '').trim(), quote: String(candidate?.quote || '').replace(/\s+/g, '').slice(0, 80), risk: String(candidate?.risk || '').replace(/\s+/g, ' ').slice(0, 80) })
        newFindings.push({ level: String(candidate?.level || '').trim() || '风险', title: String(candidate?.title || '').trim() || '未命名问题', location: String(candidate?.location || '').trim(), risk: String(candidate?.risk || '').trim().slice(0, 120) })
      }
      roundSnapshots.push({ round, newCount: newFindings.length, dropped, newFindings })
      totalRoundsExecuted = round
      await checkpoint('review', { combinedFindings, accumulatedSummary, roundSnapshots, totalRoundsExecuted })
      await emit('review.round', { round, total: REVIEW_ROUNDS, phase: 'end', newFindings, newCount: newFindings.length, dropped, accumulated: combinedFindings.length, message: `第 ${round} 轮审查完成${newFindings.length ? `，新增 ${newFindings.length} 条问题（累计 ${combinedFindings.length} 条）` : '，未发现新问题'}` })
      if (!Array.isArray(roundPayload.findings) || roundPayload.findings.length === 0 || newFindings.length === 0) break
    }
    const mergedModelOutput = JSON.stringify({ conclusion: '三轮审查合并结果', findings: combinedFindings, completeness: [] })
    reviewResult = buildReviewResult({ contractText: parsedText, modelOutput: mergedModelOutput })
    if (reviewResult.stats.confirmed === 0) {
      await emit('stage.progress', { stage: 'review', message: '三轮未得到可定位批注，正在进行一次格式与定位复核' })
      try {
        const recoveryOutput = await reviewContract({ contractText: parsedText, analysisReport, evidence, reviewPlan, userInstruction: `${task.prompt || '无'}\n\n【系统复核】前三轮未生成可确认的风险批注。请重新逐条审查合同，必须输出完整 JSON；只要存在风险或需完善事项，就必须给出条款位置、尽量逐字的 quote、风险和建议。不要输出行号，定位由程序完成。` }, modelProfile.model)
        const recoveryResult = buildReviewResult({ contractText: parsedText, modelOutput: recoveryOutput })
        if (recoveryResult.stats.confirmed > 0 || recoveryResult.stats.generated > reviewResult.stats.generated) reviewResult = recoveryResult
      } catch (error) { console.warn('[task-workflow] Review recovery failed:', error.message) }
    }
    await checkpoint('review', { combinedFindings, accumulatedSummary, roundSnapshots, totalRoundsExecuted, reviewResult })
  } else {
    await emit('review.round', { round: totalRoundsExecuted || 1, total: totalRoundsExecuted || 1, phase: 'end', newFindings: [], newCount: 0, accumulated: reviewResult.findings?.length || combinedFindings.length, message: '已从检查点恢复风险审查结果', recovered: true })
  }
  // 类型没判出来时，在「完整性清单」里给用户一句可操作提示（后端注入，不让 LLM 自己判断）
  reviewResult = withTypeNoticeInResult(reviewResult, reviewPlan)
  const crossRoundDeduped = roundSnapshots.reduce((sum, item) => sum + (Number(item.dropped) || 0), 0)
  await emit('stage.complete', { stage: 'review', summary: `三轮审查完成（实际执行 ${totalRoundsExecuted} 轮），${reviewResult.stats.confirmed} 条批注已定位到原文${reviewResult.stats.unresolved ? `，${reviewResult.stats.unresolved} 条待核查` : ''}`, annotationCount: reviewResult.stats.confirmed, reviewStats: { ...reviewResult.stats, rounds: totalRoundsExecuted, crossRoundDeduped }, roundSnapshots })

  ensure()
  const consolidationCheckpoint = checkpointValue(getCheckpoint, 'consolidation')
  let revisionGroups = consolidationCheckpoint?.revisionGroups || null
  let consolidationStats = consolidationCheckpoint?.consolidationStats || null
  let reviewReport = consolidationCheckpoint?.reviewReport || ''
  await emit('stage.start', { stage: 'consolidation', label: '正在汇总重复及关联问题' })
  if (!revisionGroups) {
    let consolidationOutput = ''
    if (reviewResult.findings.length > 1) {
      try { consolidationOutput = await consolidateContractFindings(reviewResult.findings, modelProfile.model) } catch (error) {
        console.warn('[task-workflow] Consolidation Agent failed, using deterministic grouping:', error.message)
        await emit('stage.progress', { stage: 'consolidation', message: '智能归并暂时不可用，正在按原文位置进行确定性归并' })
      }
    }
    const consolidationResult = buildRevisionGroups({ findings: reviewResult.findings, agentOutput: consolidationOutput, contractText: parsedText })
    revisionGroups = consolidationResult.groups
    consolidationStats = consolidationResult.stats
    const consolidatedReviewResult = { ...reviewResult, findings: revisionGroups }
    reviewReport = renderReviewReport(consolidatedReviewResult)
    await checkpoint('consolidation', { revisionGroups, consolidationStats, reviewReport })
  }
  // 兜底：报告文本可能来自检查点恢复、没有重新渲染，这里再确保一次（幂等，不会重复）
  reviewReport = withTypeNoticeInReport(reviewReport, reviewPlan)
  if (reviewReport) await emit('review.delta', { content: reviewReport })
  await emit('stage.complete', { stage: 'consolidation', summary: `问题归并完成，${revisionGroups.length} 个修订组`, consolidationStats, recovered: Boolean(consolidationCheckpoint) })

  ensure()
  const rewriteCheckpoint = checkpointValue(getCheckpoint, 'rewrite')
  let rewritePayload = rewriteCheckpoint?.rewritePayload || null
  await emit('stage.start', { stage: 'rewrite', label: '正在依据审查结果进行最终校验并生成修订稿' })
  if (!rewritePayload) {
    rewritePayload = { contractText: parsedText, revisions: [], stats: { rounds: totalRoundsExecuted, total: 0, groups: 0, blocks: 0, modify: 0, add: 0, delete: 0 } }
    if (revisionGroups.length > 0) {
      let rewriteOutput = await rewriteContract({ contractText: parsedText, analysisReport, findings: revisionGroups }, () => {}, modelProfile.model)
      let merged = mergeRevisions(revisionGroups, rewriteOutput, parsedText)
      const missingGroups = merged.revisions.filter((rev) => !rev.hasRewrite).map((rev) => revisionGroups.find((group) => group.id === rev.findingId)).filter(Boolean)
      if (missingGroups.length) {
        try {
          const batchOutput = await rewriteContract({ contractText: parsedText, analysisReport, findings: missingGroups.slice(0, 6) }, () => {}, modelProfile.model)
          const batchMerged = mergeRevisions(missingGroups.slice(0, 6), batchOutput, parsedText)
          const recovered = new Map(batchMerged.revisions.filter((item) => item.hasRewrite).map((item) => [item.findingId, item]))
          merged.revisions = merged.revisions.map((item) => recovered.has(item.findingId) ? { ...item, ...recovered.get(item.findingId) } : item)
        } catch (error) { console.warn('[task-workflow] Rewrite recovery failed:', error.message) }
      }
      const finalTally = { modify: 0, add: 0, delete: 0 }
      merged.revisions.forEach((revision) => { finalTally[revision.action] = (finalTally[revision.action] || 0) + (Number(revision.issueCount) || 1) })
      const displayRevisions = coalesceAdjacentAdds(merged.revisions)
      const localizedEditCount = displayRevisions.reduce((sum, revision) => sum + (revision.action !== 'add' && Array.isArray(revision.localizedEdits) && revision.localizedEdits.length ? revision.localizedEdits.length : 0), 0)
      const displayBlockCount = displayRevisions.reduce((sum, revision) => sum + (revision.action !== 'add' && Array.isArray(revision.localizedEdits) && revision.localizedEdits.length ? revision.localizedEdits.length : 1), 0)
      rewritePayload = { contractText: parsedText, revisions: displayRevisions, stats: { rounds: totalRoundsExecuted, total: consolidationStats.uniqueIssues, matched: merged.revisions.reduce((sum, revision) => sum + (revision.hasRewrite ? (Number(revision.issueCount) || 1) : 0), 0), groups: revisionGroups.length, blocks: displayBlockCount, localizedEdits: localizedEditCount, consolidated: consolidationStats.consolidated, consolidationFallback: consolidationStats.fallbackUsed, ...finalTally } }
    }
    await checkpoint('rewrite', { rewritePayload })
  }
  await emit('stage.complete', { stage: 'rewrite', summary: rewritePayload.revisions.length ? `最终校验完成，生成 ${rewritePayload.revisions.length} 个就近修订标记` : '未发现需修订条款', revisionCount: rewritePayload.revisions.length, blockCount: rewritePayload.stats.blocks || rewritePayload.revisions.length, recovered: Boolean(rewriteCheckpoint) })

  ensure()
  const reviewSession = createReviewSession({ userId: task.userId, clientId: task.id, contractText: parsedText, analysisReport, reviewReport, reviewResult })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  await emit('review.original', { text: parsedText, reviewSession: publicReviewSession(reviewSession) })
  await emit('rewrite.result', rewritePayload)
  await emit('done', { elapsed, mode, model: modelProfile.model, reportLength: reviewReport.length, stages: ['parsing', 'analysis', 'knowledge', 'review', 'consolidation', 'rewrite'] })
  return { ...rewritePayload, analysis: analysisReport, review: reviewReport, reviewRounds: roundSnapshots, reviewStats: reviewResult.stats, reviewReport, reviewSession: publicReviewSession(reviewSession), evidenceReferences: evidence.map((item) => ({ evidenceId: item.evidenceId, name: item.sourceName, contractType: item.contractType, category: item.category })) }
}

export { isValidAttachment }
