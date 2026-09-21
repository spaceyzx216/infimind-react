import Database from 'better-sqlite3'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { splitIntoClauses, extractRiskRules, inferRiskCategory } from './knowledge-processor.js'
import { rerankEvidence, getRerankerStatus } from './evidence-reranker.js'
import { getVectorStatus, searchVectorEvidence } from './vector-store.js'
import { classifyError } from './siliconflow-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = join(__dirname, '..', 'knowledge-base', 'templates.db')
const DEFAULT_TEMPLATES_DIR = join(__dirname, '..', 'knowledge-base', 'templates')
const DEFAULT_INDEX_PATH = join(__dirname, '..', 'knowledge-base', 'index.json')
const RRF_K = 60
let db = null

/**
 * 合同知识库检索的运行时健康计数。
 *
 * 此前向量路失败只打一行 console.warn，且异常在 searchEvidence 内部就被吞掉，
 * 接口层永远不会 reject —— 结果是这条路径 100% 降级却对用户与监控完全不可见，
 * 正是"以为在跑混合检索、实际是坏掉的单路词法"这一教训的合同侧版本。
 */
const evidenceHealth = {
  vector: { attempted: 0, ok: 0, degraded: 0, lastReason: '' },
  rerank: { attempted: 0, ok: 0, degraded: 0, lastReason: '' }
}

export function getEvidenceRetrievalHealth() {
  return {
    vector: { ...evidenceHealth.vector, available: evidenceHealth.vector.ok > 0 },
    rerank: { ...evidenceHealth.rerank, available: evidenceHealth.rerank.ok > 0 }
  }
}

export function initialize(dbPath = DEFAULT_DB_PATH) {
  if (db) return db
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contract_type TEXT DEFAULT '',
      industry TEXT DEFAULT '',
      description TEXT DEFAULT '',
      reference_role TEXT DEFAULT 'reference',
      review_notes TEXT DEFAULT '',
      source_file TEXT DEFAULT '',
      source_path TEXT DEFAULT '',
      pair_key TEXT DEFAULT '',
      content_hash TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS templates_fts USING fts5(
      name, contract_type, industry, description, content, tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS template_clauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      clause_key TEXT NOT NULL,
      clause_no TEXT DEFAULT '',
      title TEXT DEFAULT '',
      parent_title TEXT DEFAULT '',
      content TEXT NOT NULL,
      start_offset INTEGER DEFAULT 0,
      end_offset INTEGER DEFAULT 0,
      chunk_index INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(template_id, clause_key)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS clause_fts USING fts5(
      contract_type, reference_role, heading, content, tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS risk_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      clause_id INTEGER REFERENCES template_clauses(id) ON DELETE SET NULL,
      rule_key TEXT NOT NULL,
      category TEXT DEFAULT '其他履约风险',
      severity TEXT DEFAULT '中',
      trigger_text TEXT DEFAULT '',
      risk_text TEXT DEFAULT '',
      recommendation TEXT DEFAULT '',
      source_note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(template_id, rule_key)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS risk_rule_fts USING fts5(
      contract_type, category, severity, trigger_text, risk_text, recommendation, tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS evaluation_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL UNIQUE REFERENCES templates(id) ON DELETE CASCADE,
      contract_type TEXT DEFAULT '',
      source_file TEXT DEFAULT '',
      input_excerpt TEXT DEFAULT '',
      expected_rule_ids TEXT DEFAULT '[]',
      expected_categories TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_clauses_template ON template_clauses(template_id);
    CREATE INDEX IF NOT EXISTS idx_risk_rules_template ON risk_rules(template_id);
    CREATE INDEX IF NOT EXISTS idx_templates_type_role ON templates(contract_type, reference_role);
  `)

  const columns = db.prepare('PRAGMA table_info(templates)').all().map((column) => column.name)
  for (const [column, definition] of Object.entries({
    reference_role: "TEXT DEFAULT 'reference'", review_notes: "TEXT DEFAULT ''",
    source_path: "TEXT DEFAULT ''", pair_key: "TEXT DEFAULT ''", content_hash: "TEXT DEFAULT ''"
  })) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE templates ADD COLUMN ${column} ${definition}`)
  }
  console.log('[knowledge-base] Database initialized')
  return db
}

export async function loadTemplates(opts = {}) {
  const { templatesDir = DEFAULT_TEMPLATES_DIR, indexPath = DEFAULT_INDEX_PATH, dbPath = DEFAULT_DB_PATH } = opts
  const database = initialize(dbPath)
  const current = database.prepare('SELECT COUNT(*) AS count FROM templates').get().count
  if (current) return current
  let index = []
  try { index = JSON.parse(await readFile(indexPath, 'utf8')) } catch { return 0 }
  for (const item of index) {
    let content = item.description || item.name
    try { content = await readFile(join(templatesDir, item.text_file), 'utf8') } catch { /* fall back to metadata */ }
    addTemplate({
      name: item.name, contractType: item.contract_type, industry: item.industry,
      description: item.description, referenceRole: item.reference_role, reviewNotes: item.review_notes,
      sourceFile: item.source_file, sourcePath: item.source_path, pairKey: item.pair_key,
      contentHash: item.content_hash, content
    })
  }
  return index.length
}

/** 重建时同时清空条款索引、风险规则与回归评测集，避免旧数据残留。 */
export function resetKnowledgeBase() {
  if (!db) initialize()
  db.transaction(() => {
    db.prepare('DELETE FROM clause_fts').run()
    db.prepare('DELETE FROM risk_rule_fts').run()
    db.prepare('DELETE FROM evaluation_cases').run()
    db.prepare('DELETE FROM risk_rules').run()
    db.prepare('DELETE FROM template_clauses').run()
    db.prepare('DELETE FROM templates_fts').run()
    db.prepare('DELETE FROM templates').run()
  })()
}

/**
 * 写入一份素材的父文档、条款单元、风险规则和回归评测用例。
 */
export function addTemplate({
  name, contractType, industry, description, referenceRole, reviewNotes,
  sourceFile, sourcePath, pairKey, contentHash, content, clauses, riskRules
}) {
  if (!db) initialize()
  const resolvedClauses = clauses?.length ? clauses : splitIntoClauses(content)
  const resolvedRules = riskRules?.length ? riskRules : referenceRole === 'annotated_case'
    ? extractRiskRules(content, resolvedClauses) : []

  return db.transaction(() => {
    const document = db.prepare(`INSERT INTO templates
      (name, contract_type, industry, description, reference_role, review_notes, source_file, source_path, pair_key, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, contractType || '', industry || '', description || '', referenceRole || 'reference', reviewNotes || '', sourceFile || '', sourcePath || '', pairKey || '', contentHash || '')
    const templateId = Number(document.lastInsertRowid)
    db.prepare('INSERT INTO templates_fts (rowid, name, contract_type, industry, description, content) VALUES (?, ?, ?, ?, ?, ?)')
      .run(templateId, name, contractType || '', industry || '', description || '', content || '')

    const clauseIds = new Map()
    const insertClause = db.prepare(`INSERT INTO template_clauses
      (template_id, clause_key, clause_no, title, parent_title, content, start_offset, end_offset, chunk_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertClauseFts = db.prepare('INSERT INTO clause_fts (rowid, contract_type, reference_role, heading, content) VALUES (?, ?, ?, ?, ?)')
    for (const clause of resolvedClauses) {
      const row = insertClause.run(templateId, clause.clauseKey, clause.clauseNo || '', clause.title || '', clause.parentTitle || '', clause.content || '', clause.startOffset || 0, clause.endOffset || 0, clause.chunkIndex || 0)
      const clauseId = Number(row.lastInsertRowid)
      clauseIds.set(clause.clauseKey, clauseId)
      insertClauseFts.run(clauseId, contractType || '', referenceRole || 'reference', `${clause.clauseNo || ''} ${clause.title || ''} ${clause.parentTitle || ''}`.trim(), clause.content || '')
    }

    const ruleIds = []
    const insertRule = db.prepare(`INSERT INTO risk_rules
      (template_id, clause_id, rule_key, category, severity, trigger_text, risk_text, recommendation, source_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertRuleFts = db.prepare('INSERT INTO risk_rule_fts (rowid, contract_type, category, severity, trigger_text, risk_text, recommendation) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const rule of resolvedRules) {
      const row = insertRule.run(templateId, clauseIds.get(rule.sourceClauseKey) || null, rule.ruleKey, rule.category || '其他履约风险', rule.severity || '中', rule.triggerText || '', rule.riskText || '', rule.recommendation || '', rule.sourceNote || '')
      const ruleId = Number(row.lastInsertRowid)
      ruleIds.push(ruleId)
      insertRuleFts.run(ruleId, contractType || '', rule.category || '', rule.severity || '', rule.triggerText || '', rule.riskText || '', rule.recommendation || '')
    }

    if (referenceRole === 'annotated_case') {
      const inputExcerpt = stripAnnotations(resolvedClauses.map((item) => item.content).join('\n')).slice(0, 12000)
      const expectedCategories = resolvedRules.length
        ? [...new Set(resolvedRules.map((rule) => rule.category))]
        : [inferRiskCategory(inputExcerpt)]
      db.prepare(`INSERT INTO evaluation_cases
        (template_id, contract_type, source_file, input_excerpt, expected_rule_ids, expected_categories)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(templateId, contractType || '', sourceFile || '', inputExcerpt, JSON.stringify(ruleIds), JSON.stringify(expectedCategories))
    }
    return templateId
  })()
}

/** 旧接口保留给现有调用；新审查工作流请使用 searchEvidence。 */
export function search(query, options = {}) {
  if (!db) initialize()
  const contractType = options.contractType || ''
  return lexicalClauseSearch(query, { contractType, limit: options.limit || 6 }).map(toLegacyTemplate)
}

/**
 * 多主题混合检索：先做条款与风险规则的 BM25 召回，再按需并入向量召回，
 * 使用 RRF 融合，最后由可配置重排器与证据多样化选择最终上下文。
 *
 * @returns {Promise<Array & { retrieval: object }>}
 *   返回数组带 `retrieval` 字段说明本轮实际用了哪几路、哪一路降级及原因，
 *   调用方据此把降级写进用户可见的 warnings（与 labor-kb.js 的约定一致）。
 */
export async function searchEvidence(reviewPlan, options = {}) {
  if (!db) initialize()
  const { limit = 12, candidateLimit = 48, excludeTemplateId } = options
  const topics = reviewPlan?.topics?.length ? reviewPlan.topics : [{ id: 'topic-1', label: '通用合同审查', query: '合同' }]
  // 回退值「通用商业合同」并非数据库真实类型，参与 SQL 过滤会把全部模板筛为 0 条。
  // 未知类型时按空串处理，退化为跨类型召回，确保仍有证据可用。
  const rawType = reviewPlan?.contractType || ''
  const contractType = rawType && rawType !== '通用商业合同' ? rawType : ''
  const candidates = new Map()
  const retrieval = {
    vector: { used: false, count: 0, degraded: false, reason: '' },
    rerank: { used: false, degraded: false, reason: '' }
  }

  for (const topic of topics) {
    // 风险规则索引包含规范化的风险类别；把主题标签一并检索可避免原条款措辞
    // 与风险规则关键词不同而漏召回，例如“价税、付款与发票”。
    const lexicalQuery = [topic.label, topic.query].filter(Boolean).join(' OR ')
    const clauseRows = lexicalClauseSearch(lexicalQuery, { contractType, limit: 24, excludeTemplateId })
    clauseRows.forEach((row, index) => mergeCandidate(candidates, clauseRowToEvidence(row), topic, 1 / (RRF_K + index + 1)))
    const riskRows = lexicalRiskSearch(lexicalQuery, { contractType, limit: 24, excludeTemplateId })
    riskRows.forEach((row, index) => mergeCandidate(candidates, riskRowToEvidence(row), topic, 1 / (RRF_K + index + 1)))
  }

  const vectorStatus = getVectorStatus()
  if (!vectorStatus.enabled) {
    retrieval.vector.reason = 'not_configured'
  } else {
    evidenceHealth.vector.attempted += 1
    try {
      const vectorHits = await searchVectorEvidence(topics, { limit: 24, contractType })
      const vectorEvidence = getEvidenceByIds(vectorHits.map((hit) => hit.evidenceId), { excludeTemplateId })
      vectorEvidence.forEach((evidence, index) => {
        const vectorHit = vectorHits.find((hit) => hit.evidenceId === evidence.evidenceId)
        mergeCandidate(candidates, evidence, { id: vectorHit?.topicId || 'vector', label: vectorHit?.topicLabel || '语义匹配' }, 1 / (RRF_K + index + 1))
      })
      retrieval.vector.used = true
      retrieval.vector.count = vectorEvidence.length
      evidenceHealth.vector.ok += 1
    } catch (error) {
      // 结构化降级：分类 + 计数器 + 交给调用方写入用户可见 warnings
      const reason = error.reason || classifyError(0, error.message)
      retrieval.vector.degraded = true
      retrieval.vector.reason = reason
      evidenceHealth.vector.degraded += 1
      evidenceHealth.vector.lastReason = error.message
      console.warn(`[knowledge-base] Vector retrieval skipped (${reason}): ${error.message}`)
    }
  }

  const fused = [...candidates.values()].sort((a, b) => b.retrievalScore - a.retrievalScore).slice(0, candidateLimit)
  const reranked = await rerankEvidence({ reviewPlan, candidates: fused })
  if (reranked.retrieval) {
    retrieval.rerank = { ...reranked.retrieval }
    evidenceHealth.rerank.attempted += 1
    if (reranked.retrieval.degraded) {
      evidenceHealth.rerank.degraded += 1
      evidenceHealth.rerank.lastReason = reranked.retrieval.reason || ''
    } else {
      evidenceHealth.rerank.ok += 1
    }
  }

  // diversifyEvidence 会返回新数组，重排阶段挂上的 retrieval 不会自动带过来，这里显式补回。
  const diversified = diversifyEvidence(reranked, limit)
  diversified.retrieval = retrieval
  return diversified
}

export function listTemplates() {
  if (!db) initialize()
  return db.prepare(`SELECT id, name, contract_type, industry, description, reference_role, review_notes,
    source_file, source_path, pair_key, content_hash, created_at FROM templates ORDER BY contract_type, name`).all()
}

export function getKnowledgeBaseStatus() {
  if (!db) initialize()
  const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  return {
    documents: count('templates'), clauses: count('template_clauses'), riskRules: count('risk_rules'), evaluationCases: count('evaluation_cases'),
    roles: db.prepare('SELECT reference_role AS role, COUNT(*) AS count FROM templates GROUP BY reference_role').all(),
    contractTypes: db.prepare('SELECT contract_type AS contractType, COUNT(*) AS count FROM templates GROUP BY contract_type ORDER BY contract_type').all(),
    vector: getVectorStatus(),
    reranker: getRerankerStatus()
  }
}

export function listIndexableEvidence() {
  if (!db) initialize()
  const clauses = db.prepare(`SELECT 'clause:' || c.id AS evidence_id, 'clause' AS kind, c.id AS source_id,
    t.contract_type, t.reference_role, t.pair_key, t.source_path, t.name, c.clause_no, c.title, c.parent_title, c.content
    FROM template_clauses c JOIN templates t ON t.id = c.template_id`).all()
  const rules = db.prepare(`SELECT 'risk:' || r.id AS evidence_id, 'risk_rule' AS kind, r.id AS source_id,
    t.contract_type, t.reference_role, t.pair_key, t.source_path, t.name, COALESCE(c.clause_no, '') AS clause_no,
    COALESCE(c.title, r.category) AS title, r.category AS parent_title,
    trim(r.trigger_text || '\n' || r.risk_text || '\n' || r.recommendation) AS content
    FROM risk_rules r JOIN templates t ON t.id = r.template_id LEFT JOIN template_clauses c ON c.id = r.clause_id`).all()
  return [...clauses, ...rules].filter((item) => item.content?.trim())
}

export function listEvaluationCases({ limit = 100 } = {}) {
  if (!db) initialize()
  return db.prepare(`SELECT e.id, e.template_id, e.contract_type, e.source_file, e.input_excerpt,
    e.expected_rule_ids, e.expected_categories, t.name
    FROM evaluation_cases e JOIN templates t ON t.id = e.template_id ORDER BY e.id LIMIT ?`).all(limit)
}

export function extractSearchKeywords(analysisReport = '') {
  const text = String(analysisReport)
  const contractType = extractContractType(text)
  const terms = ['合同主体', '授权', '标的', '付款', '税费', '发票', '交付', '验收', '期限', '质量', '保密', '知识产权', '变更', '解除', '违约', '争议解决', '通知']
  return [contractType, ...terms.filter((term) => text.includes(term)).slice(0, 8)].filter(Boolean).join(' OR ') || '合同'
}

export function extractContractType(text = '') {
  const knownTypes = ['劳动合同', '融资租赁合同', '建设工程合同', '知识产权合同', '物业服务合同', '仓储合同', '保管合同', '运输合同', '承揽合同', '保证合同', '借款合同', '委托合同', '中介合同', '赠与合同', '租赁合同', '买卖合同']
  return knownTypes.find((type) => text.includes(type)) || ''
}

export function close() { if (db) { db.close(); db = null } }

function lexicalClauseSearch(query, { contractType = '', limit = 20, excludeTemplateId } = {}) {
  const where = ['clause_fts MATCH ?']
  const params = [buildFtsQuery(query)]
  if (contractType) { where.push('t.contract_type = ?'); params.push(contractType) }
  if (excludeTemplateId) { where.push('t.id != ?'); params.push(excludeTemplateId) }
  try {
    return db.prepare(`SELECT c.id, c.template_id, c.clause_no, c.title, c.parent_title, c.content, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.reference_role, t.source_file, t.source_path, t.pair_key, rank
      FROM clause_fts JOIN template_clauses c ON clause_fts.rowid = c.id JOIN templates t ON t.id = c.template_id
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(...params, limit)
  } catch (error) {
    console.warn(`[knowledge-base] Clause FTS fallback: ${error.message}`)
    return db.prepare(`SELECT c.id, c.template_id, c.clause_no, c.title, c.parent_title, c.content, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.reference_role, t.source_file, t.source_path, t.pair_key
      FROM template_clauses c JOIN templates t ON t.id = c.template_id
      WHERE c.content LIKE ? ${contractType ? 'AND t.contract_type = ?' : ''} ${excludeTemplateId ? 'AND t.id != ?' : ''} LIMIT ?`)
      .all(`%${firstQueryTerm(query)}%`, ...(contractType ? [contractType] : []), ...(excludeTemplateId ? [excludeTemplateId] : []), limit)
  }
}

function lexicalRiskSearch(query, { contractType = '', limit = 20, excludeTemplateId } = {}) {
  const where = ['risk_rule_fts MATCH ?']
  const params = [buildFtsQuery(query)]
  if (contractType) { where.push('t.contract_type = ?'); params.push(contractType) }
  if (excludeTemplateId) { where.push('t.id != ?'); params.push(excludeTemplateId) }
  try {
    return db.prepare(`SELECT r.id, r.template_id, r.clause_id, r.category, r.severity, r.trigger_text, r.risk_text, r.recommendation, r.source_note,
      c.clause_no, c.title, c.parent_title, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.reference_role, t.source_file, t.source_path, t.pair_key, rank
      FROM risk_rule_fts JOIN risk_rules r ON risk_rule_fts.rowid = r.id
      JOIN templates t ON t.id = r.template_id LEFT JOIN template_clauses c ON c.id = r.clause_id
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(...params, limit)
  } catch (error) {
    console.warn(`[knowledge-base] Risk FTS fallback: ${error.message}`)
    return db.prepare(`SELECT r.id, r.template_id, r.clause_id, r.category, r.severity, r.trigger_text, r.risk_text, r.recommendation, r.source_note,
      c.clause_no, c.title, c.parent_title, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.reference_role, t.source_file, t.source_path, t.pair_key
      FROM risk_rules r JOIN templates t ON t.id = r.template_id LEFT JOIN template_clauses c ON c.id = r.clause_id
      WHERE (r.risk_text LIKE ? OR r.trigger_text LIKE ?) ${contractType ? 'AND t.contract_type = ?' : ''} ${excludeTemplateId ? 'AND t.id != ?' : ''} LIMIT ?`)
      .all(`%${firstQueryTerm(query)}%`, `%${firstQueryTerm(query)}%`, ...(contractType ? [contractType] : []), ...(excludeTemplateId ? [excludeTemplateId] : []), limit)
  }
}

function getEvidenceByIds(evidenceIds, { excludeTemplateId } = {}) {
  const clauses = []
  const risks = []
  for (const evidenceId of evidenceIds) {
    const [kind, rawId] = String(evidenceId).split(':')
    if (!Number.isInteger(Number(rawId))) continue
    if (kind === 'clause') clauses.push(Number(rawId))
    if (kind === 'risk') risks.push(Number(rawId))
  }
  const evidence = []
  if (clauses.length) {
    const rows = db.prepare(`SELECT c.id, c.template_id, c.clause_no, c.title, c.parent_title, c.content, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.reference_role, t.source_file, t.source_path, t.pair_key
      FROM template_clauses c JOIN templates t ON t.id=c.template_id WHERE c.id IN (${clauses.map(() => '?').join(',')})${excludeTemplateId ? ' AND t.id != ?' : ''}`)
      .all(...clauses, ...(excludeTemplateId ? [excludeTemplateId] : []))
    evidence.push(...rows.map(clauseRowToEvidence))
  }
  if (risks.length) {
    const rows = db.prepare(`SELECT r.id, r.template_id, r.clause_id, r.category, r.severity, r.trigger_text, r.risk_text, r.recommendation, r.source_note,
      c.clause_no, c.title, c.parent_title, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.reference_role, t.source_file, t.source_path, t.pair_key
      FROM risk_rules r JOIN templates t ON t.id=r.template_id LEFT JOIN template_clauses c ON c.id=r.clause_id
      WHERE r.id IN (${risks.map(() => '?').join(',')})${excludeTemplateId ? ' AND t.id != ?' : ''}`)
      .all(...risks, ...(excludeTemplateId ? [excludeTemplateId] : []))
    evidence.push(...rows.map(riskRowToEvidence))
  }
  return evidence
}

function clauseRowToEvidence(row) {
  return {
    evidenceId: `clause:${row.id}`, kind: 'clause', templateId: row.template_id, contractType: row.contract_type,
    referenceRole: row.reference_role, sourceName: row.name, sourceFile: row.source_file, sourcePath: row.source_path,
    pairKey: row.pair_key, clauseNo: row.clause_no || '', title: row.title || '', parentTitle: row.parent_title || '',
    text: row.content || '', startOffset: row.start_offset, endOffset: row.end_offset, category: '', severity: '', retrievalScore: 0, topicLabels: []
  }
}

function riskRowToEvidence(row) {
  return {
    evidenceId: `risk:${row.id}`, kind: 'risk_rule', templateId: row.template_id, contractType: row.contract_type,
    referenceRole: row.reference_role, sourceName: row.name, sourceFile: row.source_file, sourcePath: row.source_path,
    pairKey: row.pair_key, clauseNo: row.clause_no || '', title: row.title || row.category || '', parentTitle: row.parent_title || '',
    sourceNote: row.source_note || '', text: `触发条款：${row.trigger_text || '未提取'}\n风险说明：${row.risk_text || row.source_note || '未提取'}\n修订方向：${row.recommendation || '请结合交易事实明确约定。'}`,
    startOffset: row.start_offset, endOffset: row.end_offset, category: row.category || '', severity: row.severity || '中', retrievalScore: 0, topicLabels: []
  }
}

function mergeCandidate(candidates, evidence, topic, score) {
  const existing = candidates.get(evidence.evidenceId)
  if (existing) {
    existing.retrievalScore += score
    if (!existing.topicLabels.includes(topic.label)) existing.topicLabels.push(topic.label)
    return
  }
  candidates.set(evidence.evidenceId, { ...evidence, retrievalScore: score, topicLabels: [topic.label] })
}

function diversifyEvidence(results, limit) {
  const selected = []
  const perDocument = new Map()
  const add = (item) => {
    if (!item || selected.some((selectedItem) => selectedItem.evidenceId === item.evidenceId)) return
    if ((perDocument.get(item.templateId) || 0) >= 2) return
    selected.push(item)
    perDocument.set(item.templateId, (perDocument.get(item.templateId) || 0) + 1)
  }
  add(results.find((item) => item.referenceRole === 'excellent_template' && item.kind === 'clause'))
  add(results.find((item) => item.referenceRole === 'annotated_case' && item.kind === 'risk_rule'))
  // 全合同审查不是单一问答。每个审查主题至少尝试保留一条风险规则，防止
  // 付款类高频词把验收、解除、争议等主题挤出最终上下文。
  const topicLabels = [...new Set(results.flatMap((item) => item.topicLabels || []))]
  for (const topicLabel of topicLabels) {
    if (selected.length >= limit) break
    add(results.find((item) => item.kind === 'risk_rule' && item.topicLabels?.includes(topicLabel)))
  }
  for (const item of results) {
    if (selected.length >= limit) break
    add(item)
  }
  return selected.slice(0, limit)
}

function toLegacyTemplate(item) {
  return {
    id: item.id, name: item.name, contract_type: item.contract_type, industry: item.industry,
    description: item.description, reference_role: item.reference_role, review_notes: item.review_notes,
    source_file: item.source_file, source_path: item.source_path, pair_key: item.pair_key,
    content: item.content || ''
  }
}

function buildFtsQuery(query) {
  return String(query || '合同').trim().split(/\s*OR\s*|\s+/).filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ')
}

function firstQueryTerm(query) {
  return String(query || '合同').split(/\s*OR\s*|\s+/).find(Boolean) || '合同'
}

function stripAnnotations(text) {
  return String(text || '')
    .replace(/【[^】]*(?:风险批注|风险分析|批注)[^】]*】/g, '')
    .replace(/（(?:风险批注|风险分析)[^）]*）/g, '')
    .replace(/\n{3,}/g, '\n\n').trim()
}
