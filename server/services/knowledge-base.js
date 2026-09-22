import Database from 'better-sqlite3'
import { readFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { splitIntoClauses, extractRiskRules, inferRiskCategory } from './knowledge-processor.js'
import { rerankEvidence, getRerankerStatus } from './evidence-reranker.js'
import { getVectorStatus, searchVectorEvidence, noteVectorUnavailable } from './vector-store.js'
import { toIndexText, toQueryTerm } from './chinese-tokenizer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = join(__dirname, '..', 'knowledge-base', 'templates.db')
const DEFAULT_TEMPLATES_DIR = join(__dirname, '..', 'knowledge-base', 'templates')
const DEFAULT_INDEX_PATH = join(__dirname, '..', 'knowledge-base', 'index.json')
const DEFAULT_SUB_TYPES_PATH = join(__dirname, '..', 'knowledge-base', 'sub-types.json')
const RRF_K = 60
/**
 * 检索参数的唯一来源。此前它们以字面量散落在实现与两处生产调用里（评测端还用了另一个值），
 * 提为具名常量后报告可如实记录、离线评测能按不同取值复算，生产调用也不再各写各的。
 * - DEFAULT_EVIDENCE_LIMIT：一次检索最终交付给审查 Agent 的证据条数（生产生效值）
 * - EVIDENCE_CANDIDATE_LIMIT：RRF 融合后截断的候选池上限
 * - EVIDENCE_PER_DOCUMENT_CAP：每份模板最多贡献几条证据（2 → 3：原值下同一份文档霸屏之外，
 *   还把按主题保底出来的名额又挤掉，实测 cap 是比 limit 更靠前的约束）
 */
export const DEFAULT_EVIDENCE_LIMIT = 12
export const EVIDENCE_CANDIDATE_LIMIT = 48
// 每文档证据上限。2026-09-22 两个会话的参数矩阵一致：cap=5（limit=12）召回 0.6563（+6.1pp）、
// 精度 0.7207（+0.1pp）、提示词只多 573 字符；cap≥8 后精度开始掉、cap=20 饱和。
// 召回目标更稀缺（85% 差 22pp、精度 80% 差 7pp）⇒ 取召回更高的 5。
export const EVIDENCE_PER_DOCUMENT_CAP = 5

/**
 * 模板子类型目录（`knowledge-base/sub-types.json`）。
 * 存在的理由：同一个 16 类里可能装着风险点完全不同的合同（委托合同下有装修委托与软件委托开发），
 * 只按 contract_type 过滤会让不对口的证据排在最前面。子类型只作**检索的过滤键**，不改变对外口径。
 * 目录是数据文件 ⇒ 新增子类型不需要改代码（mentor 明确要求「后面直接添加即可」）。
 */
let subTypeCatalog = null
function loadSubTypeCatalog() {
  if (subTypeCatalog) return subTypeCatalog
  try {
    subTypeCatalog = JSON.parse(readFileSync(DEFAULT_SUB_TYPES_PATH, 'utf8'))
  } catch (error) {
    console.warn(`[knowledge-base] sub-types.json 不可用，子类型过滤整体停用：${error.message}`)
    subTypeCatalog = { types: {}, documents: {} }
  }
  return subTypeCatalog
}

/** 按素材路径查子类型；查不到返回空串（＝退化为只按 contract_type 过滤） */
export function resolveSubType(sourceFile) {
  return loadSubTypeCatalog().documents?.[sourceFile] || ''
}

/** 该主类型是否启用子类型硬过滤（数据文件里的开关，启停零代码改动） */
export function isSubTypeFilterEnabled(contractType) {
  return Boolean(loadSubTypeCatalog().types?.[contractType]?.filterEnabled)
}

/**
 * 供 Agent 1 提示词使用的类型目录：
 * - contractTypes：库内实际存在的主类型（让模型从真实可检索的类型里选，而不是自己造名字）
 * - subTypes：只列**已启用过滤**的主类型及其子类型 —— 没启用过滤的子类型判了也没有消费者，
 *   出现在提示词里只会分散注意力
 */
export function getTypeCatalogForPrompt() {
  if (!db) initialize()
  const contractTypes = db.prepare("SELECT DISTINCT contract_type AS type FROM templates WHERE contract_type <> '' ORDER BY contract_type").all().map((row) => row.type)
  const types = loadSubTypeCatalog().types || {}
  const subTypes = Object.entries(types)
    .filter(([, config]) => config.filterEnabled)
    .map(([contractType, config]) => ({ contractType, labels: (config.subTypes || []).map((item) => item.label) }))
  return { contractTypes, subTypes }
}

/** 某主类型下的全部子类型标签（按声明顺序） */
export function listSubTypeLabels(contractType) {
  return (loadSubTypeCatalog().types?.[contractType]?.subTypes || []).map((item) => item.label)
}

/**
 * 某子类型的特征词。供 `review-plan` 做「正文是否真的支持这个子类型」的复核 ——
 * 那是唯一能挡住「子类型在清单内、但 Agent 1 判错了」的防线。
 * 需要合同正文 ⇒ 只能在 review-plan 层做（检索侧拿不到正文）。
 */
export function getSubTypeFeatures(contractType, subType) {
  const item = (loadSubTypeCatalog().types?.[contractType]?.subTypes || []).find((entry) => entry.label === subType)
  return item?.features || []
}

let db = null

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
      sub_type TEXT DEFAULT '',
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
      category TEXT DEFAULT '',
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
    source_path: "TEXT DEFAULT ''", pair_key: "TEXT DEFAULT ''", content_hash: "TEXT DEFAULT ''",
    // 子类型：同 16 类内的业务形态细分，只作检索过滤键，见 sub-types.json
    sub_type: "TEXT DEFAULT ''"
  })) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE templates ADD COLUMN ${column} ${definition}`)
  }
  // template_clauses.category 是后加的列：正向模板条款此前没有类别，进不了类别覆盖统计。
  const clauseColumns = db.prepare('PRAGMA table_info(template_clauses)').all().map((column) => column.name)
  if (!clauseColumns.includes('category')) db.exec("ALTER TABLE template_clauses ADD COLUMN category TEXT DEFAULT ''")
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
      contentHash: item.content_hash, subType: item.sub_type, content
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
  sourceFile, sourcePath, pairKey, contentHash, content, clauses, riskRules, subType
}) {
  if (!db) initialize()
  const resolvedClauses = clauses?.length ? clauses : splitIntoClauses(content)
  const resolvedRules = riskRules?.length ? riskRules : referenceRole === 'annotated_case'
    ? extractRiskRules(content, resolvedClauses) : []
  // 子类型优先取调用方传入值，否则按素材路径查 sub-types.json（查不到就是空串）
  const resolvedSubType = subType || resolveSubType(sourceFile || '')

  return db.transaction(() => {
    const document = db.prepare(`INSERT INTO templates
      (name, contract_type, industry, description, reference_role, review_notes, source_file, source_path, pair_key, content_hash, sub_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, contractType || '', industry || '', description || '', referenceRole || 'reference', reviewNotes || '', sourceFile || '', sourcePath || '', pairKey || '', contentHash || '', resolvedSubType)
    const templateId = Number(document.lastInsertRowid)
    db.prepare('INSERT INTO templates_fts (rowid, name, contract_type, industry, description, content) VALUES (?, ?, ?, ?, ?, ?)')
      .run(templateId, toIndexText(name), toIndexText(contractType), toIndexText(industry), toIndexText(description), toIndexText(content))

    const clauseIds = new Map()
    const insertClause = db.prepare(`INSERT INTO template_clauses
      (template_id, clause_key, clause_no, title, parent_title, content, category, start_offset, end_offset, chunk_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertClauseFts = db.prepare('INSERT INTO clause_fts (rowid, contract_type, reference_role, heading, content) VALUES (?, ?, ?, ?, ?)')
    for (const clause of resolvedClauses) {
      const row = insertClause.run(templateId, clause.clauseKey, clause.clauseNo || '', clause.title || '', clause.parentTitle || '', clause.content || '', clause.category || '', clause.startOffset || 0, clause.endOffset || 0, clause.chunkIndex || 0)
      const clauseId = Number(row.lastInsertRowid)
      clauseIds.set(clause.clauseKey, clauseId)
      insertClauseFts.run(clauseId, toIndexText(contractType), toIndexText(referenceRole), toIndexText(`${clause.clauseNo || ''} ${clause.title || ''} ${clause.parentTitle || ''}`.trim()), toIndexText(clause.content || ''))
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
      insertRuleFts.run(ruleId, toIndexText(contractType), toIndexText(rule.category), toIndexText(rule.severity), toIndexText(rule.triggerText), toIndexText(rule.riskText), toIndexText(rule.recommendation))
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
 */
export async function searchEvidence(reviewPlan, options = {}) {
  if (!db) initialize()
  // limit / perDocumentCap / onCandidates 都可被调用方覆盖：
  // 既有调用方不传时取默认值，取值与行为与改动前完全一致。
  const {
    limit = DEFAULT_EVIDENCE_LIMIT, candidateLimit = EVIDENCE_CANDIDATE_LIMIT, excludeTemplateId,
    perDocumentCap = EVIDENCE_PER_DOCUMENT_CAP, onCandidates
  } = options
  const topics = reviewPlan?.topics?.length ? reviewPlan.topics : [{ id: 'topic-1', label: '通用合同审查', query: '合同' }]
  // 回退值「通用商业合同」并非数据库真实类型，参与 SQL 过滤会把全部模板筛为 0 条。
  // 未知类型时按空串处理，退化为跨类型召回，确保仍有证据可用。
  const rawType = reviewPlan?.contractType || ''
  const contractType = rawType && rawType !== '通用商业合同' ? rawType : ''
  // 子类型（可选）：只作过滤键；未通过三道校验时降级为只按 contract_type 过滤并留痕。
  const subType = resolveActiveSubType(contractType, options.subType, excludeTemplateId)
  const candidates = new Map()

  for (const topic of topics) {
    // 风险规则索引包含规范化的风险类别；把主题标签一并检索可避免原条款措辞
    // 与风险规则关键词不同而漏召回，例如“价税、付款与发票”。
    const lexicalQuery = [topic.label, topic.query].filter(Boolean).join(' OR ')
    const clauseRows = lexicalClauseSearch(lexicalQuery, { contractType, subType, limit: 24, excludeTemplateId })
    clauseRows.forEach((row, index) => mergeCandidate(candidates, clauseRowToEvidence(row), topic, 1 / (RRF_K + index + 1)))
    const riskRows = lexicalRiskSearch(lexicalQuery, { contractType, subType, limit: 24, excludeTemplateId })
    riskRows.forEach((row, index) => mergeCandidate(candidates, riskRowToEvidence(row), topic, 1 / (RRF_K + index + 1)))
  }

  const vectorStatus = getVectorStatus()
  if (vectorStatus.enabled) {
    try {
      const vectorHits = await searchVectorEvidence(topics, { limit: 24, contractType, subType })
      const vectorEvidence = getEvidenceByIds(vectorHits.map((hit) => hit.evidenceId), { excludeTemplateId })
      vectorEvidence.forEach((evidence, index) => {
        const vectorHit = vectorHits.find((hit) => hit.evidenceId === evidence.evidenceId)
        mergeCandidate(candidates, evidence, { id: vectorHit?.topicId || 'vector', label: vectorHit?.topicLabel || '语义匹配' }, 1 / (RRF_K + index + 1))
      })
    } catch (error) {
      // 向量已配置但请求失败（网络/服务挂了）—— 这不属于"没配置"，必须单独留痕：
      // 否则评测里"应可用却悄悄降级"，指标会无声地变成纯词法口径
      noteVectorUnavailable('request-failed')
      console.warn(`[knowledge-base] Vector retrieval skipped: ${error.message}`)
    }
  }

  // 同触发折叠：同一段条款被多条批注重复抽取时，折叠为 severity 最高的一条，
  // 并继承组内最高融合分（重复批注 = 该风险被强调过 ⇒ 提升排名而非占多个名额）
  collapseDuplicateTriggers(candidates)
  const fused = [...candidates.values()].sort((a, b) => b.retrievalScore - a.retrievalScore).slice(0, candidateLimit)
  const reranked = await rerankEvidence({ reviewPlan, candidates: fused })
  // 只读观测钩子：把「交付截断之前」的候选池交给调用方，用于离线评测把
  // 「检索质量」与「交付质量」分开度量。不传时不改变返回值，也不改变任何行为。
  if (typeof onCandidates === 'function') onCandidates(reranked)
  return diversifyEvidence(reranked, {
    limit,
    perDocumentCap,
    // 保底的是「审查计划里列出的主题」，而不是「候选里恰好出现过的标签」——后者会漏掉
    // 一个主题都没召回上来的情况，而那正是最需要保底的。
    topicLabels: topics.map((topic) => topic.label)
  })
}

/**
 * 同触发条款折叠：同一段条款被多条批注覆盖时，抽取逻辑会产出多条重复规则
 * （实测 53 组「同 trigger 同文档重复」，最多的 4 条；类别/严重度不一致大多源于此——
 *  不是标注标错，是同一处风险被不同批注从不同视角记了多次）。
 *
 * 危害：
 *  - 在 candidateLimit 截断前占名额，把不重复的证据挤出候选池
 *  - 进入交付时「先到先得」，留下的可能不是信息最全的那条（severity 冲突由此漏进交付）
 *
 * 折叠规则：同 trigger 组内保留 severity 最高的一条（高 > 中 > 低，宁严勿松），
 * 并继承组内最高的融合分 —— **同一处风险被多次批注，本身说明它被强调过，
 * 应该体现为排名提升，而不是占多个名额**。
 */
function collapseDuplicateTriggers(candidates) {
  const severityRank = { 高: 3, 中: 2, 低: 1 }
  const byTrigger = new Map()
  for (const [id, item] of candidates) {
    if (item.kind !== 'risk_rule') continue
    const triggerKey = normalizedTrigger(item)
    if (!triggerKey) continue
    if (!byTrigger.has(triggerKey)) byTrigger.set(triggerKey, [])
    byTrigger.get(triggerKey).push({ id, item })
  }
  const removeIds = new Set()
  const scoreBoost = new Map()
  for (const [, group] of byTrigger) {
    if (group.length < 2) continue
    const best = [...group].sort((a, b) =>
      (severityRank[b.item.severity] || 0) - (severityRank[a.item.severity] || 0) ||
      b.item.retrievalScore - a.item.retrievalScore
    )[0]
    const topScore = Math.max(...group.map((entry) => entry.item.retrievalScore))
    for (const entry of group) {
      if (entry.id === best.id) continue
      removeIds.add(entry.id)
      scoreBoost.set(best.id, Math.max(scoreBoost.get(best.id) || 0, topScore))
    }
  }
  for (const id of removeIds) candidates.delete(id)
  for (const [id, score] of scoreBoost) {
    const kept = candidates.get(id)
    if (kept) kept.retrievalScore = Math.max(kept.retrievalScore || 0, score)
  }
  return candidates
}

export function listTemplates() {
  if (!db) initialize()
  return db.prepare(`SELECT id, name, contract_type, industry, description, reference_role, review_notes,
    source_file, source_path, pair_key, content_hash, sub_type, created_at FROM templates ORDER BY contract_type, name`).all()
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

/**
 * 「最低可用线」（mentor 2026-09-22 确认）：≥3 份范本 且 ≥1 个坏例 且 ≥30 条风险规则。
 *
 * 不够线的类型（保证/知产/赠与各 4 条规则、委托 5 条、物业/融资租赁各 6 条）拿出来的
 * 审查结果不可靠 —— 由调用方在**产品侧显式提示**，而不是闷头给一份看着正常的结果。
 */
const MIN_USABLE_TEMPLATES = 3
const MIN_USABLE_CASES = 1
const MIN_USABLE_RULES = 30

export function getTypeAvailability(contractType) {
  if (!db) initialize()
  if (!contractType) {
    return { contractType: '', templates: 0, cases: 0, rules: 0, meetsLine: false, shortfalls: ['未判定合同类型'] }
  }
  const templates = db.prepare('SELECT COUNT(*) AS n FROM templates WHERE contract_type = ?').get(contractType).n
  const cases = db.prepare("SELECT COUNT(*) AS n FROM templates WHERE contract_type = ? AND reference_role = 'annotated_case'").get(contractType).n
  const rules = db.prepare('SELECT COUNT(*) AS n FROM risk_rules r JOIN templates t ON t.id = r.template_id WHERE t.contract_type = ?').get(contractType).n
  const shortfalls = []
  if (templates < MIN_USABLE_TEMPLATES) shortfalls.push(`范本 ${templates}<${MIN_USABLE_TEMPLATES}`)
  if (cases < MIN_USABLE_CASES) shortfalls.push(`坏例 ${cases}<${MIN_USABLE_CASES}`)
  if (rules < MIN_USABLE_RULES) shortfalls.push(`风险规则 ${rules}<${MIN_USABLE_RULES}`)
  return { contractType, templates, cases, rules, meetsLine: shortfalls.length === 0, shortfalls }
}

export function listIndexableEvidence() {
  if (!db) initialize()
  const clauses = db.prepare(`SELECT 'clause:' || c.id AS evidence_id, 'clause' AS kind, c.id AS source_id,
    t.contract_type, t.sub_type, t.reference_role, t.pair_key, t.source_path, t.name, c.clause_no, c.title, c.parent_title, c.content
    FROM template_clauses c JOIN templates t ON t.id = c.template_id`).all()
  const rules = db.prepare(`SELECT 'risk:' || r.id AS evidence_id, 'risk_rule' AS kind, r.id AS source_id,
    t.contract_type, t.sub_type, t.reference_role, t.pair_key, t.source_path, t.name, COALESCE(c.clause_no, '') AS clause_no,
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

function lexicalClauseSearch(query, { contractType = '', limit = 20, excludeTemplateId, subType = '' } = {}) {
  const where = ['clause_fts MATCH ?']
  const params = [buildFtsQuery(query)]
  if (contractType) { where.push('t.contract_type = ?'); params.push(contractType) }
  if (subType) { where.push('t.sub_type = ?'); params.push(subType) }
  if (excludeTemplateId) { where.push('t.id != ?'); params.push(excludeTemplateId) }
  try {
    return db.prepare(`SELECT c.id, c.template_id, c.clause_no, c.title, c.parent_title, c.content, c.category, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.sub_type, t.reference_role, t.source_file, t.source_path, t.pair_key, rank
      FROM clause_fts JOIN template_clauses c ON clause_fts.rowid = c.id JOIN templates t ON t.id = c.template_id
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(...params, limit)
  } catch (error) {
    noteFtsFallback('Clause', error)
    const terms = fallbackLikeTerms(query)
    return db.prepare(`SELECT c.id, c.template_id, c.clause_no, c.title, c.parent_title, c.content, c.category, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.sub_type, t.reference_role, t.source_file, t.source_path, t.pair_key
      FROM template_clauses c JOIN templates t ON t.id = c.template_id
      WHERE (${terms.map(() => 'c.content LIKE ?').join(' OR ')}) ${contractType ? 'AND t.contract_type = ?' : ''} ${subType ? 'AND t.sub_type = ?' : ''} ${excludeTemplateId ? 'AND t.id != ?' : ''} LIMIT ?`)
      .all(...terms.map((term) => `%${term}%`), ...(contractType ? [contractType] : []), ...(subType ? [subType] : []), ...(excludeTemplateId ? [excludeTemplateId] : []), limit)
  }
}

function lexicalRiskSearch(query, { contractType = '', limit = 20, excludeTemplateId, subType = '' } = {}) {
  const where = ['risk_rule_fts MATCH ?']
  const params = [buildFtsQuery(query)]
  if (contractType) { where.push('t.contract_type = ?'); params.push(contractType) }
  if (subType) { where.push('t.sub_type = ?'); params.push(subType) }
  if (excludeTemplateId) { where.push('t.id != ?'); params.push(excludeTemplateId) }
  try {
    return db.prepare(`SELECT r.id, r.template_id, r.clause_id, r.category, r.severity, r.trigger_text, r.risk_text, r.recommendation, r.source_note,
      c.clause_no, c.title, c.parent_title, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.sub_type, t.reference_role, t.source_file, t.source_path, t.pair_key, rank
      FROM risk_rule_fts JOIN risk_rules r ON risk_rule_fts.rowid = r.id
      JOIN templates t ON t.id = r.template_id LEFT JOIN template_clauses c ON c.id = r.clause_id
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(...params, limit)
  } catch (error) {
    noteFtsFallback('Risk', error)
    const terms = fallbackLikeTerms(query)
    return db.prepare(`SELECT r.id, r.template_id, r.clause_id, r.category, r.severity, r.trigger_text, r.risk_text, r.recommendation, r.source_note,
      c.clause_no, c.title, c.parent_title, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.sub_type, t.reference_role, t.source_file, t.source_path, t.pair_key
      FROM risk_rules r JOIN templates t ON t.id = r.template_id LEFT JOIN template_clauses c ON c.id = r.clause_id
      WHERE (${terms.map(() => '(r.risk_text LIKE ? OR r.trigger_text LIKE ?)').join(' OR ')}) ${contractType ? 'AND t.contract_type = ?' : ''} ${subType ? 'AND t.sub_type = ?' : ''} ${excludeTemplateId ? 'AND t.id != ?' : ''} LIMIT ?`)
      .all(...terms.flatMap((term) => [`%${term}%`, `%${term}%`]), ...(contractType ? [contractType] : []), ...(subType ? [subType] : []), ...(excludeTemplateId ? [excludeTemplateId] : []), limit)
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
    const rows = db.prepare(`SELECT c.id, c.template_id, c.clause_no, c.title, c.parent_title, c.content, c.category, c.start_offset, c.end_offset,
      t.name, t.contract_type, t.sub_type, t.reference_role, t.source_file, t.source_path, t.pair_key
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
    subType: row.sub_type || '',
    referenceRole: row.reference_role, sourceName: row.name, sourceFile: row.source_file, sourcePath: row.source_path,
    pairKey: row.pair_key, clauseNo: row.clause_no || '', title: row.title || '', parentTitle: row.parent_title || '',
    text: row.content || '', startOffset: row.start_offset, endOffset: row.end_offset, category: row.category || '', severity: '', retrievalScore: 0, topicLabels: []
  }
}

function riskRowToEvidence(row) {
  return {
    evidenceId: `risk:${row.id}`, kind: 'risk_rule', templateId: row.template_id, contractType: row.contract_type,
    subType: row.sub_type || '',
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

/**
 * 交付挑选。相对旧实现的三处变化（对应第二阶段「证据选择丢覆盖」问题）：
 * 1) 保底的是「审查计划里的每个主题」，而不是「候选里恰好出现过的 topicLabels」
 * 2) 同一份文档的上限由 2 放宽到可配（默认 3）
 * 3) 同一触发条款的重复规则只留一条 —— 跨文档同质的规则会把类别覆盖算虚高
 */
export function diversifyEvidence(results, options = {}) {
  const { limit = DEFAULT_EVIDENCE_LIMIT, perDocumentCap = EVIDENCE_PER_DOCUMENT_CAP, topicLabels = [] } = options
  const selected = []
  const perDocument = new Map()
  const seenTrigger = new Set()
  const add = (item) => {
    if (!item) return false
    if (selected.length >= limit) return false
    if (selected.some((picked) => picked.evidenceId === item.evidenceId)) return false
    if ((perDocument.get(item.templateId) || 0) >= perDocumentCap) return false
    const triggerKey = item.kind === 'risk_rule' ? normalizedTrigger(item) : ''
    if (triggerKey && seenTrigger.has(triggerKey)) return false
    selected.push(item)
    perDocument.set(item.templateId, (perDocument.get(item.templateId) || 0) + 1)
    if (triggerKey) seenTrigger.add(triggerKey)
    return true
  }
  // ① 正向 / 负向各保底一条（评测的 positive/negative coverage 判据依赖它们）
  add(results.find((item) => item.referenceRole === 'excellent_template' && item.kind === 'clause'))
  add(results.find((item) => item.referenceRole === 'annotated_case' && item.kind === 'risk_rule'))
  // ② 计划里的每个主题保底一条 risk_rule（旧实现只处理「候选里出现的 label」，会漏主题）
  const planned = topicLabels.length ? topicLabels : [...new Set(results.flatMap((item) => item.topicLabels || []))]
  for (const label of planned) {
    if (selected.length >= limit) break
    add(results.find((item) => item.kind === 'risk_rule' && item.topicLabels?.includes(label)))
  }
  // ③ 剩余名额按分数序补
  for (const item of results) {
    if (selected.length >= limit) break
    add(item)
  }
  return selected.slice(0, limit)
}

/** 风险规则的 text 形如「触发条款：…\n风险说明：…\n修订方向：…」，取首行即触发条款本身 */
function normalizedTrigger(item) {
  return String(item.text || '').split('\n')[0].replace(/\s+/g, '').slice(0, 200)
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
    .map((term) => toQueryTerm(term).replace(/"/g, ''))
    .filter(Boolean)
    // 中文词展开后是「空格分隔的 bigram 序列」，用引号包起来即 FTS5 短语查询（要求相邻且同序）
    .map((term) => `"${term}"`)
    .join(' OR ')
}

/**
 * FTS 异常时的 LIKE 回退此前只取「第一个词」，而调用方传的是 `topic.label OR terms…`，
 * 于是拿到的是主题标签（如「价税、付款与发票」），`LIKE '%价税、付款与发票%'` 几乎不可能
 * 逐字命中 ⇒ 该主题静默空召回。改为把全部 term 取出来做 OR。
 */
function fallbackLikeTerms(query) {
  const terms = String(query || '合同').split(/\s*OR\s*|\s+/).map((term) => term.trim()).filter(Boolean)
  // 全空时不能拼出 `WHERE ()`，退化为最宽泛的词也强过抛 SQL 语法错误
  return terms.length ? terms : ['合同']
}

/** LIKE 回退是异常路径：它一旦触发说明 FTS 没能用，必须留痕。 */
let ftsFallbackCount = 0
export function getFtsFallbackCount() {
  return ftsFallbackCount
}

/**
 * 子类型过滤的可观测计数（不刷日志，供评测与排障读取）。
 * - applied            实际按子类型过滤了
 * - downgraded         请求了子类型但被降级（类型未开开关 / 库内该子类型没有任何素材）
 * 降级一定要可见 —— 「静默不过滤」正是串味的来源。
 */
const subTypeFilterStats = { applied: 0, downgraded: 0, downgradeReasons: {} }
export function getSubTypeFilterStats() {
  return { ...subTypeFilterStats, downgradeReasons: { ...subTypeFilterStats.downgradeReasons } }
}
export function resetSubTypeFilterStats() {
  subTypeFilterStats.applied = 0
  subTypeFilterStats.downgraded = 0
  subTypeFilterStats.downgradeReasons = {}
}
function noteSubTypeDowngrade(reason) {
  subTypeFilterStats.downgraded += 1
  subTypeFilterStats.downgradeReasons[reason] = (subTypeFilterStats.downgradeReasons[reason] || 0) + 1
}

/**
 * 库里该主类型下、**除自己之外**是否还存在这个子类型的素材。
 * 必须排除自己：某子类型只有 1 份文档时，那份往往就是用例/本次审查的文档本身
 * （检索会把它排除），此时按子类型过滤只会拿到一个空池 —— 实测「一般委托」正是这种情况。
 */
function subTypeHasDocuments(contractType, subType, excludeTemplateId) {
  const sql = `SELECT COUNT(*) AS count FROM templates WHERE contract_type = ? AND sub_type = ?${excludeTemplateId ? ' AND id != ?' : ''}`
  const args = excludeTemplateId ? [contractType, subType, excludeTemplateId] : [contractType, subType]
  return (db.prepare(sql).get(...args)?.count || 0) > 0
}

/** 该子类型名是否在该主类型的清单里（模型可能给出清单外的名字，宁可降级也不能拿它当过滤键） */
function isDeclaredSubType(contractType, subType) {
  const labels = (loadSubTypeCatalog().types?.[contractType]?.subTypes || []).map((item) => item.label)
  return labels.includes(subType)
}

/**
 * 子类型硬过滤的三道校验：类型未知 / 该类型未开开关 / 子类型不在清单内 / 库内除自己外没有该子类型素材
 * ⇒ 一律降级为按主类型过滤，并把降级原因计数。
 * **判对了最干净、判错了池子完全不对口**，所以宁可不启用也不能用错的键；
 * 反过来，池子为空（一条参考都没有）比"有部分不对口的参考"更糟，所以空池也要降级。
 */
function resolveActiveSubType(contractType, requestedSubType, excludeTemplateId) {
  const requested = String(requestedSubType || '').trim()
  if (!requested) return ''
  if (!contractType) { noteSubTypeDowngrade('no-contract-type'); return '' }
  if (!isSubTypeFilterEnabled(contractType)) { noteSubTypeDowngrade('filter-disabled'); return '' }
  if (!isDeclaredSubType(contractType, requested)) { noteSubTypeDowngrade('unknown-sub-type'); return '' }
  if (!subTypeHasDocuments(contractType, requested, excludeTemplateId)) { noteSubTypeDowngrade('no-other-documents'); return '' }
  subTypeFilterStats.applied += 1
  return requested
}

function noteFtsFallback(scope, error) {
  ftsFallbackCount += 1
  console.warn(`[knowledge-base] ${scope} FTS 不可用，已退化为 LIKE 逐词匹配（累计 ${ftsFallbackCount} 次）：${error.message}`)
}

function stripAnnotations(text) {
  return String(text || '')
    .replace(/【[^】]*(?:风险批注|风险分析|批注)[^】]*】/g, '')
    .replace(/（(?:风险批注|风险分析)[^）]*）/g, '')
    .replace(/\n{3,}/g, '\n\n').trim()
}
