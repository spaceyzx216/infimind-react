import dotenv from 'dotenv'
import { createHash } from 'crypto'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env.local') })

const VECTOR_URL = (process.env.RAG_VECTOR_URL || '').replace(/\/$/, '')
const VECTOR_COLLECTION = process.env.RAG_VECTOR_COLLECTION || 'contract_knowledge_evidence'
const VECTOR_API_KEY = process.env.RAG_VECTOR_API_KEY || ''
const EMBEDDING_URL = (process.env.RAG_EMBEDDING_URL || 'https://api.siliconflow.cn/v1/embeddings').replace(/\/$/, '')
const EMBEDDING_API_KEY = process.env.RAG_EMBEDDING_API_KEY || process.env.SILICONFLOW_API_KEY || ''
const EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL || 'BAAI/bge-m3'
/** 向量/embedding 请求超时（毫秒） */
const VECTOR_TIMEOUT_MS = Number(process.env.RAG_VECTOR_TIMEOUT_MS || 8000)
/** Qdrant 探活超时（毫秒）——探活要快，失败即视为不可用 */
const QDRANT_PROBE_TIMEOUT_MS = Number(process.env.RAG_QDRANT_PROBE_TIMEOUT_MS || 1500)
/** 探活结果缓存时长：Qdrant 上线/下线不会被立刻感知，但避免了每请求探测 */
const PROBE_TTL_MS = Number(process.env.RAG_QDRANT_PROBE_TTL_MS || 30000)

/**
 * 带超时的 fetch。
 *
 * 此前这些请求没有任何超时：当上游变慢或返回 5xx 时，调用会一直阻塞
 * （实测单次阻塞 120 秒，直接把整轮咨询拖到数分钟）。审查链路上有 4 处这样的调用。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = VECTOR_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Qdrant 可用性探活（带缓存）。
 *
 * 为什么必须先探活：searchVectorEvidence 原本"先 embedding 再查 Qdrant"，
 * 而 Qdrant 未部署时会白做一遍 embedding 再失败——既浪费时间又浪费额度。
 * 探活结果缓存 PROBE_TTL_MS，避免每个请求都打一次。
 */
let qdrantProbe = { at: 0, ok: false }

async function isQdrantReachable() {
  if (!VECTOR_URL) return false
  const now = Date.now()
  if (now - qdrantProbe.at < PROBE_TTL_MS) return qdrantProbe.ok
  try {
    const response = await fetchWithTimeout(`${VECTOR_URL}/collections`, { headers: vectorHeaders() }, QDRANT_PROBE_TIMEOUT_MS)
    qdrantProbe = { at: now, ok: response.ok }
  } catch {
    qdrantProbe = { at: now, ok: false }
  }
  return qdrantProbe.ok
}

export function getVectorStatus() {
  const embeddingConfigured = Boolean(EMBEDDING_URL && EMBEDDING_MODEL && EMBEDDING_API_KEY)
  const vectorConfigured = Boolean(VECTOR_URL)
  return {
    enabled: embeddingConfigured && vectorConfigured,
    vectorConfigured,
    embeddingConfigured,
    collection: VECTOR_COLLECTION,
    mode: embeddingConfigured && vectorConfigured ? 'hybrid-ready' : 'lexical-fallback'
  }
}

/** 在导入后同步条款和风险规则到 Qdrant；未配置服务时无副作用地跳过。 */
export async function syncVectorIndex(records, {
  rebuild = process.env.RAG_VECTOR_REBUILD_ON_IMPORT === 'true',
  onProgress
} = {}) {
  if (!getVectorStatus().enabled) {
    console.log('[vector-store] Vector sync skipped: RAG_VECTOR_URL / SiliconFlow Embedding API key not fully configured')
    return { synced: 0, skipped: true }
  }
  const usable = records.filter((record) => record.content?.trim())
  if (!usable.length) return { synced: 0, skipped: false }
  // 灌库是分钟级操作，必须可观测：否则大批量同步看起来像卡死
  const vectors = await embedTexts(usable.map(formatEmbeddingText), {
    onProgress: ({ done, total }) => {
      onProgress?.({ phase: 'embedding', done, total })
      if (done === total || done % 10 === 0) console.log(`[vector-store] embedding 进度 ${done}/${total} 批`)
    }
  })
  const dimension = vectors[0]?.length
  if (!dimension) throw new Error('Embedding provider returned an empty vector')
  if (rebuild) await deleteCollection().catch(() => {})
  await ensureCollection(dimension)

  const points = usable.map((record, index) => ({
    id: stablePointId(record.evidence_id),
    vector: vectors[index],
    payload: {
      evidenceId: record.evidence_id,
      kind: record.kind,
      contractType: record.contract_type,
      referenceRole: record.reference_role,
      pairKey: record.pair_key,
      sourcePath: record.source_path,
      sourceName: record.name,
      heading: `${record.clause_no || ''} ${record.title || ''}`.trim()
    }
  }))
  const pointBatches = chunk(points, 64)
  for (let index = 0; index < pointBatches.length; index += 1) {
    await vectorRequest(`/collections/${VECTOR_COLLECTION}/points?wait=true`, 'PUT', { points: pointBatches[index] })
    onProgress?.({ phase: 'upsert', done: index + 1, total: pointBatches.length })
  }
  console.log(`[vector-store] Synced ${points.length} evidence vectors to ${VECTOR_COLLECTION}`)
  return { synced: points.length, skipped: false }
}

export async function searchVectorEvidence(topics, { limit = 24, contractType = '' } = {}) {
  if (!getVectorStatus().enabled) return []
  // 先探活再 embedding：Qdrant 不可用时直接跳过，不浪费一次 embedding 调用
  if (!await isQdrantReachable()) {
    // 带上原因标记：调用方据此归类降级（否则"不可达"会被 classifyError 判成 unknown）
    throw Object.assign(
      new Error(`Qdrant 不可达（${VECTOR_URL}），已跳过向量检索以避免无效 embedding`),
      { reason: 'qdrant_unreachable' }
    )
  }
  const outputs = []
  const vectors = await embedTexts(topics.map((topic) => `${topic.label}\n${topic.query}`))
  for (let index = 0; index < topics.length; index++) {
    const topic = topics[index]
    const body = {
      query: vectors[index],
      limit,
      with_payload: true,
      ...(contractType ? { filter: { must: [{ key: 'contractType', match: { value: contractType } }] } } : {})
    }
    const data = await vectorRequest(`/collections/${VECTOR_COLLECTION}/points/query`, 'POST', body)
    const points = data?.result?.points || data?.result || []
    for (const point of points) {
      const evidenceId = point?.payload?.evidenceId
      if (evidenceId) outputs.push({ evidenceId, topicId: topic.id, topicLabel: topic.label, score: Number(point.score) || 0 })
    }
  }
  return outputs.sort((a, b) => b.score - a.score)
}

/**
 * 批量 embedding 的超时、批次与重试。
 *
 * 为什么与 VECTOR_TIMEOUT_MS 分开：那个 8s 是按**检索热路径**定的（单条查询向量，很宽裕）。
 * 但 embedTexts 同时服务于**批量灌库**——一批完整的条款全文，8s 根本不够。
 *
 * 为什么必须重试：SiliconFlow 的 embedding 延迟极不稳定，实测同一账号同一模型出现
 * 236ms / 6.9s / 90s / 494ms 的抖动（疑似服务端冷启动与排队）。本模块此前**没有任何重试**，
 * 而 2057 条证据要发数十批请求——只要有一批慢，整个 syncVectorIndex 就前功尽弃。
 */
const EMBEDDING_TIMEOUT_MS = Number(process.env.RAG_EMBEDDING_TIMEOUT_MS || 120000)
const EMBEDDING_BATCH_SIZE = Number(process.env.RAG_EMBEDDING_BATCH_SIZE || 32)
const EMBEDDING_MAX_RETRIES = Number(process.env.RAG_EMBEDDING_MAX_RETRIES || 3)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function embedTexts(texts, { onProgress } = {}) {
  const batches = chunk(texts, EMBEDDING_BATCH_SIZE)
  const output = []
  for (let index = 0; index < batches.length; index += 1) {
    output.push(...await embedBatchWithRetry(batches[index]))
    onProgress?.({ done: index + 1, total: batches.length })
  }
  return output
}

/** 单批 embedding：失败重试，退避拉开间隔（给服务端冷启动留出时间）。 */
async function embedBatchWithRetry(batch) {
  let lastError = null
  for (let attempt = 1; attempt <= EMBEDDING_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(EMBEDDING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMBEDDING_API_KEY}` },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch })
      }, EMBEDDING_TIMEOUT_MS)
      if (!response.ok) throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`)
      const data = await response.json()
      const vectors = (data?.data || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map((item) => item.embedding)
      if (vectors.length !== batch.length || vectors.some((vector) => !Array.isArray(vector))) throw new Error('Embedding response format is invalid')
      return vectors
    } catch (error) {
      lastError = error
      if (attempt < EMBEDDING_MAX_RETRIES) {
        const waitMs = 1500 * attempt
        console.warn(`[vector-store] embedding 第 ${attempt}/${EMBEDDING_MAX_RETRIES} 次失败（${error.name}: ${String(error.message).slice(0, 80)}），${waitMs}ms 后重试`)
        await sleep(waitMs)
      }
    }
  }
  throw lastError
}

async function ensureCollection(size) {
  const existing = await fetchWithTimeout(`${VECTOR_URL}/collections/${VECTOR_COLLECTION}`, { headers: vectorHeaders() })
  if (existing.ok) return
  await vectorRequest(`/collections/${VECTOR_COLLECTION}`, 'PUT', { vectors: { size, distance: 'Cosine' } })
}

async function deleteCollection() {
  const response = await fetchWithTimeout(`${VECTOR_URL}/collections/${VECTOR_COLLECTION}`, { method: 'DELETE', headers: vectorHeaders() })
  if (!response.ok && response.status !== 404) throw new Error(`Unable to reset vector collection: ${response.status}`)
}

async function vectorRequest(path, method, body) {
  const response = await fetchWithTimeout(`${VECTOR_URL}${path}`, { method, headers: vectorHeaders(), body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`Qdrant request failed: ${response.status} ${await response.text()}`)
  return response.json()
}

function vectorHeaders() {
  return { 'Content-Type': 'application/json', ...(VECTOR_API_KEY ? { 'api-key': VECTOR_API_KEY } : {}) }
}

function formatEmbeddingText(record) {
  return [record.contract_type, record.reference_role, record.name, record.clause_no, record.title, record.parent_title, record.content].filter(Boolean).join('\n')
}

function stablePointId(value) {
  const hex = createHash('sha1').update(String(value)).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size))
}
