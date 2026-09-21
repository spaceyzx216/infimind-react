/**
 * 用工咨询知识库的向量索引。
 *
 * 存储决策：**在 labor.db 内以 BLOB 存向量 + 进程内暴力余弦检索**，不引入 Qdrant。
 * 理由：语料仅 764 条 × 1024 维（约 3 MB），暴力检索是 78 万次乘加，亚毫秒级完成；
 * 而 Qdrant 需要额外服务（项目现状是没起，导致合同知识库的向量路长期静默失效）。
 * 语料增长到数万条以上时再迁 Qdrant，接口保持不变。
 *
 * 向量在写入时归一化，检索时退化为纯点积。
 */
import { createHash } from 'crypto'
import { getDb } from './law-whitelist.js'
import { embedTexts, embedQuery, isEmbeddingConfigured } from './siliconflow-client.js'

const DIM_EXPECTED = 1024
const EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL || 'BAAI/bge-m3'

/** 进程内索引缓存：{ ids: number[], vectors: Float32Array, dim, count } */
let indexCache = null
/**
 * 建立 indexCache 时的 `PRAGMA data_version`。
 *
 * 为什么需要它：`npm run build:labor-embeddings` 是**独立进程**，它写入向量后只能清空
 * 自己的缓存，服务器进程无从感知——此前必须**重启服务器**才会生效。
 *
 * `PRAGMA data_version` 只在**其它连接**提交修改后变化（已实测：同连接读写不变，
 * 跨进程写入 2→3），语义正好匹配。同连接写入由 saveEmbedding() 显式置空缓存覆盖。
 */
let indexCacheVersion = -1
/** 空索引的共享返回体，避免每次分配（不放进 indexCache 以外的任何地方） */
const EMPTY_INDEX = Object.freeze({ ids: [], vectors: new Float32Array(0), dim: 0, count: 0 })
/** 最近一次索引加载失败的原因（数据损坏等）。用于把 index_corrupt 与 index_empty 区分开 */
let indexLoadError = ''

export function initializeLaborVector() {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS labor_kb_embeddings (
      entry_id INTEGER PRIMARY KEY REFERENCES labor_kb_entries(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      content_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kb_embed_model ON labor_kb_embeddings(model);
  `)
  return db
}

/** 条目文本的向量化输入：标题权重最高，其次是章节路径与正文开头 */
export function embeddingTextOf(entry) {
  const title = String(entry.title || '').trim()
  const path = [entry.chapter, entry.section, entry.subsection].filter(Boolean).join(' ')
  const content = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 2000)
  return [title, path, content].filter(Boolean).join('\n')
}

export const contentHashOf = (entry) => createHash('sha256')
  .update(embeddingTextOf(entry))
  .digest('hex').slice(0, 32)

/** 归一化：检索时可用点积代替余弦 */
function normalize(vector) {
  let norm = 0
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (!norm) return vector
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm
  return out
}

const toBlob = (floatArray) => Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength)

export function saveEmbedding(entryId, vector, { contentHash } = {}) {
  const db = initializeLaborVector()
  // 无条件归一化。此前写成 `vector instanceof Float32Array ? vector : normalize(vector)`，
  // 隐含假设"Float32Array 一定是已归一化的"——该假设没有任何保证。一旦后续调用方
  // 图省事直接传 Float32Array，向量就会以未归一化状态入库，而检索端用的是点积，
  // 于是相似度被 |v| 缩放、排序静默失真。searchVector 一直是无条件归一化的，这里对齐。
  const normalized = normalize(vector)
  db.prepare(`INSERT INTO labor_kb_embeddings (entry_id, model, dim, vector, content_hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      model = excluded.model, dim = excluded.dim, vector = excluded.vector,
      content_hash = excluded.content_hash, created_at = CURRENT_TIMESTAMP`)
    .run(entryId, EMBEDDING_MODEL, normalized.length, toBlob(normalized), contentHash || '')
  // 同连接写入不会改变 data_version，必须显式失效
  resetIndexCache()
  return normalized.length
}

export function getEmbeddedMap() {
  const db = initializeLaborVector()
  const rows = db.prepare('SELECT entry_id, content_hash FROM labor_kb_embeddings WHERE model = ?').all(EMBEDDING_MODEL)
  return new Map(rows.map((row) => [row.entry_id, row.content_hash]))
}

function loadIndex() {
  const db = initializeLaborVector()
  const dataVersion = db.pragma('data_version', { simple: true })
  // 缓存命中要求 data_version 一致：其它进程改动过库就必须重建
  if (indexCache && indexCacheVersion === dataVersion) return indexCache

  const rows = db.prepare('SELECT entry_id, dim, vector FROM labor_kb_embeddings WHERE model = ? ORDER BY entry_id')
    .all(EMBEDDING_MODEL)
  if (!rows.length) {
    // ⚠️ 空索引也要连同 data_version 一起缓存。
    // 曾经的写法只缓存空结果、不记版本：一旦本进程在某次检索时缓存了 `count: 0`，
    // 其它进程随后补建向量也永远不会被发现 → 本进程持续报 index_empty 直到重启。
    indexLoadError = ''
    indexCache = EMPTY_INDEX
    indexCacheVersion = dataVersion
    return indexCache
  }
  const dim = rows[0].dim
  // 所有行必须同维。混维会让下面的 vectors.set 写坏内存：
  //   row.dim > dim → 越界覆盖后续行、甚至超出缓冲区抛 RangeError 打断整次检索
  //   row.dim < dim → 留下空洞，该行相似度恒为 0，排序静默错误
  // 这类"看似正常实则错误"的结果比拒绝服务危险得多，因此宁可拒绝建索引
  // （降级为可见的 index_corrupt / index_empty），也不返回错误排序。
  const corrupt = dim <= 0 || rows.some((row) => row.dim !== dim || !row.vector || row.vector.length < row.dim * 4)
  if (corrupt) {
    const dims = [...new Set(rows.map((row) => row.dim))].join('、')
    indexLoadError = `向量维度不一致或数据损坏（库内维度：${dims}）`
    console.error(`[labor-vector] 索引拒绝加载：${indexLoadError}。`
      + '请运行 npm run build:labor-embeddings -- --force 重建')
    indexCache = EMPTY_INDEX
    indexCacheVersion = dataVersion
    return indexCache
  }
  const ids = new Array(rows.length)
  const vectors = new Float32Array(rows.length * dim)
  rows.forEach((row, rowIndex) => {
    ids[rowIndex] = row.entry_id
    const source = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim)
    vectors.set(source, rowIndex * dim)
  })
  indexLoadError = ''
  indexCache = { ids, vectors, dim, count: rows.length }
  indexCacheVersion = dataVersion
  return indexCache
}

export function resetIndexCache() {
  indexCache = null
  indexCacheVersion = -1
  indexLoadError = ''
}

/**
 * 向量检索：对查询向量与全部条目向量做点积（已归一化，等价余弦）。
 * @param {number[]|Float32Array} queryVector
 * @param {{ limit?: number }} options
 * @returns {Array<{ entryId: number, similarity: number }>}
 */
export function searchVector(queryVector, { limit = 30 } = {}) {
  const index = loadIndex()
  if (!index.count) return []
  const dim = index.dim
  const query = normalize(queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector))
  if (query.length !== dim) {
    console.warn(`[labor-vector] 查询向量维度 ${query.length} 与索引维度 ${dim} 不一致，跳过向量检索`)
    return []
  }
  const scored = new Array(index.count)
  for (let row = 0; row < index.count; row += 1) {
    const offset = row * dim
    let dot = 0
    for (let i = 0; i < dim; i += 1) dot += query[i] * index.vectors[offset + i]
    scored[row] = { entryId: index.ids[row], similarity: dot }
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
}

/**
 * 对文本做向量检索（封装 embedding 调用）。
 * @returns {Promise<{ hits: Array, degraded: boolean, reason?: string }>}
 */
export async function semanticSearch(text, { limit = 30 } = {}) {
  if (!isEmbeddingConfigured()) {
    return { hits: [], degraded: true, reason: 'not_configured' }
  }
  const index = loadIndex()
  if (!index.count) {
    // 区分"没建过"与"数据损坏被拒绝加载"——后者需要 --force 重建
    return { hits: [], degraded: true, reason: indexLoadError ? 'index_corrupt' : 'index_empty' }
  }
  try {
    const vector = await embedQuery(text)
    // 维度不一致时 searchVector 会返回空数组，若在此直接返回 degraded:false，
    // 上层会记成"用了向量路但零结果"——召回被静默丢掉且不产生任何告警。
    // 这里显式判为降级，让问题浮到 warnings 与 health 计数上。
    if (vector.length !== index.dim) {
      console.warn(`[labor-vector] 查询向量维度 ${vector.length} 与索引维度 ${index.dim} 不一致，语义召回降级`)
      return { hits: [], degraded: true, reason: 'dim_mismatch' }
    }
    return { hits: searchVector(vector, { limit }), degraded: false }
  } catch (error) {
    return { hits: [], degraded: true, reason: error.message }
  }
}

/**
 * 向量索引状态。
 *
 * ⚠️ 前置依赖：需要 `labor_kb_entries` 表已存在（由 labor-kb.js 的 `initializeLaborKb()` 创建）。
 * `initializeLaborVector()` 只建 `labor_kb_embeddings`，其外键指向 `labor_kb_entries`
 * 但 SQLite 允许前向引用，所以建表会成功、查表才报错。调用方必须先确保该表已创建。
 */
export function getLaborVectorStatus() {
  const db = initializeLaborVector()
  const total = db.prepare('SELECT COUNT(*) AS c FROM labor_kb_entries').get().c
  const embedded = db.prepare('SELECT COUNT(*) AS c FROM labor_kb_embeddings WHERE model = ?').get(EMBEDDING_MODEL).c
  // dim 必须按当前模型过滤：原先的 `LIMIT 1` 不带 model 条件，
  // 库里存在其它模型的向量时会报出错误的维度。
  const dim = db.prepare('SELECT dim FROM labor_kb_embeddings WHERE model = ? LIMIT 1').get(EMBEDDING_MODEL)?.dim || 0
  // 库内实际存在哪些模型名。这是诊断"改过 RAG_EMBEDDING_MODEL 但没重建索引"的唯一线索——
  // 此前只返回**配置**的模型名，不一致时仅表现为 embedded=0，看不出原因。
  const storedModels = db.prepare('SELECT model, COUNT(*) AS count FROM labor_kb_embeddings GROUP BY model ORDER BY count DESC').all()
  return {
    model: EMBEDDING_MODEL,
    storedModels,
    // 库里有向量、但没有一条属于当前配置的模型 → 几乎一定是改过模型名而未重建
    modelMismatch: embedded === 0 && storedModels.length > 0,
    configured: isEmbeddingConfigured(),
    entries: total,
    embedded,
    coverage: total ? Number((embedded / total).toFixed(4)) : 0,
    dimension: dim,
    ready: embedded > 0
  }
}

/**
 * 为缺失或内容变更的条目补齐向量。
 * @param {{ batchSize?: number, onProgress?: Function, force?: boolean }} options
 */
export async function buildEmbeddings({ batchSize = 12, onProgress, force = false } = {}) {
  const db = initializeLaborVector()
  const entries = db.prepare('SELECT id, title, content, chapter, section, subsection FROM labor_kb_entries ORDER BY id').all()
  const existing = force ? new Map() : getEmbeddedMap()
  const pending = entries.filter((entry) => existing.get(entry.id) !== contentHashOf(entry))

  if (!pending.length) return { total: entries.length, embedded: 0, skipped: entries.length }

  let done = 0
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const vectors = await embedTexts(batch.map(embeddingTextOf), { batchSize })
    batch.forEach((entry, idx) => {
      if (!vectors[idx]) return
      // 维度异常一律**丢弃而不是存下来**：存进去会让整个索引维度不一致，
      // 在 loadIndex() 里造成越界写入或空洞（相似度恒为 0），产生"看似正常实则错误"的排序。
      // 宁可少一条召回，也不污染索引。
      if (vectors[idx].length !== DIM_EXPECTED) {
        console.warn(`[labor-vector] 条目 ${entry.id} 向量维度异常 ${vectors[idx].length}（期望 ${DIM_EXPECTED}），已跳过`)
        return
      }
      saveEmbedding(entry.id, vectors[idx], { contentHash: contentHashOf(entry) })
      done += 1
    })
    onProgress?.({ done, total: pending.length })
  }
  resetIndexCache()
  return { total: entries.length, embedded: done, skipped: entries.length - pending.length }
}
