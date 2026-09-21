/**
 * 硅基流动（SiliconFlow）客户端：Embedding + Rerank。
 *
 * 设计重点是**降级可见**。项目此前的教训（见 docs/知识库优化方案.md 问题 5、6）：
 * 向量检索 `fetch failed` 与重排器 429 都只打一行 console.warn 就静默回落，
 * 导致"以为在跑混合检索，实际是坏掉的单路词法"持续了数月无人察觉。
 *
 * 本模块因此强制三件事：
 *   1. 每次降级都计入 `health` 计数器，可通过 getRetrievalHealth() 查询；
 *   2. 每次降级都打结构化 warn，带原因分类（rate_limit / network / auth / server）；
 *   3. 检索结果附带 `degraded` 标记，调用方（含前端）能知道本轮是否用了完整能力。
 */
import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env.local') })

const EMBEDDING_URL = (process.env.RAG_EMBEDDING_URL || 'https://api.siliconflow.cn/v1/embeddings').replace(/\/$/, '')
const EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL || 'BAAI/bge-m3'
const EMBEDDING_KEY = process.env.RAG_EMBEDDING_API_KEY || process.env.SILICONFLOW_API_KEY || ''

const RERANK_URL = (process.env.RAG_RERANKER_URL || 'https://api.siliconflow.cn/v1/rerank').replace(/\/$/, '')
const RERANK_MODEL = process.env.RAG_RERANKER_MODEL || 'BAAI/bge-reranker-v2-m3'
const RERANK_KEY = process.env.RAG_RERANKER_API_KEY || process.env.SILICONFLOW_API_KEY || ''

/** 并发上限：硅基流动对免费/低档账户有 RPM/TPM 限制，串行+小批更稳 */
const MAX_RETRIES = Number(process.env.SILICONFLOW_MAX_RETRIES || 4)
const REQUEST_TIMEOUT_MS = Number(process.env.SILICONFLOW_TIMEOUT_MS || 30000)
/**
 * 一次逻辑请求（含全部重试）的总预算。
 *
 * 为什么需要它：`REQUEST_TIMEOUT_MS` 是**单次尝试**的超时，而 AbortController 建在重试循环体内，
 * 每次重试都会拿到一个全新的 30s 窗口。于是"加了超时"只是把无限等变成有限等——
 * 上界仍是 MAX_RETRIES × 30s + 退避 ≈ 134s，与修复前的 120s 阻塞属同一量级。
 * 这里给出硬上界：无论重试多少次，一次逻辑请求都不得超过该预算。
 */
const REQUEST_TOTAL_TIMEOUT_MS = Number(process.env.SILICONFLOW_TOTAL_TIMEOUT_MS || REQUEST_TIMEOUT_MS)
/** 剩余预算低于此值就不再发起新尝试（发起也只会立刻超时，纯粹浪费一次往返） */
const MIN_ATTEMPT_MS = Number(process.env.SILICONFLOW_MIN_ATTEMPT_MS || 500)

/** 运行时健康计数：用于替代"静默降级" */
const health = {
  embedding: { calls: 0, ok: 0, failed: 0, degraded: 0, lastError: '' },
  rerank: { calls: 0, ok: 0, failed: 0, degraded: 0, lastError: '' }
}

export function getRetrievalHealth() {
  const configured = { embedding: Boolean(EMBEDDING_KEY), rerank: Boolean(RERANK_KEY) }
  return {
    configured,
    embedding: { ...health.embedding, model: EMBEDDING_MODEL, available: configured.embedding && health.embedding.ok > 0 },
    rerank: { ...health.rerank, model: RERANK_MODEL, available: configured.rerank && health.rerank.ok > 0 }
  }
}

export const isEmbeddingConfigured = () => Boolean(EMBEDDING_KEY && EMBEDDING_URL)
export const isRerankConfigured = () => Boolean(RERANK_KEY && RERANK_URL)

/** 把失败原因分类，便于告警与重试策略区分。导出供合同侧（evidence-reranker）复用同一套分类。 */
export function classifyError(status, message = '') {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500) return 'server'
  // 本项目自造的超时消息是中文（"rerank 超时（…）"），只匹配英文 timeout 会漏判成 unknown
  if (/timeout|aborted|ECONNRESET|ENOTFOUND|fetch failed|超时/i.test(message)) return 'network'
  return 'unknown'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 带重试与超时的请求，受**总预算**约束。
 *
 * 限流（429）用指数退避；认证错误不重试（重试也不会成功）。
 * 每次尝试的超时取 `min(单次上限, 剩余预算)`，预算耗尽立即放弃——
 * 否则重试会把最坏耗时堆成 MAX_RETRIES × REQUEST_TIMEOUT_MS。
 * 快速失败（上游立刻返回 5xx）的重试行为不受影响，仍在预算内完成。
 */
async function requestWithRetry(url, body, label, counter) {
  const deadline = Date.now() + REQUEST_TOTAL_TIMEOUT_MS
  const budgetLeft = () => deadline - Date.now()
  let lastError = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    if (budgetLeft() <= MIN_ATTEMPT_MS) {
      lastError = lastError || new Error(`${label} 总预算 ${REQUEST_TOTAL_TIMEOUT_MS}ms 已耗尽`)
      console.warn(`[siliconflow] ${label} 放弃第 ${attempt} 次尝试：剩余预算不足 ${MIN_ATTEMPT_MS}ms`)
      break
    }
    const attemptBudget = Math.min(REQUEST_TIMEOUT_MS, budgetLeft())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), attemptBudget)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${counter === health.embedding ? EMBEDDING_KEY : RERANK_KEY}` },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (response.ok) return await response.json()

      const text = await response.text().catch(() => '')
      const kind = classifyError(response.status, text)
      lastError = new Error(`${label} HTTP ${response.status} (${kind}): ${text.slice(0, 160)}`)
      if (kind === 'auth') break                        // 认证失败重试无意义
      if (attempt < MAX_RETRIES) {
        const waitMs = kind === 'rate_limit' ? Math.min(2000 * 2 ** (attempt - 1), 20000) : 800 * attempt
        // 退避后没有足够预算完成下一次尝试，就不再重试（避免为了一次必然超时的请求再等下去）
        if (budgetLeft() <= waitMs + MIN_ATTEMPT_MS) {
          console.warn(`[siliconflow] ${label} 第 ${attempt} 次失败（${kind}），剩余预算不足以重试，放弃`)
          break
        }
        console.warn(`[siliconflow] ${label} 第 ${attempt} 次失败（${kind}），${waitMs}ms 后重试`)
        await sleep(waitMs)
      }
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? Object.assign(new Error(`${label} 超时（单次上限 ${attemptBudget}ms，总预算 ${REQUEST_TOTAL_TIMEOUT_MS}ms）`), { reason: 'network' })
        : error
      if (attempt < MAX_RETRIES) {
        const waitMs = 800 * attempt
        if (budgetLeft() <= waitMs + MIN_ATTEMPT_MS) break
        await sleep(waitMs)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new Error(`${label} 调用失败`)
}

/**
 * 批量文本向量化。
 * @param {string[]} texts
 * @param {{ batchSize?: number, onProgress?: Function }} options
 * @returns {Promise<number[][]>} 与输入等长的向量数组
 */
export async function embedTexts(texts, { batchSize = 16, onProgress } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '').slice(0, 6000))
  if (!list.length) return []
  if (!isEmbeddingConfigured()) throw new Error('未配置 SILICONFLOW_API_KEY，无法调用 Embedding')

  health.embedding.calls += 1
  const vectors = []
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize)
    try {
      const data = await requestWithRetry(EMBEDDING_URL, { model: EMBEDDING_MODEL, input: batch }, 'embedding', health.embedding)
      const batchVectors = (data?.data || [])
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map((item) => item.embedding)
      if (batchVectors.length !== batch.length || batchVectors.some((v) => !Array.isArray(v))) {
        throw new Error(`Embedding 返回格式异常：期望 ${batch.length} 条，实际 ${batchVectors.length} 条`)
      }
      vectors.push(...batchVectors)
      health.embedding.ok += 1
      onProgress?.({ done: Math.min(i + batchSize, list.length), total: list.length })
    } catch (error) {
      health.embedding.failed += 1
      health.embedding.degraded += 1
      health.embedding.lastError = error.message
      console.warn(`[siliconflow] embedding 降级：${error.message}`)
      throw error
    }
    if (i + batchSize < list.length) await sleep(120)   // 轻微限速，避免触发 TPM
  }
  return vectors
}

/** 单条查询向量化（检索热路径） */
export async function embedQuery(text) {
  const [vector] = await embedTexts([text], { batchSize: 1 })
  return vector
}

/**
 * 模型重排。
 * @param {string} query
 * @param {Array<{id:any, text:string}>} documents
 * @param {{ topN?: number }} options
 * @returns {Promise<{ scores: Map<any, number>, degraded: boolean, reason?: string }>}
 */
export async function rerank(query, documents, { topN } = {}) {
  const docs = Array.isArray(documents) ? documents : []
  if (!docs.length) return { scores: new Map(), degraded: false }
  if (!isRerankConfigured()) {
    health.rerank.degraded += 1
    health.rerank.lastError = '未配置 SILICONFLOW_API_KEY，无法调用 Rerank'
    console.warn('[siliconflow] rerank 降级：未配置 API Key')
    return { scores: new Map(), degraded: true, reason: 'not_configured' }
  }

  health.rerank.calls += 1
  try {
    const data = await requestWithRetry(RERANK_URL, {
      model: RERANK_MODEL,
      query: String(query || '').slice(0, 2000),
      documents: docs.map((doc) => String(doc.text || '').slice(0, 4000)),
      top_n: topN || docs.length,
      return_documents: false
    }, 'rerank', health.rerank)

    const scores = new Map()
    for (const item of data?.results || []) {
      const doc = docs[Number(item.index)]
      const score = Number(item.relevance_score)
      if (doc && Number.isFinite(score)) scores.set(doc.id, score)
    }
    if (!scores.size) throw new Error('Rerank 未返回有效评分')
    health.rerank.ok += 1
    return { scores, degraded: false }
  } catch (error) {
    // 优先采用错误自带的 reason（如 requestWithRetry 标记的超时/预算耗尽），
    // 否则"超时"这类最常见的失败模式会被判成 unknown，降级就不可诊断了。
    const reason = error.reason || classifyError(0, error.message)
    health.rerank.failed += 1
    health.rerank.degraded += 1
    health.rerank.lastError = error.message
    console.warn(`[siliconflow] rerank 降级（${reason}）：${error.message}`)
    return { scores: new Map(), degraded: true, reason }
  }
}
