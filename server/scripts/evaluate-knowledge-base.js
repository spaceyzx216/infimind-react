/**
 * 对已批注坏例执行离线检索回归评测。
 * 不调用审查模型：将风险条款作为查询，排除它自己的源文件，衡量知识库是否
 * 仍能召回同类型的风险模式和正向条款。
 *
 * 度量分两层，另配精度与解耦自检（见「第二阶段计划表-知识库调优」v3 §4.1）：
 *   - 候选层：diversifyEvidence **之前**的候选池。对 limit / cap 都不敏感，量「检索质量」
 *   - 最终层：生产口径实际交付的证据。量「交付质量」
 *   - 精度  ：该层里 category 命中期望类别的条数占比。防止靠加证据条数刷召回
 *   - 解耦矩阵：同一个池下扫 (limit × cap)，候选层应恒定、最终层随 cap 变化
 *
 * 用法（注意：Windows 上 npm 走 cmd.exe，不支持 `VAR=x node ...` 前缀，需手工执行）：
 *   RAG_RERANKER_MODE=heuristic node server/scripts/evaluate-knowledge-base.js
 *
 * 环境变量：
 *   RAG_EVALUATION_LIMIT         评测用例条数，默认 100
 *   RAG_EVALUATION_TOP_K         最终层交付证据条数，默认 10
 *   RAG_EVALUATION_SWEEP_LIMITS  解耦矩阵的 limit 取值，默认 10,500
 *   RAG_EVALUATION_SWEEP_CAPS    解耦矩阵的 cap 取值，默认 2,4,10,20
 */
import { writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  initialize, listEvaluationCases, searchEvidence, getKnowledgeBaseStatus, close,
  DEFAULT_EVIDENCE_LIMIT, EVIDENCE_CANDIDATE_LIMIT, EVIDENCE_PER_DOCUMENT_CAP,
  resolveSubType, getSubTypeFilterStats, resetSubTypeFilterStats
} from '../services/knowledge-base.js'
import { buildReviewPlan } from '../services/review-plan.js'
import { getRerankerFallbackStats } from '../services/evidence-reranker.js'
import { getVectorFallbackStats } from '../services/vector-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputPath = join(__dirname, '..', 'knowledge-base', 'evaluation-report.json')

const limit = Number(process.env.RAG_EVALUATION_LIMIT || 100)
// 默认与生产取同一个常量（口径一致：评测量生产跑的东西）；RAG_EVALUATION_TOP_K 仍可覆盖，供 sweep 与反事实实验用
const topK = Number(process.env.RAG_EVALUATION_TOP_K || DEFAULT_EVIDENCE_LIMIT)
// 生产组合必须出现在 sweep 里：候选层解耦自检以它为基准（见下方 decoupling）。
// 因此把 topK 并进 sweep 的 limit 列表，避免以后调整默认值时基准取空。
const sweepLimits = [...new Set([topK, ...parseList(process.env.RAG_EVALUATION_SWEEP_LIMITS, [10, 500])])].sort((a, b) => a - b)
const sweepCaps = parseList(process.env.RAG_EVALUATION_SWEEP_CAPS, [EVIDENCE_PER_DOCUMENT_CAP, 4, 10, 20])
/**
 * 子类型过滤开关（默认关，保持与改前口径一致）。
 * 打开后，评测把「用例自己那份文档的子类型」当作查询子类型传入，用来回答
 * 「假设类型识别是准的，按子类型硬过滤到底值不值」。它验证的是**过滤收益**，
 * 不是识别准确率（识别准确率要靠 Agent 1 的真实输出，另行构造用例）。
 */
const subTypeFilterRequested = process.env.RAG_SUBTYPE_FILTER === '1'
/**
 * 类型提示开关（默认给）。评测默认在 analysisReport 里写一行「合同类型：X」，
 * 等价于「线上 Agent 1 已经把类型判对」；关掉它（RAG_EVALUATION_NO_TYPE_HINT=1）就走
 * `review-plan` 的正则兜底 —— 用来量化**类型没判出来或判错时，有多少关键类别被挡在门外**。
 */
const noTypeHint = process.env.RAG_EVALUATION_NO_TYPE_HINT === '1'
/**
 * 子类型来源开关（默认关）。默认口径下评测自己把「用例文档的子类型」传给检索，测的是
 * **过滤本身能带来多少对口**（上界）。打开后改为**完全走生产路径**：
 * 把子类型写进 analysisReport（模拟 Agent 1 判对了）→ `review-plan` 解析 + **特征词复核**
 * → 用 `plan.subType` 去检索。只有这条路径才验证得到特征词门槛。
 */
const subTypeViaPlan = process.env.RAG_EVALUATION_SUBTYPE_VIA_PLAN === '1'

const round4 = (value) => Number(Number(value || 0).toFixed(4))
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0)
const shortDigest = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 8)

function parseList(raw, fallback) {
  if (!raw) return fallback
  const values = String(raw).split(',').map((item) => Number(item.trim())).filter((item) => Number.isFinite(item) && item > 0)
  return values.length ? [...new Set(values)] : fallback
}

function percentile(values, ratio) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))]
}

/** 一次检索：走完整生产路径，同时用只读钩子取回「交付截断之前」的候选池。 */
async function runSearch(plan, item, { searchLimit, perDocumentCap, subType = '' }) {
  let candidates = []
  const startedAt = Date.now()
  const evidence = await searchEvidence(plan, {
    limit: searchLimit,
    excludeTemplateId: item.template_id,
    perDocumentCap,
    subType,
    onCandidates: (pool) => { candidates = pool }
  })
  return { evidence, candidates, ms: Date.now() - startedAt }
}

/**
 * 请求中的子类型。三个条件同时成立才带上：开关打开、用例文档的类型与**本次判定出的类型一致**、
 * 该文档在映射表里有子类型。
 *
 * 第二个条件是关键：生产中 Agent 1 是在**同一次输出**里给出主类型与子类型的，二者天然配套；
 * 评测若从映射表独立取子类型，就会出现"主类型判成 A、子类型却来自 B"的人造不一致，
 * 被检索侧记成 unknown-sub-type 而降级 —— 那属于另一个问题（类型判错的级联影响），
 * 已由 RAG_EVALUATION_NO_TYPE_HINT 单独量化，不该混进子类型过滤的效果里。
 */
function caseSubType(item, resolvedContractType) {
  if (!subTypeFilterRequested) return ''
  if (item.contract_type !== resolvedContractType) return ''
  return resolveSubType(item.source_file)
}

/** 单层指标：类别召回、类别精度、条数 / 字符数 / 来源文档数、对口程度、证据序列指纹。 */
function layerMetrics(evidence, expectedCategories, { contractType = '', requestedSubType = '' } = {}) {
  const categories = [...new Set(evidence.map((item) => item.category).filter(Boolean))]
  const categorized = evidence.filter((item) => item.category)
  const hits = categorized.filter((item) => expectedCategories.includes(item.category))
  const matched = expectedCategories.filter((category) => categories.includes(category))
  // 对口程度：类别召回只看"类别对不对"，看不出证据是不是来自同一类合同。
  // 这两项专门度量「交出去的东西对不对口」——类型被判错、或子类型过滤没生效时，它们会亮。
  const typeMismatch = evidence.filter((item) => item.contractType !== contractType)
  const alienSubType = requestedSubType ? evidence.filter((item) => item.subType !== requestedSubType) : []
  return {
    categories,
    matchedCategories: matched,
    categoryRecall: expectedCategories.length ? matched.length / expectedCategories.length : 1,
    categoryPrecision: categorized.length ? hits.length / categorized.length : 0,
    count: evidence.length,
    categoryCount: categorized.length,
    documentCount: new Set(evidence.map((item) => item.templateId)).size,
    chars: evidence.reduce((sum, item) => sum + (item.text || '').length, 0),
    // 类型错配率：来源文档的合同类型与本次判定类型不一致的比例。
    // 判定为「通用商业合同」（未判定）时检索本就跨类型 ⇒ 这里必然偏高，这是有意的信号。
    typeMismatchCount: typeMismatch.length,
    typeMismatchRate: evidence.length ? typeMismatch.length / evidence.length : 0,
    // 子类型错配率：只在本次请求了子类型时有意义，量「按子类型过滤有没有把别的形态挡在外面」。
    // 若该类型未开开关或素材不足（见报告 subTypeFilter.downgradeReasons），它会偏高——解读时要对上。
    alienSubTypeCount: alienSubType.length,
    alienSubTypeRate: requestedSubType ? (evidence.length ? alienSubType.length / evidence.length : 0) : null,
    evidenceIdDigest: shortDigest(evidence.map((item) => item.evidenceId).join(','))
  }
}

function aggregateLayer(rows) {
  const withSubType = rows.filter((row) => row.alienSubTypeRate !== null)
  return {
    meanCategoryRecall: round4(mean(rows.map((row) => row.categoryRecall))),
    meanCategoryPrecision: round4(mean(rows.map((row) => row.categoryPrecision))),
    meanEvidenceCount: round4(mean(rows.map((row) => row.count))),
    meanEvidenceChars: Math.round(mean(rows.map((row) => row.chars))),
    meanDocumentCount: round4(mean(rows.map((row) => row.documentCount))),
    emptyRate: round4(mean(rows.map((row) => (row.count === 0 ? 1 : 0)))),
    zeroRecallRate: round4(mean(rows.map((row) => (row.categoryRecall === 0 ? 1 : 0)))),
    meanTypeMismatchRate: round4(mean(rows.map((row) => row.typeMismatchRate))),
    // 只在真的请求过子类型的用例上平均，避免把"没请求"混进来当 0
    meanAlienSubTypeRate: withSubType.length ? round4(mean(withSubType.map((row) => row.alienSubTypeRate))) : null
  }
}

async function main() {
  initialize()
  // 统计口径：覆盖本次运行的全部检索（生产口径 + sweep），用来确认「子类型过滤有没有真的生效」
  resetSubTypeFilterStats()
  const cases = listEvaluationCases({ limit })
  if (!cases.length) throw new Error('没有评测样本，请先执行 npm run import:templates')

  const kbStatus = getKnowledgeBaseStatus()
  const caseReports = []
  const sweepRows = []
  const poolDigests = new Map()
  const poolRecalls = new Map()
  const referenceKey = `${topK}/${EVIDENCE_PER_DOCUMENT_CAP}`

  for (const item of cases) {
    const expectedCategories = JSON.parse(item.expected_categories || '[]')
    const caseSubTypeLine = subTypeViaPlan ? resolveSubType(item.source_file) : ''
    const plan = buildReviewPlan({
      analysisReport: noTypeHint
        // 不给类型提示：模拟"Agent 1 没判出类型"，此时只能靠 review-plan 的正则兜底
        ? '# 合同基础识别\n（本报告未给出合同类型判定）'
        : (caseSubTypeLine
            // 走生产路径：类型与子类型都由"报告"给出 ⇒ 子类型要过 review-plan 的特征词复核
            ? `# 合同基础识别\n- 合同类型：${item.contract_type}\n- 合同子类型：${caseSubTypeLine}`
            : `# 合同基础识别\n- 合同类型：${item.contract_type}`),
      contractText: item.input_excerpt,
      userInstruction: '请识别合同中需要修改的风险条款。'
    })

    // 生产口径：与线上一致的 limit 与默认 cap。生产里调用方传的就是 reviewPlan.subType
    const requestedSubType = subTypeViaPlan ? (plan.subType || '') : caseSubType(item, plan.contractType)
    const production = await runSearch(plan, item, {
      searchLimit: topK, perDocumentCap: EVIDENCE_PER_DOCUMENT_CAP, subType: requestedSubType
    })
    const requestInfo = { contractType: plan.contractType, requestedSubType }
    const finalLayer = layerMetrics(production.evidence, expectedCategories, requestInfo)
    const candidateLayer = layerMetrics(production.candidates, expectedCategories, requestInfo)

    caseReports.push({
      // 以下旧字段名与口径保持不变，便于与改前报告逐字段对比
      caseId: item.id,
      source: item.source_file,
      contractType: item.contract_type,
      expectedCategories,
      retrievedCategories: finalLayer.categories,
      matchedCategories: finalLayer.matchedCategories,
      categoryRecall: round4(finalLayer.categoryRecall),
      positiveEvidencePresent: production.evidence.some((result) => result.referenceRole === 'excellent_template'),
      negativeEvidencePresent: production.evidence.some((result) => result.referenceRole === 'annotated_case' && result.kind === 'risk_rule'),
      evidence: production.evidence.map((result) => ({
        id: result.evidenceId, source: result.sourceName, role: result.referenceRole,
        kind: result.kind, category: result.category, title: result.title, subType: result.subType || ''
      })),
      // 以下为改后新增
      deliveredChars: finalLayer.chars,
      deliveredDocumentCount: finalLayer.documentCount,
      categoryPrecision: round4(finalLayer.categoryPrecision),
      // 对口程度：类型错配率 + 子类型错配率（后者仅在请求过子类型时非 null）
      requestedType: plan.contractType,
      requestedSubType: requestInfo.requestedSubType,
      typeMismatchCount: finalLayer.typeMismatchCount,
      typeMismatchRate: round4(finalLayer.typeMismatchRate),
      alienSubTypeCount: finalLayer.alienSubTypeCount,
      alienSubTypeRate: finalLayer.alienSubTypeRate === null ? null : round4(finalLayer.alienSubTypeRate),
      candidate: {
        count: candidateLayer.count,
        categoryCount: candidateLayer.categoryCount,
        documentCount: candidateLayer.documentCount,
        chars: candidateLayer.chars,
        categories: candidateLayer.categories,
        matchedCategories: candidateLayer.matchedCategories,
        categoryRecall: round4(candidateLayer.categoryRecall),
        categoryPrecision: round4(candidateLayer.categoryPrecision),
        typeMismatchRate: round4(candidateLayer.typeMismatchRate),
        alienSubTypeRate: candidateLayer.alienSubTypeRate === null ? null : round4(candidateLayer.alienSubTypeRate),
        evidenceIdDigest: candidateLayer.evidenceIdDigest
      },
      retrievalMs: production.ms
    })

    // 解耦矩阵：同池下扫 (limit × cap)；生产组合直接复用上面那次结果，避免重复检索
    for (const sweepLimit of sweepLimits) {
      for (const sweepCap of sweepCaps) {
        const key = `${sweepLimit}/${sweepCap}`
        const isProductionCombo = key === referenceKey
        const run = isProductionCombo ? production : await runSearch(plan, item, { searchLimit: sweepLimit, perDocumentCap: sweepCap, subType: requestedSubType })
        const layer = isProductionCombo ? finalLayer : layerMetrics(run.evidence, expectedCategories)
        sweepRows.push({ key, categoryRecall: round4(layer.categoryRecall), categoryPrecision: round4(layer.categoryPrecision), count: layer.count, chars: layer.chars })
        // 候选层解耦自检：池只可能在检索层变动时改变，与 limit / cap 无关
        const pool = isProductionCombo ? candidateLayer : layerMetrics(run.candidates, expectedCategories)
        if (!poolDigests.has(key)) poolDigests.set(key, [])
        if (!poolRecalls.has(key)) poolRecalls.set(key, [])
        poolDigests.get(key).push(pool.evidenceIdDigest)
        poolRecalls.get(key).push(round4(pool.categoryRecall))
      }
    }
  }

  const finalRows = caseReports.map((row) => ({
    categoryRecall: row.categoryRecall,
    categoryPrecision: row.categoryPrecision,
    count: row.evidence.length,
    chars: row.deliveredChars,
    documentCount: row.deliveredDocumentCount,
    // 对口程度两项必须一起带上，否则聚合会静默取到 undefined 并算成 0
    typeMismatchRate: row.typeMismatchRate,
    alienSubTypeRate: row.alienSubTypeRate
  }))
  const candidateRows = caseReports.map((row) => row.candidate)

  const sweepSummary = [...new Set(sweepRows.map((row) => row.key))].map((key) => {
    const rows = sweepRows.filter((row) => row.key === key)
    const [sweepLimit, sweepCap] = key.split('/').map(Number)
    return {
      limit: sweepLimit,
      cap: sweepCap,
      meanCategoryRecall: round4(mean(rows.map((row) => row.categoryRecall))),
      meanCategoryPrecision: round4(mean(rows.map((row) => row.categoryPrecision))),
      meanEvidenceCount: round4(mean(rows.map((row) => row.count))),
      meanEvidenceChars: Math.round(mean(rows.map((row) => row.chars))),
      zeroRecallRate: round4(mean(rows.map((row) => (row.categoryRecall === 0 ? 1 : 0))))
    }
  }).sort((a, b) => (a.limit - b.limit) || (a.cap - b.cap))

  // 候选层解耦自检：以「生产组合」为基准；该组合由上面的 sweepLimits 保证一定被扫到。
  // 若基准缺失（例如有人把 topK 从 sweep 里排掉），退化为「所有其他组合都算不一致」，不会静默放过。
  const referenceDigests = poolDigests.get(referenceKey) || []
  const otherCombos = [...poolDigests.keys()].filter((key) => key !== referenceKey)
  const decouplingMismatch = referenceDigests.length === 0
    ? otherCombos
    : otherCombos.filter((key) => poolDigests.get(key).join('|') !== referenceDigests.join('|'))

  const contractTypes = [...new Set(caseReports.map((row) => row.contractType))]
  const byContractType = contractTypes.map((contractType) => {
    const rows = caseReports.filter((row) => row.contractType === contractType)
    const withSubType = rows.filter((row) => row.alienSubTypeRate !== null)
    return {
      contractType,
      cases: rows.length,
      meanCategoryRecall: round4(mean(rows.map((row) => row.categoryRecall))),
      candidateMeanCategoryRecall: round4(mean(rows.map((row) => row.candidate.categoryRecall))),
      meanCategoryPrecision: round4(mean(rows.map((row) => row.categoryPrecision))),
      meanEvidenceCount: round4(mean(rows.map((row) => row.evidence.length))),
      // 对口程度按类型拆开看 —— 总均值会被「有意未启用子类型过滤」的类型带偏，
      // 只有拆开才能分辨「本来就不过滤」与「过滤了却没生效」
      meanTypeMismatchRate: round4(mean(rows.map((row) => row.typeMismatchRate))),
      meanAlienSubTypeRate: withSubType.length ? round4(mean(withSubType.map((row) => row.alienSubTypeRate))) : null
    }
  }).sort((a, b) => a.meanCategoryRecall - b.meanCategoryRecall)

  const timings = caseReports.map((row) => row.retrievalMs)
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      limit,
      // topK = 本报告实际生效的证据条数；productionEvidenceLimit = 生产链路的生效值。
      // 两者应当相等（第 1 步「对齐生产与评测参数」的出口判据）。
      topK,
      productionEvidenceLimit: DEFAULT_EVIDENCE_LIMIT,
      candidateLimit: EVIDENCE_CANDIDATE_LIMIT,
      perDocumentCap: EVIDENCE_PER_DOCUMENT_CAP,
      sweep: { limits: sweepLimits, caps: sweepCaps },
      // 子类型过滤：requested=false 表示本次跑的是「只按 contract_type 过滤」的口径。
      // applied/downgraded 与降级原因用于确认「过滤到底有没有真的生效」——静默不过滤是串味的来源。
      subTypeFilter: {
        requested: subTypeFilterRequested,
        ...getSubTypeFilterStats()
      },
      // false = 本次跑的是「不给类型提示、走正则兜底」的口径
      contractTypeHint: !noTypeHint,
      // true = 子类型完全走生产路径（经 review-plan 的特征词复核），false = 评测自行注入
      subTypeViaPlan,
      reranker: kbStatus.reranker,
      vector: kbStatus.vector
    },
    knowledgeBase: kbStatus,
    // 旧三个字段名与口径保持不变：0.3352 / 1 / 0.878。单看它不作验收依据。
    summary: {
      cases: caseReports.length,
      meanCategoryRecall: round4(mean(caseReports.map((row) => row.categoryRecall))),
      positiveEvidenceCoverage: round4(mean(caseReports.map((row) => (row.positiveEvidencePresent ? 1 : 0)))),
      negativeEvidenceCoverage: round4(mean(caseReports.map((row) => (row.negativeEvidencePresent ? 1 : 0))))
    },
    layers: {
      candidate: aggregateLayer(candidateRows),
      final: aggregateLayer(finalRows)
    },
    timing: {
      meanMs: Math.round(mean(timings)),
      p95Ms: percentile(timings, 0.95),
      maxMs: Math.max(...timings),
      totalMs: timings.reduce((sum, value) => sum + value, 0)
    },
    sensitivity: sweepSummary,
    decoupling: {
      referenceCombo: { limit: topK, cap: EVIDENCE_PER_DOCUMENT_CAP },
      checkedCombos: [...poolDigests.keys()].sort(),
      candidateLayerStable: decouplingMismatch.length === 0,
      mismatchedCombos: decouplingMismatch,
      candidateMeanCategoryRecallByCombo: Object.fromEntries(
        [...poolRecalls.entries()].map(([key, values]) => [key, round4(mean(values))])
      )
    },
    byContractType,
    cases: caseReports
  }

  const canonical = JSON.stringify({
    config: report.config,
    knowledgeBase: report.knowledgeBase,
    summary: report.summary,
    layers: report.layers,
    sensitivity: report.sensitivity,
    decoupling: report.decoupling,
    byContractType: report.byContractType,
    cases: caseReports.map(({ retrievalMs, ...rest }) => rest)
  })
  report.reproducibility = {
    digest: shortDigest(canonical),
    scope: 'config + knowledgeBase + summary + layers + sensitivity + decoupling + byContractType + cases（不含检索耗时）',
    excludes: ['generatedAt', 'timing', 'cases[].retrievalMs']
  }

  // 评测期禁止静默降级：重排/向量悄悄退回，指标会无声地变成另一种口径，
  // 与基线/历史报告失去可比性。判定规则（按"现象 ≠ 行动"区分预期与意外）：
  //  - 口径本来就是纯词法（mode=lexical-fallback / 显式 heuristic）→ 未配置的计数是常态，放行
  //  - 口径声明"应可用"（hybrid-ready / reranker.enabled）却发生降级 → **失败**
  const rerankerFallback = getRerankerFallbackStats()
  const vectorFallback = getVectorFallbackStats()
  const rerankerEnabled = report.config.reranker?.enabled === true
  const vectorEnabled = report.config.vector?.mode === 'hybrid-ready'
  const degradations = []
  if (rerankerEnabled && rerankerFallback.count > 0) degradations.push(`rerank: ${JSON.stringify(rerankerFallback)}`)
  if (vectorEnabled && vectorFallback.count > 0) degradations.push(`vector: ${JSON.stringify(vectorFallback)}`)
  if (degradations.length) {
    // 降级时报告必须如实标注运行口径——config.vector.mode 来自配置态（hybrid-ready），
    // 但实际已经纯词法，不标注的话这份报告会被当成向量口径去和基线比
    report.config.runtimeDegraded = true
    if (process.env.RAG_EVALUATION_ALLOW_DEGRADED !== '1') {
      console.error('[evaluate-knowledge-base] ❌ 评测期发生静默降级（口径声明可用，实际退回了）：')
      for (const item of degradations) console.error('   · ' + item)
      console.error('[evaluate-knowledge-base] 先修复配置或网络再评测；确要出报告可加 RAG_EVALUATION_ALLOW_DEGRADED=1（报告会带 runtimeDegraded 标记）')
      close()
      process.exit(1)
    }
    console.warn('[evaluate-knowledge-base] ⚠️ 已知降级（ALLOW_DEGRADED=1），报告带 runtimeDegraded 标记：' + degradations.join('；'))
  }
  if (!vectorEnabled) console.log('[evaluate-knowledge-base] 本次为纯词法口径（向量未配置），降级计数按预期不作为失败依据')
  if (!rerankerEnabled) console.log('[evaluate-knowledge-base] 本次重排为显式启发式（不计入降级）')

  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report.summary, null, 2))
  console.log(`[config] 评测 topK=${report.config.topK} 生产 limit=${report.config.productionEvidenceLimit} 口径一致=${report.config.topK === report.config.productionEvidenceLimit}`)
  console.log(`[layers] 候选层 recall=${report.layers.candidate.meanCategoryRecall} precision=${report.layers.candidate.meanCategoryPrecision} 条数=${report.layers.candidate.meanEvidenceCount} 文档=${report.layers.candidate.meanDocumentCount}`)
  console.log(`[layers] 最终层 recall=${report.layers.final.meanCategoryRecall} precision=${report.layers.final.meanCategoryPrecision} 条数=${report.layers.final.meanEvidenceCount} 文档=${report.layers.final.meanDocumentCount}`)
  // 对口程度：类别召回看不出"证据是不是来自同一类合同"，这两项专看这件事
  console.log(`[alignment] 最终层 类型错配率=${report.layers.final.meanTypeMismatchRate} 子类型错配率=${report.layers.final.meanAlienSubTypeRate ?? 'n/a'}（仅统计请求过子类型的用例）`)
  console.log(`[decoupling] 候选层跨 (limit × cap) 组合稳定=${report.decoupling.candidateLayerStable} 不一致=${report.decoupling.mismatchedCombos.join(',') || '无'}`)
  console.log(`[sensitivity] ${report.sensitivity.map((row) => `${row.limit}/${row.cap}=${row.meanCategoryRecall}`).join('  ')}`)
  console.log(`[reproducibility] digest=${report.reproducibility.digest}  timing mean=${report.timing.meanMs}ms p95=${report.timing.p95Ms}ms`)
  console.log(`[evaluate-knowledge-base] Report written: ${outputPath}`)
  close()
}

main().catch((error) => {
  console.error('[evaluate-knowledge-base] Failed:', error.message || error)
  close()
  process.exit(1)
})
