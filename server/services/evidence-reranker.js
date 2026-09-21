import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { classifyError } from './siliconflow-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env.local') })

const RERANKER_MODE = (process.env.RAG_RERANKER_MODE || 'siliconflow').toLowerCase()
const SILICONFLOW_RERANK_URL = (process.env.RAG_RERANKER_URL || 'https://api.siliconflow.cn/v1/rerank').replace(/\/$/, '')
const SILICONFLOW_API_KEY = process.env.RAG_RERANKER_API_KEY || process.env.SILICONFLOW_API_KEY || ''
const SILICONFLOW_RERANK_MODEL = process.env.RAG_RERANKER_MODEL || 'BAAI/bge-reranker-v2-m3'
/** 重排请求超时：此前无超时，上游变慢会一直阻塞（实测可拖到分钟级） */
const RERANK_TIMEOUT_MS = Number(process.env.RAG_RERANKER_TIMEOUT_MS || 8000)

/**
 * 运行时健康计数。
 *
 * 合同知识库侧的重排降级此前只有一行 console.warn：接口层无从得知，用户端也看不到任何提示，
 * 与用工侧（siliconflow-client.js 的 health 计数 + 降级写入用户可见 warnings）是两套标准。
 * 项目已因"静默降级"吃过两次亏（以为在跑混合检索、实际是坏掉的单路词法），这里补齐同样的可见性。
 */
const health = { calls: 0, ok: 0, degraded: 0, lastReason: '' }

export function getRerankerHealth() {
  const configured = isSiliconFlowConfigured()
  return {
    mode: RERANKER_MODE,
    configured,
    model: SILICONFLOW_RERANK_MODEL,
    // 只有真正成功调用过才认为 "available"，避免"配置了但一直失败"被判为可用
    available: configured && health.ok > 0,
    ...health
  }
}

/**
 * 先用确定性重排保证离线可用；默认使用 SiliconFlow rerank API 对融合候选
 * 做第二阶段相关性判断。无论哪种模式，都只重排已召回的候选，不允许模型
 * 创造新的证据或更改来源信息。
 *
 * @returns {Promise<Array & { retrieval: { used: boolean, degraded: boolean, reason: string } }>}
 *   降级信息挂在返回数组的 `retrieval` 字段上（与 labor-kb.js 的约定一致），
 *   调用方据此把降级写进用户可见的 warnings，不再静默回落。
 */
export async function rerankEvidence({ reviewPlan, candidates }) {
  const heuristic = heuristicRerank(reviewPlan, candidates)
  const retrieval = { used: false, degraded: false, reason: '' }
  const finish = (items, { used = false, degraded = false, reason = '' } = {}) => {
    retrieval.used = used
    retrieval.degraded = degraded
    retrieval.reason = reason
    items.retrieval = retrieval
    return items
  }

  // 候选不足或显式关闭外部重排：这是预期行为，不算降级。
  if (RERANKER_MODE === 'heuristic' || heuristic.length < 2) return finish(heuristic)
  if (RERANKER_MODE !== 'siliconflow') {
    console.warn(`[evidence-reranker] Unsupported reranker mode: ${RERANKER_MODE}; using heuristic fallback`)
    return finish(heuristic, { degraded: true, reason: 'mode_unsupported' })
  }
  if (!isSiliconFlowConfigured()) {
    health.degraded += 1
    health.lastReason = '未配置 SiliconFlow Rerank'
    console.warn('[evidence-reranker] rerank 降级（not_configured）：回落启发式排序')
    return finish(heuristic, { degraded: true, reason: 'not_configured' })
  }

  health.calls += 1
  try {
    const scores = await siliconFlowRerank(reviewPlan, heuristic.slice(0, 36))
    health.ok += 1
    return finish(
      heuristic
        .map((item) => ({ ...item, rerankScore: scores.get(item.evidenceId) ?? item.rerankScore }))
        .sort((a, b) => b.rerankScore - a.rerankScore),
      { used: true }
    )
  } catch (error) {
    const reason = error.reason || classifyError(0, error.message)
    health.degraded += 1
    health.lastReason = error.message
    console.warn(`[evidence-reranker] SiliconFlow rerank fallback (${reason}): ${error.message}`)
    return finish(heuristic, { degraded: true, reason })
  }
}

export function getRerankerStatus() {
  return {
    mode: RERANKER_MODE,
    enabled: RERANKER_MODE === 'siliconflow' && isSiliconFlowConfigured(),
    provider: RERANKER_MODE === 'siliconflow' ? 'SiliconFlow' : null,
    model: RERANKER_MODE === 'siliconflow' ? SILICONFLOW_RERANK_MODEL : null,
    health: getRerankerHealth()
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS)
  const response = await fetch(SILICONFLOW_RERANK_URL, {
    signal: controller.signal,
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
  clearTimeout(timer)
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
