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

/**
 * 向量不可用是"静默失败"的另一个重灾区：没配地址 / 没配 embedding key 时，
 * 检索会一路静默走词法，表面上一切正常，实际"混合 RAG"只剩一条腿。
 * 留痕方式与 `evidence-reranker` 一致：进程内首次降级打一条结构化 JSON 告警（避免刷屏），
 * 其余只计数，由 `getVectorFallbackStats()` 供评测与排障读取。
 */
const vectorFallbackStats = { count: 0, reasons: {} }
let vectorFallbackWarned = false

export function noteVectorUnavailable(reason) {
  vectorFallbackStats.count += 1
  vectorFallbackStats.reasons[reason] = (vectorFallbackStats.reasons[reason] || 0) + 1
  if (vectorFallbackWarned) return
  vectorFallbackWarned = true
  console.warn(JSON.stringify({
    event: 'kb.vector_unavailable',
    reason,
    mode: getVectorStatus().mode,
    note: '向量检索未生效，已退回纯词法；进程内仅首次告警，后续只计数'
  }))
}

export function getVectorFallbackStats() {
  return { ...vectorFallbackStats, reasons: { ...vectorFallbackStats.reasons } }
}

/** 在导入后同步条款和风险规则到 Qdrant；未配置服务时无副作用地跳过。 */
export async function syncVectorIndex(records, { rebuild = process.env.RAG_VECTOR_REBUILD_ON_IMPORT === 'true' } = {}) {
  if (!getVectorStatus().enabled) {
    noteVectorUnavailable('not-configured')
    console.log('[vector-store] Vector sync skipped: RAG_VECTOR_URL / SiliconFlow Embedding API key not fully configured')
    return { synced: 0, skipped: true }
  }
  const usable = records.filter((record) => record.content?.trim())
  if (!usable.length) return { synced: 0, skipped: false }
  const vectors = await embedTexts(usable.map(formatEmbeddingText))
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
      // 子类型也进 payload —— 否则向量这条路无法按子类型过滤（词法那条路已经做了）
      subType: record.sub_type || '',
      referenceRole: record.reference_role,
      pairKey: record.pair_key,
      sourcePath: record.source_path,
      sourceName: record.name,
      heading: `${record.clause_no || ''} ${record.title || ''}`.trim()
    }
  }))
  for (const batch of chunk(points, 64)) await vectorRequest(`/collections/${VECTOR_COLLECTION}/points?wait=true`, 'PUT', { points: batch })
  console.log(`[vector-store] Synced ${points.length} evidence vectors to ${VECTOR_COLLECTION}`)
  return { synced: points.length, skipped: false }
}

export async function searchVectorEvidence(topics, { limit = 24, contractType = '', subType = '' } = {}) {
  if (!getVectorStatus().enabled) {
    // ★ 原本这里静默 return [] —— 检索侧"混合 RAG"会一路只剩词法腿而无任何痕迹
    noteVectorUnavailable('not-configured')
    return []
  }
  const outputs = []
  const vectors = await embedTexts(topics.map((topic) => `${topic.label}\n${topic.query}`))
  // 过滤条件与词法侧保持一致：contractType 必给，subType 可选。
  // 语义检索本身不含"这条证据属于哪类合同"的信号 ⇒ 不加过滤就会把串味证据捞回来。
  const conditions = []
  if (contractType) conditions.push({ key: 'contractType', match: { value: contractType } })
  if (subType) conditions.push({ key: 'subType', match: { value: subType } })
  for (let index = 0; index < topics.length; index++) {
    const topic = topics[index]
    const body = {
      query: vectors[index],
      limit,
      with_payload: true,
      ...(conditions.length ? { filter: { must: conditions } } : {})
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

async function embedTexts(texts) {
  const output = []
  for (const batch of chunk(texts, 32)) {
    const response = await fetch(EMBEDDING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch })
    })
    if (!response.ok) throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`)
    const data = await response.json()
    const vectors = (data?.data || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map((item) => item.embedding)
    if (vectors.length !== batch.length || vectors.some((vector) => !Array.isArray(vector))) throw new Error('Embedding response format is invalid')
    output.push(...vectors)
  }
  return output
}

async function ensureCollection(size) {
  const existing = await fetch(`${VECTOR_URL}/collections/${VECTOR_COLLECTION}`, { headers: vectorHeaders() })
  if (existing.ok) return
  await vectorRequest(`/collections/${VECTOR_COLLECTION}`, 'PUT', { vectors: { size, distance: 'Cosine' } })
}

async function deleteCollection() {
  const response = await fetch(`${VECTOR_URL}/collections/${VECTOR_COLLECTION}`, { method: 'DELETE', headers: vectorHeaders() })
  if (!response.ok && response.status !== 404) throw new Error(`Unable to reset vector collection: ${response.status}`)
}

async function vectorRequest(path, method, body) {
  const response = await fetch(`${VECTOR_URL}${path}`, { method, headers: vectorHeaders(), body: JSON.stringify(body) })
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
