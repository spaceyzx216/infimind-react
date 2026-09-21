/**
 * 法规白名单 + 案例库（用工咨询专用）。
 *
 * 设计原则（对应 docs/用工咨询功能方案.md 第二节）：
 *   不在白名单内的法规，一律标记为"未收录、需人工核实"，不交由模型凭记忆判断。
 *   这把风险从"模型判断法规是否有效"（不可控）转移到"白名单覆盖度"（可度量、可审计）。
 *
 * 与既有合同知识库（templates.db）完全独立，互不影响。
 *
 * ⚠️ 数据维护责任：seedLawWhitelist() 写入的是**初始种子数据**。
 *    其中 review_status='verified' 的条目已通过公开渠道核对；
 *    review_status='pending' 的条目为广泛引用的通行版本，**上线前必须由运营逐条核对**
 *    （核对清单见 npm run verify:laws）。核对后请更新 review_status / verified_at / verified_by。
 */
import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { toIndexText, buildFtsQuery, extractQueryTerms, collectTermsFromCases } from './cjk-tokenizer.js'
import { LABOR_CASES_SEED } from '../knowledge-base/labor-cases-seed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = join(__dirname, '..', 'knowledge-base', 'labor.db')
const CASE_LIMIT = 6

let db = null
let caseTermCache = null

export function initialize(dbPath = DEFAULT_DB_PATH) {
  if (db) return db
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS law_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      law_name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      version_label TEXT DEFAULT '',
      doc_number TEXT DEFAULT '',
      issuing_body TEXT DEFAULT '',
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      status TEXT DEFAULT 'effective',
      superseded_by TEXT DEFAULT '',
      repeal_basis TEXT DEFAULT '',
      review_status TEXT DEFAULT 'pending',
      verified_at TEXT,
      verified_by TEXT DEFAULT '',
      source_url TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS labor_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      case_no TEXT DEFAULT '',
      court TEXT DEFAULT '',
      region TEXT DEFAULT '',
      case_type TEXT DEFAULT '典型案例',
      judged_at TEXT,
      published_at TEXT,
      batch TEXT DEFAULT '',
      dispute_focus TEXT DEFAULT '',
      facts TEXT DEFAULT '',
      holding TEXT DEFAULT '',
      result TEXT DEFAULT '',
      legal_basis TEXT DEFAULT '',
      source TEXT DEFAULT '',
      source_url TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS labor_case_fts USING fts5(
      title, dispute_focus, holding, facts, legal_basis, tokenize='unicode61'
    );

    CREATE INDEX IF NOT EXISTS idx_law_status ON law_whitelist(status, effective_from, effective_to);
    CREATE INDEX IF NOT EXISTS idx_case_focus ON labor_cases(dispute_focus);
  `)
  return db
}

const normalizeLawName = (value) => String(value || '')
  .replace(/^《|》$/g, '')
  .replace(/[（(](?:19|20)\d{2}[^）)]*[）)]/g, '')
  .replace(/\s+/g, '')
  .trim()

/** 把一行法规转为对外结构，并把别名 JSON 解析出来。 */
const mapLaw = (row) => row ? ({
  id: row.id,
  title: row.law_name,
  aliases: (() => { try { return JSON.parse(row.aliases || '[]') } catch { return [] } })(),
  versionLabel: row.version_label || '',
  docNumber: row.doc_number || '',
  issuingBody: row.issuing_body || '',
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to || null,
  status: row.status || 'effective',
  supersededBy: row.superseded_by || '',
  repealBasis: row.repeal_basis || '',
  reviewStatus: row.review_status || 'pending',
  verifiedAt: row.verified_at || null,
  verifiedBy: row.verified_by || '',
  sourceUrl: row.source_url || '',
  note: row.note || ''
}) : null

/**
 * 供提示词注入的法规时效基准：默认只给"现行有效"的条目。
 * 同时给出少量已废止条目作为反例，帮助模型避免引用失效法规。
 */
export function listLawsForBaseline({ includeRepealed = true, today = new Date() } = {}) {
  if (!db) initialize()
  const todayStr = toDateString(today)
  const rows = db.prepare(`
    SELECT * FROM law_whitelist
    WHERE status IN ('effective', 'pending', 'superseded', 'repealed')
    ORDER BY CASE status WHEN 'effective' THEN 1 WHEN 'pending' THEN 2 WHEN 'superseded' THEN 3 ELSE 4 END,
             effective_from DESC
  `).all()
  return rows
    .filter((row) => row.status !== 'repealed' || (includeRepealed && row.effective_to >= '2021-01-01'))
    .map(mapLaw)
    .filter((law) => law.status !== 'pending' || law.effectiveFrom <= todayStr)
}

/** 按名称（含别名、去书名号、去版本括号）精确匹配法规。 */
export function findLaw(rawName) {
  if (!db) initialize()
  const target = normalizeLawName(rawName)
  if (!target) return null
  const rows = db.prepare('SELECT * FROM law_whitelist').all()
  // 1) 精确匹配
  for (const row of rows) {
    if (normalizeLawName(row.law_name) === target) return mapLaw(row)
  }
  // 2) 别名匹配
  for (const row of rows) {
    const law = mapLaw(row)
    if (law.aliases.some((alias) => normalizeLawName(alias) === target)) return law
  }
  // 3) 包含匹配（处理"劳动合同法实施条例"这类长名引用），取最长匹配避免误配
  let best = null
  for (const row of rows) {
    const normalized = normalizeLawName(row.law_name)
    if (!normalized) continue
    if (target.includes(normalized) || normalized.includes(target)) {
      if (!best || normalized.length > normalizeLawName(best.law_name).length) best = row
    }
  }
  return best ? mapLaw(best) : null
}

const toDateString = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

/**
 * 判定一部法规在给定时点的效力状态。
 * @returns {'verified'|'provisional'|'superseded'|'repealed'|'pending_effect'|'expired'}
 */
export function resolveLawStatus(law, today = new Date()) {
  const todayStr = toDateString(today)
  if (!law) return 'not_found'
  if (law.status === 'repealed') return 'repealed'
  if (law.status === 'superseded') return 'superseded'
  if (law.effectiveFrom && law.effectiveFrom > todayStr) return 'pending_effect'
  if (law.effectiveTo && law.effectiveTo <= todayStr) return 'expired'
  return law.reviewStatus === 'verified' ? 'verified' : 'provisional'
}

// ---------------------------------------------------------------------------
// 案例库
// ---------------------------------------------------------------------------

export function addCase(item) {
  if (!db) initialize()
  return db.transaction(() => {
    const result = db.prepare(`INSERT INTO labor_cases
      (title, case_no, court, region, case_type, judged_at, published_at, batch,
       dispute_focus, facts, holding, result, legal_basis, source, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.title || '劳动争议案例', item.caseNo || '', item.court || '', item.region || '',
      item.caseType || '典型案例', item.judgedAt || null, item.publishedAt || null, item.batch || '',
      item.disputeFocus || '', item.facts || '', item.holding || '', item.result || '',
      item.legalBasis || '', item.source || '', item.sourceUrl || ''
    )
    const id = Number(result.lastInsertRowid)
    db.prepare('INSERT INTO labor_case_fts (rowid, title, dispute_focus, holding, facts, legal_basis) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, toIndexText(item.title || ''), toIndexText(item.disputeFocus || ''),
        toIndexText(item.holding || ''), toIndexText(item.facts || ''), toIndexText(item.legalBasis || ''))
    caseTermCache = null // 新增案例后重建检索词表
    return id
  })()
}

const mapCase = (row) => ({
  id: row.id,
  title: row.title,
  caseNo: row.case_no || '',
  court: row.court || '',
  region: row.region || '',
  caseType: row.case_type || '典型案例',
  judgedAt: row.judged_at || '',
  batch: row.batch || '',
  disputeFocus: row.dispute_focus || '',
  facts: row.facts || '',
  holding: row.holding || '',
  result: row.result || '',
  legalBasis: row.legal_basis || '',
  source: row.source || '',
  sourceUrl: row.source_url || ''
})

/**
 * 案例检索：FTS5（2-gram）+ 争议焦点精确补充，按"焦点命中数 → 案例类型"排序。
 * @param {string} query
 * @param {{ limit?: number, region?: string }} options
 */
export function searchCases(query, { limit = CASE_LIMIT, region = '' } = {}) {
  if (!db) initialize()
  // 用案例库自身的争议焦点标注扩充检索词表（缓存），提升中文术语命中率
  if (!caseTermCache) {
    caseTermCache = collectTermsFromCases(db.prepare('SELECT dispute_focus, title FROM labor_cases').all()
      .map((row) => ({ disputeFocus: row.dispute_focus, title: row.title })))
  }
  // 案例检索同样享受同义词扩展（字面优先，扩展补召回）
  const { primary, expanded } = extractQueryTerms(query, { limit: 14, extraTerms: caseTermCache })
  const keywords = [...new Set([...primary, ...expanded])]
  const hits = new Map()
  const ftsQuery = buildFtsQuery(keywords)
  if (ftsQuery) {
    try {
      const rows = db.prepare(`SELECT labor_cases.*, rank FROM labor_case_fts
        JOIN labor_cases ON labor_cases.id = labor_case_fts.rowid
        WHERE labor_case_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery, limit * 4)
      rows.forEach((row, index) => hits.set(row.id, { row, score: 1 / (60 + index + 1) + 0.5 }))
    } catch (error) {
      console.warn('[law-whitelist] 案例 FTS 检索回退:', error.message)
    }
  }
  // 补充：争议焦点/标题/裁判要点直接包含关键词（应对短词与专有名词）
  for (const keyword of keywords.slice(0, 8)) {
    if (keyword.length < 2) continue
    const rows = db.prepare(`SELECT * FROM labor_cases
      WHERE dispute_focus LIKE ? OR title LIKE ? OR holding LIKE ? LIMIT ?`)
      .all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, limit)
    for (const row of rows) {
      const existing = hits.get(row.id)
      if (existing) existing.score += 0.3
      else hits.set(row.id, { row, score: 0.3 })
    }
  }
  return [...hits.values()]
    .map((item) => {
      const mapped = mapCase(item.row)
      // 典型案例优先：它们本身就是官方裁审口径
      const typeBonus = mapped.caseType.includes('指导') ? 0.6 : mapped.caseType.includes('典型') ? 0.4 : 0
      const regionBonus = region && mapped.region && mapped.region.includes(region) ? 0.2 : 0
      return { ...mapped, score: item.score + typeBonus + regionBonus }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function listCases({ limit = 200 } = {}) {
  if (!db) initialize()
  return db.prepare('SELECT * FROM labor_cases ORDER BY COALESCE(published_at, judged_at, created_at) DESC LIMIT ?')
    .all(limit).map(mapCase)
}

// ---------------------------------------------------------------------------
// 法规维护
// ---------------------------------------------------------------------------

export function upsertLaw(law) {
  if (!db) initialize()
  const existing = db.prepare('SELECT id FROM law_whitelist WHERE law_name = ?').get(law.title)
  const payload = [
    law.aliases ? JSON.stringify(law.aliases) : '[]',
    law.versionLabel || '', law.docNumber || '', law.issuingBody || '',
    law.effectiveFrom, law.effectiveTo || null, law.status || 'effective',
    law.supersededBy || '', law.repealBasis || '',
    law.reviewStatus || 'pending', law.verifiedAt || null, law.verifiedBy || '',
    law.sourceUrl || '', law.note || ''
  ]
  if (existing) {
    db.prepare(`UPDATE law_whitelist SET aliases=?, version_label=?, doc_number=?, issuing_body=?,
      effective_from=?, effective_to=?, status=?, superseded_by=?, repeal_basis=?,
      review_status=?, verified_at=?, verified_by=?, source_url=?, note=? WHERE id=?`)
      .run(...payload, existing.id)
    return existing.id
  }
  const result = db.prepare(`INSERT INTO law_whitelist
    (law_name, aliases, version_label, doc_number, issuing_body, effective_from, effective_to,
     status, superseded_by, repeal_basis, review_status, verified_at, verified_by, source_url, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(law.title, ...payload)
  return Number(result.lastInsertRowid)
}

export function getLaborStatus() {
  if (!db) initialize()
  const laws = db.prepare('SELECT COUNT(*) AS c FROM law_whitelist').get().c
  const verified = db.prepare("SELECT COUNT(*) AS c FROM law_whitelist WHERE review_status = 'verified'").get().c
  const pendingReview = db.prepare("SELECT COUNT(*) AS c FROM law_whitelist WHERE review_status != 'verified'").get().c
  const effective = db.prepare("SELECT COUNT(*) AS c FROM law_whitelist WHERE status = 'effective'").get().c
  const cases = db.prepare('SELECT COUNT(*) AS c FROM labor_cases').get().c
  const byType = db.prepare('SELECT case_type AS caseType, COUNT(*) AS count FROM labor_cases GROUP BY case_type').all()
  return { laws, verifiedLaws: verified, pendingReviewLaws: pendingReview, effectiveLaws: effective, cases, casesByType: byType }
}

export function close() { if (db) { db.close(); db = null } caseTermCache = null }

/**
 * 暴露数据库连接，供同一 labor.db 内的其它模块（如 labor-kb.js 的风险问答库）建表与查询。
 * 两个模块共用同一个 WAL 连接，避免多连接写冲突。
 */
export function getDb() {
  if (!db) initialize()
  return db
}

// ---------------------------------------------------------------------------
// 法规白名单种子数据
// ---------------------------------------------------------------------------

/**
 * 种子数据。
 * review_status='verified'：本次已通过公开渠道核对（docs/用工咨询功能方案.md 附录）。
 * review_status='pending' ：通行版本，**上线前必须由运营逐条核对**。
 */
export const LAW_WHITELIST_SEED = [
  {
    title: '中华人民共和国劳动合同法',
    aliases: ['劳动合同法'],
    versionLabel: '2012年修正',
    issuingBody: '全国人民代表大会常务委员会',
    effectiveFrom: '2013-07-01',
    status: 'effective',
    reviewStatus: 'verified',
    verifiedBy: 'seed',
    sourceUrl: 'https://www.gov.cn/jrzg/2012-12/28/content_2301315.htm',
    note: '现行有效；不存在“2025年修订版”。第38条为劳动者单方解除情形。'
  },
  {
    title: '中华人民共和国劳动合同法实施条例',
    aliases: ['劳动合同法实施条例'],
    versionLabel: '国务院令第535号',
    issuingBody: '国务院',
    effectiveFrom: '2008-09-18',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '中华人民共和国劳动法',
    aliases: ['劳动法'],
    versionLabel: '2018年修正',
    issuingBody: '全国人民代表大会常务委员会',
    effectiveFrom: '1995-01-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '中华人民共和国劳动争议调解仲裁法',
    aliases: ['劳动争议调解仲裁法', '调解仲裁法'],
    versionLabel: '2007年公布',
    issuingBody: '全国人民代表大会常务委员会',
    effectiveFrom: '2008-05-01',
    status: 'effective',
    reviewStatus: 'pending',
    note: '第27条为仲裁时效（一年，自知道或应当知道权利被侵害之日起算；劳动报酬争议在关系存续期间不受一年限制）。'
  },
  {
    title: '中华人民共和国社会保险法',
    aliases: ['社会保险法'],
    versionLabel: '2018年修正',
    issuingBody: '全国人民代表大会常务委员会',
    effectiveFrom: '2011-07-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '工伤保险条例',
    aliases: ['工伤保险条例'],
    versionLabel: '2010年修订',
    docNumber: '国务院令第586号',
    issuingBody: '国务院',
    effectiveFrom: '2011-01-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '职工带薪年休假条例',
    aliases: ['带薪年休假条例', '年休假条例'],
    versionLabel: '国务院令第514号',
    docNumber: '国务院令第514号',
    issuingBody: '国务院',
    effectiveFrom: '2008-01-01',
    status: 'effective',
    reviewStatus: 'verified',
    verifiedBy: 'seed',
    sourceUrl: 'https://www.gov.cn/flfg/2007-12/16/content_835527.htm',
    note: '现行有效，从未废止；不存在“2019年版”。'
  },
  {
    title: '企业职工带薪年休假实施办法',
    aliases: ['年休假实施办法'],
    versionLabel: '人力资源和社会保障部令第1号',
    issuingBody: '人力资源和社会保障部',
    effectiveFrom: '2008-09-18',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '全国人民代表大会常务委员会关于实施渐进式延迟法定退休年龄的决定',
    aliases: ['渐进式延迟法定退休年龄的决定', '延迟退休决定', '渐进式延迟退休'],
    versionLabel: '2024年9月13日第十四届全国人大常委会第十一次会议通过',
    issuingBody: '全国人民代表大会常务委员会',
    effectiveFrom: '2025-01-01',
    status: 'effective',
    reviewStatus: 'verified',
    verifiedBy: 'seed',
    sourceUrl: 'https://www.gov.cn/yaowen/liebiao/202409/content_6974294.htm',
    note: '现行有效。男职工与原55周岁女职工每4个月延迟1个月，分别逐步至63/58周岁；原50周岁女职工每2个月延迟1个月，逐步至55周岁；最低缴费年限自2030-01-01起由15年逐步提高至20年；弹性提前/延迟退休最长各3年。'
  },
  {
    title: '女职工劳动保护特别规定',
    aliases: ['女职工劳动保护特别规定'],
    versionLabel: '国务院令第619号',
    issuingBody: '国务院',
    effectiveFrom: '2012-04-28',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '劳务派遣暂行规定',
    aliases: ['劳务派遣暂行规定'],
    versionLabel: '人力资源和社会保障部令第22号',
    issuingBody: '人力资源和社会保障部',
    effectiveFrom: '2014-03-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '工资支付暂行规定',
    aliases: ['工资支付暂行规定'],
    versionLabel: '劳部发〔1994〕489号',
    issuingBody: '劳动部',
    effectiveFrom: '1995-01-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '最低工资规定',
    aliases: ['最低工资规定'],
    versionLabel: '劳动和社会保障部令第21号',
    issuingBody: '劳动和社会保障部',
    effectiveFrom: '2004-03-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '集体合同规定',
    aliases: ['集体合同规定'],
    versionLabel: '劳动和社会保障部令第22号',
    issuingBody: '劳动和社会保障部',
    effectiveFrom: '2004-05-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '劳动人事争议仲裁办案规则',
    aliases: ['仲裁办案规则'],
    versionLabel: '人力资源和社会保障部令第33号',
    issuingBody: '人力资源和社会保障部',
    effectiveFrom: '2017-07-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    // 该条目来自真实使用中发现的缺口：模型引用后被判"未收录"，核实为真实法规后补录。
    // 这是白名单机制的正常维护闭环（引用被拒 → 记日志 → 补录核对）。
    title: '企业职工患病或非因工负伤医疗期规定',
    aliases: ['医疗期规定'],
    versionLabel: '劳部发〔1994〕479号',
    docNumber: '劳部发〔1994〕479号',
    issuingBody: '劳动部',
    effectiveFrom: '1995-01-01',
    status: 'effective',
    reviewStatus: 'pending',
    sourceUrl: 'https://www.gov.cn/zhengce/2022-08/31/content_5711269.htm',
    note: '医疗期为3个月至24个月，按实际工作年限与本单位工作年限确定；特殊疾病24个月内不能痊愈的，经批准可适当延长。'
  },
  {
    title: '最高人民法院关于审理劳动争议案件适用法律问题的解释（一）',
    aliases: ['劳动争议司法解释一', '劳动争议解释一'],
    versionLabel: '法释〔2020〕26号',
    issuingBody: '最高人民法院',
    effectiveFrom: '2021-01-01',
    status: 'effective',
    reviewStatus: 'pending'
  },
  {
    title: '中华人民共和国民法典',
    aliases: ['民法典'],
    versionLabel: '2020年通过',
    issuingBody: '全国人民代表大会',
    effectiveFrom: '2021-01-01',
    status: 'effective',
    reviewStatus: 'pending',
    note: '第1260条废止了包括《合同法》在内的九部法律。'
  },
  {
    // 反例：用于让模型明确"已废止法规不得作为现行依据引用"
    title: '中华人民共和国合同法',
    aliases: ['合同法'],
    versionLabel: '1999年通过',
    issuingBody: '全国人民代表大会',
    effectiveFrom: '1999-10-01',
    effectiveTo: '2021-01-01',
    status: 'repealed',
    supersededBy: '中华人民共和国民法典',
    repealBasis: '《中华人民共和国民法典》第1260条',
    reviewStatus: 'verified',
    verifiedBy: 'seed',
    note: '已废止，1999-10-01 至 2021-01-01 期间有效。劳动关系不适用合同法。'
  }
]

/**
 * 写入种子数据。已存在的同名法规不会覆盖（保护人工核对结果）。
 * @returns {{ inserted: number, skipped: number }}
 */
export function seedLawWhitelist() {
  if (!db) initialize()
  let inserted = 0
  let skipped = 0
  for (const law of LAW_WHITELIST_SEED) {
    const existing = db.prepare('SELECT id FROM law_whitelist WHERE law_name = ?').get(law.title)
    if (existing) { skipped += 1; continue }
    upsertLaw(law)
    inserted += 1
  }
  return { inserted, skipped }
}

/** 供运营核对的清单：列出所有尚未人工核对的条目。 */
export function listPendingReviewLaws() {
  if (!db) initialize()
  return db.prepare("SELECT * FROM law_whitelist WHERE review_status != 'verified' ORDER BY effective_from")
    .all().map(mapLaw)
}

/**
 * 写入典型案例种子数据（幂等：按 title 去重，已存在则跳过）。
 * 数据来源见 server/knowledge-base/labor-cases-seed.js。
 * @returns {{ inserted: number, skipped: number }}
 */
export function seedLaborCases(seed = LABOR_CASES_SEED) {
  if (!db) initialize()
  let inserted = 0
  let skipped = 0
  for (const item of seed) {
    const existing = db.prepare('SELECT id FROM labor_cases WHERE title = ?').get(item.title)
    if (existing) { skipped += 1; continue }
    addCase(item)
    inserted += 1
  }
  return { inserted, skipped }
}
