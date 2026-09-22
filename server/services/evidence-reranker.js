import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env.local') })

const RERANKER_MODE = (process.env.RAG_RERANKER_MODE || 'siliconflow').toLowerCase()
const SILICONFLOW_RERANK_URL = (process.env.RAG_RERANKER_URL || 'https://api.siliconflow.cn/v1/rerank').replace(/\/$/, '')
const SILICONFLOW_API_KEY = process.env.RAG_RERANKER_API_KEY || process.env.SILICONFLOW_API_KEY || ''
const SILICONFLOW_RERANK_MODEL = process.env.RAG_RERANKER_MODEL || 'BAAI/bge-reranker-v2-m3'

/**
 * 重排降级是"静默失败"的重灾区：**没配 key、模式不支持、API 报错**，三种都会悄悄退回手写公式。
 * 结局是"你以为生产在跑 bge-reranker，实际跑的是未标定的公式"。
 *
 * 留痕方式：**只在进程内首次降级时打一条结构化 JSON 告警**（每次检索都 warn 会把日志刷爆），
 * 其余全部计数，由 `getRerankerFallbackStats()` 供评测与排障读取。
 * 沿用项目现状：不引新依赖，`console.*` 生产由 PM2 收进日志文件，grep 即可统计。
 */
const rerankerFallbackStats = { count: 0, reasons: {}, lastError: '' }
let rerankerFallbackWarned = false

function noteRerankerFallback(reason) {
  rerankerFallbackStats.count += 1
  rerankerFallbackStats.reasons[reason] = (rerankerFallbackStats.reasons[reason] || 0) + 1
  if (rerankerFallbackWarned) return
  rerankerFallbackWarned = true
  console.warn(JSON.stringify({
    event: 'kb.reranker_fallback',
    reason,
    mode: RERANKER_MODE,
    providerConfigured: isSiliconFlowConfigured(),
    note: '重排未生效，已退回确定性启发式公式；进程内仅首次告警，后续只计数'
  }))
}

export function getRerankerFallbackStats() {
  return { ...rerankerFallbackStats, reasons: { ...rerankerFallbackStats.reasons } }
}

/**
 * 先用确定性重排保证离线可用；默认使用 SiliconFlow rerank API 对融合候选
 * 做第二阶段相关性判断。无论哪种模式，都只重排已召回的候选，不允许模型
 * 创造新的证据或更改来源信息。
 */
export async function rerankEvidence({ reviewPlan, candidates }) {
  const heuristic = heuristicRerank(reviewPlan, candidates)
  if (RERANKER_MODE === 'heuristic' || heuristic.length < 2) return heuristic
  if (RERANKER_MODE !== 'siliconflow') {
    noteRerankerFallback('unsupported-mode')
    console.warn(`[evidence-reranker] Unsupported reranker mode: ${RERANKER_MODE}; using heuristic fallback`)
    return heuristic
  }
  if (!isSiliconFlowConfigured()) {
    // ★ 原本这里直接静默 return —— 默认模式是 siliconflow、但没配 key 时，
    //   生产会一路跑手写公式且毫无痕迹。这是「你以为在跑模型重排」的根因。
    noteRerankerFallback('not-configured')
    return heuristic
  }

  try {
    const scores = await siliconFlowRerank(reviewPlan, heuristic.slice(0, 36))
    return heuristic
      .map((item) => ({ ...item, rerankScore: scores.get(item.evidenceId) ?? item.rerankScore }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
  } catch (error) {
    rerankerFallbackStats.lastError = error.message
    noteRerankerFallback('api-error')
    console.warn(`[evidence-reranker] SiliconFlow rerank fallback: ${error.message}`)
    return heuristic
  }
}

export function getRerankerStatus() {
  return {
    mode: RERANKER_MODE,
    enabled: RERANKER_MODE === 'siliconflow' && isSiliconFlowConfigured(),
    provider: RERANKER_MODE === 'siliconflow' ? 'SiliconFlow' : null,
    model: RERANKER_MODE === 'siliconflow' ? SILICONFLOW_RERANK_MODEL : null
  }
}

function heuristicRerank(reviewPlan, candidates) {
  const terms = new Set((reviewPlan?.topics || []).flatMap((topic) => topic.terms || []))
  const focus = reviewPlan?.userFocus || ''
  return candidates
    .map((candidate) => {
      const haystack = `${candidate.title}\n${candidate.parentTitle}\n${candidate.category}\n${candidate.text}`
      const termMatches = [...terms].filter((term) => term && haystack.includes(term)).length
      const focusMatches = focus ? [...new Set(focus.match(/[\u4e00-\u9fa5]{2,8}/g) || [])].filter((term) => haystack.includes(term)).length : 0
      const roleBonus = candidate.kind === 'risk_rule' && (candidate.referenceRole === 'annotated_case' || candidate.sourceNote?.startsWith('【Word 原生批注】')) ? 0.025 :
        candidate.kind === 'clause' && candidate.referenceRole === 'excellent_template' ? 0.02 : 0
      const rerankScore = candidate.retrievalScore * 100 + termMatches * 0.8 + focusMatches * 0.35 + roleBonus
      return { ...candidate, rerankScore, rankingMethod: 'hybrid-heuristic' }
    })
    .sort((a, b) => b.rerankScore - a.rerankScore)
}

async function siliconFlowRerank(reviewPlan, candidates) {
  const response = await fetch(SILICONFLOW_RERANK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SILICONFLOW_API_KEY}`
    },
    body: JSON.stringify({
      model: SILICONFLOW_RERANK_MODEL,
      query: buildRerankQuery(reviewPlan),
      documents: candidates.map(formatRerankDocument),
      top_n: candidates.length,
      return_documents: false,
      max_chunks_per_doc: 8,
      overlap_tokens: 48
    })
  })
  if (!response.ok) throw new Error(`request failed: ${response.status} ${await response.text()}`)
  const parsed = await response.json()
  const scores = new Map()
  for (const item of parsed?.results || []) {
    const candidate = candidates[Number(item.index)]
    const score = Number(item.relevance_score)
    if (candidate && Number.isFinite(score)) scores.set(candidate.evidenceId, score * 100)
  }
  if (!scores.size) throw new Error('重排序模型未返回有效评分')
  return scores
}

function isSiliconFlowConfigured() {
  return Boolean(SILICONFLOW_RERANK_URL && SILICONFLOW_API_KEY && SILICONFLOW_RERANK_MODEL)
}

function buildRerankQuery(reviewPlan) {
  const topics = (reviewPlan?.topics || []).map((topic) => `${topic.label}：${(topic.terms || []).join('、')}`).join('；')
  return [
    `合同类型：${reviewPlan?.contractType || '通用商业合同'}`,
    `审查重点：${topics || '识别合同风险并给出可落地的修改建议'}`,
    reviewPlan?.userFocus ? `用户关注：${reviewPlan.userFocus}` : ''
  ].filter(Boolean).join('\n')
}

function formatRerankDocument(item) {
  return [
    item.kind === 'risk_rule' && item.sourceNote?.startsWith('【Word 原生批注】') ? '人工批注风险证据' : item.referenceRole === 'annotated_case' ? '风险反例证据' : '正向模板证据',
    item.kind === 'risk_rule' ? '风险规则' : '合同条款',
    item.category ? `风险类别：${item.category}` : '',
    `${item.clauseNo || ''} ${item.title || ''}`.trim(),
    item.text
  ].filter(Boolean).join('\n')
}
