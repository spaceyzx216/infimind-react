/**
 * 用工风险实务问答知识库（labor.db 内的第二张知识表）。
 *
 * 数据来源：用户提供的五册《用工风险》实务资料，经 labor-book-parser 解析为
 * 「问题 + 答案」结构化条目（764 条，其中约 35% 含真实裁判文书案号）。
 *
 * 与其它两路检索的分工：
 *   - 本模块（实务问答）→ 回答"这类问题实务上怎么处理、裁判倾向如何"
 *   - 法规白名单        → 回答"依据是什么法条、是否现行有效"
 *   - templates.db      → 回答"我们的合同条款该怎么写"
 *
 * 中文检索同样使用 2-gram（见 cjk-tokenizer.js），否则 FTS5 的 unicode61
 * 会把整段中文当成一个 token，导致命中 0 条。
 */
import { toIndexText, buildFtsQuery, extractQueryTerms, collectTermsFromCases } from './cjk-tokenizer.js'
import { getDb } from './law-whitelist.js'
import { semanticSearch, getLaborVectorStatus } from './labor-vector.js'
import { rerank as rerankDocuments, getRetrievalHealth, isRerankConfigured } from './siliconflow-client.js'

const DEFAULT_LIMIT = 5
/** 同义词扩展词的打分权重（字面命中为 1.0） */
const EXPANDED_WEIGHT = Number(process.env.LABOR_KB_EXPANDED_WEIGHT || 0.45)
/**
 * 标题覆盖率权重与章节路径权重。
 *
 * ⚠️ **默认 0（关闭）**。这两项曾被认为是有效信号，但实测在生产候选池规模下：
 *   | 配置 | precision@6 | 内容召回@1 |
 *   | 路径0/覆盖0（默认） | 23.9% | 55.2% |
 *   | 路径0.25/覆盖3    | 23.3% | 54.5% |
 *   | 路径0.5/覆盖0     | 22.2% | 53.4% |
 * 两项都只会降低指标。此前"离线调参显示 +1.8pt"的结论**不可迁移**——
 * 那次实验用了 30 条候选（对应 FTS 池 180 条），远大于生产的 limit*6 池，
 * 排序信号的效力随候选池大小变化。
 *
 * 保留为可配置项，便于后续在**生产候选池规模**下重新验证；
 * 调参务必用真实 limit 跑 `npm run evaluate:labor-kb`，否则结论无效。
 */
const COVERAGE_WEIGHT = Number(process.env.LABOR_KB_COVERAGE_WEIGHT ?? 0)
const PATH_WEIGHT = Number(process.env.LABOR_KB_PATH_WEIGHT ?? 0)

// ---------------------------------------------------------------------------
// 混合检索可调参数（均可用环境变量覆盖，便于参数扫描）
// ---------------------------------------------------------------------------
/** 词法路候选数 */
const LEXICAL_CANDIDATES = Number(process.env.LABOR_KB_LEXICAL_CANDIDATES || 30)
/** 语义路候选数 */
const VECTOR_CANDIDATES = Number(process.env.LABOR_KB_VECTOR_CANDIDATES || 30)
/** RRF 融合常数：越大则各名次的权重差距越小 */
const RRF_K = Number(process.env.LABOR_KB_RRF_K || 60)
/** 送入模型重排的候选数 */
const RERANK_POOL = Number(process.env.LABOR_KB_RERANK_POOL || 24)
/** 重排分与 RRF 分的融合权重：final = rerank×α + rrf×(1-α)。
 *  α=1 完全信任重排；α=0 等价于不用重排。 */
const RERANK_BLEND = Number(process.env.LABOR_KB_RERANK_BLEND ?? 0.8)
/**
 * 最小重排分阈值（重排原始分，绝对分）。
 *
 * 依据 30 题 LLM 判定的阈值分析：
 *   阈值 0.05 → 误杀相关 2 条，滤掉不相关 20 条，相关保留率 97.4%
 *   阈值 0.10 → 误杀相关 3 条，滤掉不相关 24 条，相关保留率 96.1%
 *   阈值 0.50 → 误杀相关 15 条，相关保留率降至 80.3%（过于激进）
 * 取 0.05 作为"安全下限"：几乎不损失相关，同时减少送入模型的噪声。
 * 仅当重排成功时才生效；重排降级时不做阈值过滤（避免把词法结果一并滤空）。
 */
const MIN_RERANK_SCORE = Number(process.env.LABOR_KB_MIN_RERANK ?? 0.05)
/** 阈值过滤的保底条数：即便全部低于阈值也至少返回这么多条，避免检索结果为空 */
const MIN_KEEP = Number(process.env.LABOR_KB_MIN_KEEP || 2)
/** 是否启用语义召回 / 模型重排（便于做消融实验） */
const VECTOR_ENABLED = process.env.LABOR_KB_VECTOR !== 'off'
const RERANK_ENABLED = process.env.LABOR_KB_RERANK !== 'off'

let termCache = null
/** 检索词的标题文档频率缓存（IDF 用），导入数据后需失效 */
const dfCache = new Map()

export function initializeLaborKb() {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS labor_kb_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book TEXT DEFAULT '',
      chapter TEXT DEFAULT '',
      section TEXT DEFAULT '',
      subsection TEXT DEFAULT '',
      question_no TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      char_count INTEGER DEFAULT 0,
      case_refs TEXT DEFAULT '[]',
      content_hash TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS labor_kb_fts USING fts5(
      title, content, chapter, section, subsection, tokenize='unicode61'
    );
    CREATE INDEX IF NOT EXISTS idx_kb_book ON labor_kb_entries(book);
    CREATE INDEX IF NOT EXISTS idx_kb_chapter ON labor_kb_entries(chapter);
  `)
  return db
}

/** 幂等写入：按 content_hash 去重，重复条目跳过而非覆盖 */
export function addKbEntry(entry, hash) {
  const db = initializeLaborKb()
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM labor_kb_entries WHERE content_hash = ?').get(hash)
    if (existing) return { id: existing.id, inserted: false }
    const result = db.prepare(`INSERT INTO labor_kb_entries
      (book, chapter, section, subsection, question_no, title, content, char_count, case_refs, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.book || '', entry.chapter || '', entry.section || '', entry.subsection || '',
      entry.questionNo || '', entry.title || '', entry.content || '',
      String(entry.content || '').length, JSON.stringify(entry.caseRefs || []), hash
    )
    const id = Number(result.lastInsertRowid)
    db.prepare('INSERT INTO labor_kb_fts (rowid, title, content, chapter, section, subsection) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, toIndexText(entry.title || ''), toIndexText(entry.content || ''),
        toIndexText(entry.chapter || ''), toIndexText(entry.section || ''), toIndexText(entry.subsection || ''))
    termCache = null
    dfCache.clear()
    return { id, inserted: true }
  })()
}

/**
 * 标题文档频率与 IDF。
 * 「解除」这类词出现在绝大多数标题中，区分度低；「旷工」「竞业限制」只出现在少数标题中，
 * 区分度高。用 IDF 加权可避免高频泛词主导排序。
 */
function titleDf(term) {
  if (dfCache.has(term)) return dfCache.get(term)
  const db = initializeLaborKb()
  const row = db.prepare('SELECT COUNT(*) AS c FROM labor_kb_entries WHERE title LIKE ?').get(`%${term}%`)
  const value = row?.c || 0
  dfCache.set(term, value)
  return value
}

function idf(term) {
  const total = dfCache.get('__total__') ?? (() => {
    const db = initializeLaborKb()
    const value = db.prepare('SELECT COUNT(*) AS c FROM labor_kb_entries').get().c || 1
    dfCache.set('__total__', value)
    return value
  })()
  return Math.log(1 + total / (1 + titleDf(term)))
}

const mapEntry = (row) => ({
  id: row.id,
  book: row.book || '',
  chapter: row.chapter || '',
  section: row.section || '',
  subsection: row.subsection || '',
  questionNo: row.question_no || '',
  title: row.title || '',
  content: row.content || '',
  charCount: row.char_count || 0,
  caseRefs: (() => { try { return JSON.parse(row.case_refs || '[]') } catch { return [] } })()
})

/** 检索词表：由标题与章节名组成，提升专业术语命中率（缓存） */
function buildTermCache() {
  if (termCache) return termCache
  const db = initializeLaborKb()
  const rows = db.prepare('SELECT title, section, subsection FROM labor_kb_entries').all()
  const terms = new Set()
  for (const row of rows) {
    collectTermsFromCases([{ disputeFocus: String(row.title || '').replace(/[，。、；：？！,.;:?!]/g, ' ') }])
      .forEach((term) => terms.add(term))
    for (const text of [row.section, row.subsection]) {
      String(text || '').replace(/^[一二三四五六七八九十]+、|^[（(][一二三四五六七八九十]+[）)]/, '')
        .split(/[、，,／/\s]+/).forEach((term) => { if (term.length >= 3 && term.length <= 12) terms.add(term) })
    }
  }
  termCache = [...terms]
  return termCache
}

/**
 * 实务问答检索。
 *
 * 打分设计（按信号强度排序）：
 *   1. **标题命中检索词的 IDF 加权和** —— 最强信号。
 *      实务问答库的标题就是"问题"，标题与提问的用词重合度直接反映主题匹配度。
 *      用 IDF 加权是必要的：「解除」「劳动合同」几乎出现在所有标题里，
 *      而「旷工」「竞业限制」只出现在少数标题中，后者对区分度贡献大得多。
 *      早期实现用 FTS 的 RRF 分数 + 固定加成，候选分数几乎并列
 *      （实测 1.216 / 1.216 / 1.214），排序近似随机。
 *   2. 正文命中检索词的 IDF 加权和 × 0.35 —— 辅助信号。
 *   3. FTS 名次（RRF）× 4 —— 保留词频信息作为次级依据。
 *   4. 含裁判案号 +0.1/个（上限 0.3）—— 对"裁判倾向"类问题价值更高。
 *
 * ⚠️ **已知短板：区分度不足**。30 题 LLM 判定显示，「相关」条目的分数中位 8.9、
 *   「不相关」8.5，分布高度重叠（详见 docs 第十三节）。
 *   后果：**无法设置最小匹配度阈值**——任何能滤掉噪声的阈值都会同时误杀相关条目
 *   （丢弃最低 25% 时误杀 15 条相关、仅丢弃 44 条不相关）。
 *   改进方向见 docs「重排优化空间」一节，首选接入模型重排。
 *
 * @param {string} query
 * @param {{ limit?: number }} options
 * @returns {Array}
 */
export function searchLaborKbLexical(query, { limit = LEXICAL_CANDIDATES } = {}) {
  const db = initializeLaborKb()
  // 字面命中权重 1.0，同义词扩展权重 EXPANDED_WEIGHT：
  // 扩展词能救回"口语 vs 专业表述"不匹配的提问，但等权会稀释字面匹配的精度。
  const { primary, expanded } = extractQueryTerms(query, { limit: 14, extraTerms: buildTermCache() })
  const termWeights = new Map()
  primary.forEach((term) => termWeights.set(term, 1))
  expanded.forEach((term) => { if (!termWeights.has(term)) termWeights.set(term, EXPANDED_WEIGHT) })
  const keywords = [...termWeights.keys()]
  const hits = new Map()
  const ftsQuery = buildFtsQuery(keywords)

  if (ftsQuery) {
    try {
      const rows = db.prepare(`SELECT labor_kb_entries.*, rank FROM labor_kb_fts
        JOIN labor_kb_entries ON labor_kb_entries.id = labor_kb_fts.rowid
        WHERE labor_kb_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery, limit * 6)
      rows.forEach((row, index) => hits.set(row.id, { row, ftsRank: index + 1 }))
    } catch (error) {
      console.warn('[labor-kb] FTS 检索回退:', error.message)
    }
  }

  // 补齐候选：标题直接包含检索词的条目（应对 FTS 短语查询过严导致的漏召回）
  for (const keyword of keywords.slice(0, 8)) {
    if (keyword.length < 2) continue
    const rows = db.prepare('SELECT * FROM labor_kb_entries WHERE title LIKE ? LIMIT ?')
      .all(`%${keyword}%`, limit * 2)
    for (const row of rows) {
      if (!hits.has(row.id)) hits.set(row.id, { row, ftsRank: null })
    }
  }

  const scored = []
  for (const { row, ftsRank } of hits.values()) {
    // 统一小写比对：英文缩写大小写不固定（标题写 Offer，用户写 offer）。
    // 早期实现区分大小写，导致「offer发出后公司反悔」匹配不到「企业取消已发的Offer…」。
    const title = String(row.title || '').toLowerCase()
    const content = String(row.content || '').toLowerCase()
    const path = `${row.book || ''} ${row.chapter || ''} ${row.section || ''} ${row.subsection || ''}`.toLowerCase()
    const titleTerms = keywords.filter((keyword) => title.includes(keyword.toLowerCase()))
    const contentTerms = keywords.filter((keyword) => content.includes(keyword.toLowerCase()))
    const pathTerms = keywords.filter((keyword) => path.includes(keyword.toLowerCase()))
    if (!titleTerms.length && !contentTerms.length && !pathTerms.length) continue   // 零覆盖的候选直接丢弃
    const mapped = mapEntry(row)
    const weightOf = (term) => termWeights.get(term) ?? EXPANDED_WEIGHT
    const titleScore = titleTerms.reduce((sum, term) => sum + idf(term) * weightOf(term), 0)
    const contentScore = contentTerms.reduce((sum, term) => sum + idf(term) * weightOf(term), 0)
    // 章节路径（册/章/节/小节）命中也是有效信号：
    // 同章节的条目主题相近，可缓解"同一法条被多条引用"造成的排序抖动。
    const pathScore = pathTerms.reduce((sum, term) => sum + idf(term) * weightOf(term), 0)
    // 标题覆盖率：标题命中的查询词占全部查询词的比例。
    // 它对"短标题 + 高覆盖"的条目更友好，实测可提升 precision 约 1.8pt。
    const coverage = keywords.length ? titleTerms.length / keywords.length : 0
    const caseBonus = mapped.caseRefs.length ? Math.min(0.3, mapped.caseRefs.length * 0.1) : 0
    const ftsScore = ftsRank ? 4 / (60 + ftsRank) : 0
    scored.push({
      ...mapped,
      score: titleScore + contentScore * 0.35 + pathScore * PATH_WEIGHT + coverage * COVERAGE_WEIGHT + ftsScore + caseBonus,
      matchedTerms: { title: titleTerms.length, content: contentTerms.length, path: pathTerms.length, coverage: Number(coverage.toFixed(2)) }
    })
  }

  return scored
    .sort((a, b) => b.score - a.score || b.matchedTerms.title - a.matchedTerms.title)
    .slice(0, limit)
}

export function getLaborKbStatus() {
  const db = initializeLaborKb()
  const total = db.prepare('SELECT COUNT(*) AS c FROM labor_kb_entries').get().c
  const byBook = db.prepare('SELECT book, COUNT(*) AS count FROM labor_kb_entries GROUP BY book ORDER BY book').all()
  const withCases = db.prepare("SELECT COUNT(*) AS c FROM labor_kb_entries WHERE case_refs != '[]'").get().c
  const avgLength = db.prepare('SELECT AVG(char_count) AS avg FROM labor_kb_entries').get().avg
  return {
    entries: total,
    withCaseRefs: withCases,
    averageLength: avgLength ? Math.round(avgLength) : 0,
    byBook
  }
}

export function listKbEntries({ limit = 20, book = '' } = {}) {
  const db = initializeLaborKb()
  const sql = book
    ? 'SELECT * FROM labor_kb_entries WHERE book = ? ORDER BY id LIMIT ?'
    : 'SELECT * FROM labor_kb_entries ORDER BY id LIMIT ?'
  const rows = book ? db.prepare(sql).all(book, limit) : db.prepare(sql).all(limit)
  return rows.map(mapEntry)
}

/** 清空问答库（重新导入时使用；不影响法规白名单与案例库） */
export function resetLaborKb() {
  const db = initializeLaborKb()
  db.transaction(() => {
    db.prepare('DELETE FROM labor_kb_fts').run()
    db.prepare('DELETE FROM labor_kb_entries').run()
  })()
  termCache = null
  dfCache.clear()
}

// ---------------------------------------------------------------------------
// 混合检索：词法（2-gram FTS）+ 语义（bge-m3 向量）→ RRF 融合 → 模型重排
// ---------------------------------------------------------------------------

/**
 * 归一化到 [0,1]，用于把重排分与 RRF 分放到同一量纲后再融合。
 * RRF 分天然在 0~2/(k+1) 区间且分布极窄，直接线性加权会被重排分淹没。
 */
function normalizeScores(items, key) {
  if (!items.length) return
  const values = items.map((item) => item[key])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  items.forEach((item) => { item[`${key}Norm`] = span > 0 ? (item[key] - min) / span : 1 })
}

/**
 * 混合检索主入口（生产路径）。
 *
 * 流程：
 *   ① 词法召回  FTS5（2-gram）+ 标题 LIKE 补齐      → LEXICAL_CANDIDATES
 *   ② 语义召回  bge-m3 向量 + 暴力余弦              → VECTOR_CANDIDATES
 *   ③ RRF 融合  1/(RRF_K + rank)，两路求和
 *   ④ 取融合 top RERANK_POOL
 *   ⑤ 模型重排  bge-reranker-v2-m3
 *   ⑥ 按 RERANK_BLEND 融合重排分与 RRF 分，返回 top limit
 *
 * **降级可见**：返回对象带 `retrieval` 字段说明本轮实际用了哪些路，
 * 任一路失败都会标记 degraded 并给出原因，不再静默回落。
 *
 * @param {string} query
 * @param {{ limit?: number }} options
 * @returns {Promise<Array & { retrieval: object }>}
 */
export async function searchLaborKb(query, { limit = DEFAULT_LIMIT } = {}) {
  const started = Date.now()
  const retrieval = {
    mode: 'hybrid',
    lexical: { used: true, count: 0 },
    vector: { used: false, count: 0, degraded: false, reason: '' },
    rerank: { used: false, count: 0, degraded: false, reason: '' },
    filteredByScore: 0,
    elapsedMs: 0
  }

  // ① 词法召回
  const lexical = searchLaborKbLexical(query, { limit: LEXICAL_CANDIDATES })
  retrieval.lexical.count = lexical.length

  // ② 语义召回
  let semantic = []
  if (VECTOR_ENABLED) {
    const vectorStatus = getLaborVectorStatus()
    if (!vectorStatus.ready) {
      retrieval.vector.degraded = true
      // 区分两种"索引不可用"，因为处置动作不同：
      //  - model_mismatch：库里有向量，但属于别的模型名（改过 RAG_EMBEDDING_MODEL 没重建）
      //  - index_empty   ：从来没建过
      retrieval.vector.reason = vectorStatus.modelMismatch ? 'model_mismatch' : 'index_empty'
      if (vectorStatus.modelMismatch) {
        const stored = vectorStatus.storedModels.map((item) => `${item.model}(${item.count})`).join('、')
        console.warn(`[labor-kb] 语义召回降级：库内向量属于 ${stored}，与当前配置 ${vectorStatus.model} 不一致；`
          + '请运行 npm run build:labor-embeddings 重建（改了 RAG_EMBEDDING_MODEL 就必须重建）')
      } else {
        console.warn('[labor-kb] 语义召回降级：向量索引为空，请先运行 npm run build:labor-embeddings')
      }
    } else {
      const result = await semanticSearch(query, { limit: VECTOR_CANDIDATES })
      semantic = result.hits
      retrieval.vector.used = !result.degraded
      retrieval.vector.degraded = result.degraded
      retrieval.vector.reason = result.reason || ''
      retrieval.vector.count = semantic.length
    }
  } else {
    retrieval.vector.reason = 'disabled'
  }

  // ③ RRF 融合
  const fused = new Map()
  const addRank = (id, rank, source) => {
    const item = fused.get(id) || { id, rrf: 0, sources: [] }
    item.rrf += 1 / (RRF_K + rank)
    if (!item.sources.includes(source)) item.sources.push(source)
    fused.set(id, item)
  }
  lexical.forEach((row, index) => addRank(row.id, index + 1, 'lexical'))
  semantic.forEach((hit, index) => addRank(hit.entryId, index + 1, 'vector'))

  if (!fused.size) {
    retrieval.mode = 'empty'
    retrieval.elapsedMs = Date.now() - started
    const empty = []
    empty.retrieval = retrieval
    return empty
  }

  // 取库内完整条目
  const db = initializeLaborKb()
  const ids = [...fused.keys()]
  const rows = db.prepare(`SELECT * FROM labor_kb_entries WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  const lexicalById = new Map(lexical.map((row) => [row.id, row]))
  const similarityById = new Map(semantic.map((hit) => [hit.entryId, hit.similarity]))

  let candidates = rows.map((row) => {
    const fusion = fused.get(row.id)
    const mapped = mapEntry(row)
    return {
      ...mapped,
      rrf: fusion.rrf,
      sources: fusion.sources,
      similarity: similarityById.get(row.id) ?? null,
      lexicalScore: lexicalById.get(row.id)?.score ?? null,
      matchedTerms: lexicalById.get(row.id)?.matchedTerms ?? null,
      rerankScore: null
    }
  }).sort((a, b) => b.rrf - a.rrf)

  // ④ 截断到重排池
  const pool = candidates.slice(0, RERANK_POOL)

  // ⑤ 模型重排
  if (RERANK_ENABLED && pool.length > 1) {
    const { scores, degraded, reason } = await rerankDocuments(
      query,
      pool.map((item) => ({
        id: item.id,
        text: [item.title, [item.chapter, item.section].filter(Boolean).join(' '), String(item.content || '').slice(0, 1200)]
          .filter(Boolean).join('\n')
      }))
    )
    retrieval.rerank.degraded = degraded
    retrieval.rerank.reason = reason || ''
    if (!degraded && scores.size) {
      retrieval.rerank.used = true
      retrieval.rerank.count = scores.size
      pool.forEach((item) => { item.rerankScore = scores.get(item.id) ?? null })
    } else {
      console.warn(`[labor-kb] 模型重排降级（${reason || 'unknown'}），本轮按 RRF 融合分排序`)
    }
  } else if (!RERANK_ENABLED) {
    retrieval.rerank.reason = 'disabled'
  }

  // ⑥ 融合重排分与 RRF 分
  const hasRerank = pool.some((item) => item.rerankScore !== null)
  if (hasRerank) {
    normalizeScores(pool, 'rerankScore')
    normalizeScores(pool, 'rrf')
    pool.forEach((item) => {
      item.score = item.rerankScore !== null
        ? item.rerankScoreNorm * RERANK_BLEND + item.rrfNorm * (1 - RERANK_BLEND)
        : item.rrfNorm * 0.5                 // 重排未覆盖的候选降权处理
      item.scoreSource = 'rerank+rrf'
    })
  } else {
    normalizeScores(pool, 'rrf')
    pool.forEach((item) => { item.score = item.rrfNorm; item.scoreSource = 'rrf' })
  }

  let ranked = pool.sort((a, b) => b.score - a.score)

  // 阈值过滤：仅在重排成功时生效，且始终保留保底条数
  if (hasRerank && MIN_RERANK_SCORE > 0) {
    const above = ranked.filter((item) => (item.rerankScore ?? 1) >= MIN_RERANK_SCORE)
    const kept = above.length >= MIN_KEEP ? above : ranked.slice(0, MIN_KEEP)
    retrieval.filteredByScore = ranked.length - kept.length
    ranked = kept
  }

  ranked = ranked.slice(0, limit)
  retrieval.mode = retrieval.vector.used && retrieval.rerank.used
    ? 'hybrid+rerank'
    : retrieval.vector.used ? 'hybrid' : 'lexical-only'
  retrieval.elapsedMs = Date.now() - started

  const output = ranked
  output.retrieval = retrieval
  return output
}

/** 检索健康度汇总：供 /api/labor/status 暴露，替代静默降级 */
export function getLaborSearchHealth() {
  return {
    vector: getLaborVectorStatus(),
    providers: getRetrievalHealth(),
    rerankConfigured: isRerankConfigured(),
    params: { LEXICAL_CANDIDATES, VECTOR_CANDIDATES, RRF_K, RERANK_POOL, RERANK_BLEND, MIN_RERANK_SCORE, MIN_KEEP, VECTOR_ENABLED, RERANK_ENABLED }
  }
}
