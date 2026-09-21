/**
 * 用工咨询知识库检索评测。
 *
 * 用法：
 *   node server/scripts/evaluate-labor-kb.js                 # 全部评测（不含 LLM 判定）
 *   node server/scripts/evaluate-labor-kb.js --sample 30     # 真实提问抽样打印，供人工核对
 *
 * 三类指标，含义不同，不可混为一谈：
 *
 *   ① 标题已知项检索 Recall@k / MRR
 *      用条目自身的标题当查询，看能否找回该条目。
 *      衡量的是**索引健康度**（分词是否可用、索引是否完整），是召回率的**上界**，
 *      因为标题词就字面存在于索引中，真实用户提问不会这么"标准"。
 *
 *   ② 内容片段已知项检索 Recall@k
 *      用答案正文里的片段（不含标题词）当查询。
 *      衡量内容侧是否可检索，比 ① 更接近真实使用。
 *
 *   ③ 无 2-gram 对照组
 *      用同一批数据建一个"修复前"的索引（unicode61 整词匹配），跑同样的查询。
 *      用于量化中文分词修复带来的提升——这是本项目知识库最关键的工程改动。
 *
 * ⚠️ 本脚本**不测量准确率（precision）**：那需要判断"检索到的条目是否真的回答了问题"，
 *    属于相关性判定，无法由字符串比对得出。准确率请用 `--sample` 输出人工核对，
 *    或配合 LLM 判定（见 docs 说明）。
 */
import Database from 'better-sqlite3'
import { toIndexText, toQueryTerm, buildFtsQuery, extractKeywords } from '../services/cjk-tokenizer.js'
import { initializeLaborKb, getLaborKbStatus } from '../services/labor-kb.js'
import { getDb, close } from '../services/law-whitelist.js'

const TOP_K = 10
const EVAL_DEPTHS = [1, 3, 5, 10]

/** 从正文里取一段有区分度的片段（尽量避开标题用词，避免"偷看答案"） */
function contentProbe(entry, minLength = 24) {
  const titleChars = new Set(String(entry.title || '').replace(/[\s，。、；：？！]/g, ''))
  const segments = String(entry.content || '')
    .split(/[\n。；]/)
    .map((line) => line.trim())
    .filter((line) => line.length >= minLength)
  // 优先选与标题用字重合最少的片段
  let best = ''
  let bestOverlap = Infinity
  for (const segment of segments.slice(0, 12)) {
    const overlap = [...segment].filter((ch) => titleChars.has(ch)).length / segment.length
    if (overlap < bestOverlap) { bestOverlap = overlap; best = segment }
  }
  return (best || String(entry.content || '').slice(0, 60)).slice(0, 60)
}

/** 在给定检索函数下，计算某个查询把目标条目排在第几位（找不到返回 -1） */
function rankOf(results, targetId) {
  const index = results.findIndex((item) => item.id === targetId)
  return index < 0 ? -1 : index + 1
}

/**
 * 判断探针是否"非主题"——法条引用、案号、纯程序性长句。
 * 这类文本在多条问答里重复出现，用来做"必须找回原条目"的评测并不公平。
 */
function isNonTopicalProbe(probe) {
  const text = String(probe || '')
  if (/[（(]\s*(?:19|20)\d{2}\s*[）)]/.test(text)) return true                        // 含案号
  if (/第[一二三四五六七八九十百零〇\d]+条/.test(text) && text.length >= 30) return true  // 法条引用
  if (/《[^》]{4,}》/.test(text) && text.length >= 30) return true                       // 法规名引用
  if (/^(如果|因此|所以|但是|由于|根据|按照|依据)/.test(text) && text.length >= 40) return true
  return false
}

function summarize(ranks, label) {
  const total = ranks.length
  const metrics = {}
  for (const k of EVAL_DEPTHS) {
    const hit = ranks.filter((rank) => rank > 0 && rank <= k).length
    metrics[`recall@${k}`] = hit / total
  }
  const reciprocal = ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / total
  const missed = ranks.filter((rank) => rank < 0).length
  return { label, total, metrics, mrr: reciprocal, missed }
}

function printSummary(result) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`
  console.log(`\n── ${result.label}（样本 ${result.total} 条）`)
  console.log(`   Recall@1  ${pct(result.metrics['recall@1'])}`)
  console.log(`   Recall@3  ${pct(result.metrics['recall@3'])}`)
  console.log(`   Recall@5  ${pct(result.metrics['recall@5'])}`)
  console.log(`   Recall@10 ${pct(result.metrics['recall@10'])}`)
  console.log(`   MRR       ${result.mrr.toFixed(4)}`)
  console.log(`   Top10 未命中 ${result.missed} 条（${pct(result.missed / result.total)}）`)
}

/**
 * 建立"修复前"对照索引：unicode61 + 整词精确匹配（不做 2-gram 展开）。
 * 仅用于对照，不参与线上检索。
 */
function buildLegacyIndex(entries) {
  const db = new Database(':memory:')
  db.exec("CREATE VIRTUAL TABLE legacy_fts USING fts5(title, content, tokenize='unicode61')")
  const insert = db.prepare('INSERT INTO legacy_fts(rowid, title, content) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const entry of entries) insert.run(entry.id, entry.title, entry.content)
  })()
  return db
}

function legacySearch(db, query, limit = TOP_K) {
  const keywords = extractKeywords(query, { limit: 14 })
  if (!keywords.length) return []
  // 修复前的查询构造：整词加引号做精确匹配（不做 bigram 展开）
  const ftsQuery = keywords.map((term) => `"${String(term).replace(/"/g, '')}"`).join(' OR ')
  try {
    return db.prepare('SELECT rowid AS id FROM legacy_fts WHERE legacy_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(ftsQuery, limit).map((row) => ({ id: row.id }))
  } catch {
    return []
  }
}

async function main() {
  const args = process.argv.slice(2)
  initializeLaborKb()
  const db = getDb()
  // 注意：必须取 chapter/section —— 宽松指标要按"同章同节"判定，
  // 早期版本漏取这两个字段，导致该指标恒为 0%。
  const entries = db.prepare('SELECT id, book, title, content, chapter, section FROM labor_kb_entries ORDER BY id').all()
  const status = getLaborKbStatus()

  console.log('='.repeat(72))
  console.log('用工咨询知识库检索评测')
  console.log('='.repeat(72))
  console.log(`语料：${status.entries} 条问答（${status.byBook.map((b) => `${b.book} ${b.count}`).join(' · ')}）`)
  console.log(`正文：${entries.reduce((sum, e) => sum + e.content.length, 0).toLocaleString()} 字`)
  console.log(`含裁判案号：${status.withCaseRefs} 条`)

  // 复用线上检索路径，保证评测与线上一致
  const { searchLaborKb } = await import('../services/labor-kb.js')
  const search = (query) => searchLaborKb(query, { limit: TOP_K })   // 异步混合检索

  // -------------------------------------------------------------------------
  // 混合检索每次约 700ms（含 embedding + rerank 两次外部调用）。
  // 全量 764 条标题查询需约 13 分钟，调参时用 --sample 采样即可。
  const SAMPLE = Number((args.includes('--sample') ? args[args.indexOf('--sample') + 1] : 0)) || 0
  const sampleOf = (list) => {
    if (!SAMPLE || SAMPLE >= list.length) return list
    const step = Math.floor(list.length / SAMPLE)
    return list.filter((_, index) => index % step === 0).slice(0, SAMPLE)
  }
  const titleSample = sampleOf(entries)
  const contentSample = sampleOf(entries)

  console.log(`\n${'='.repeat(72)}\n① 标题已知项检索（索引健康度，召回率上界）\n${'='.repeat(72)}`)
  if (SAMPLE) console.log(`   采样 ${titleSample.length}/${entries.length} 条（--sample ${SAMPLE}）`)
  const titleRanks = []
  const titleMisses = []
  for (const entry of titleSample) {
    const rank = rankOf(await search(entry.title), entry.id)
    titleRanks.push(rank)
    if (rank < 0) titleMisses.push(entry)
  }
  printSummary(summarize(titleRanks, '标题 → 条目'))
  if (titleMisses.length) {
    console.log('   未命中示例：')
    titleMisses.slice(0, 5).forEach((e) => console.log(`     [${e.book}] ${e.title.slice(0, 44)}`))
  }

  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(72)}\n② 内容片段已知项检索（不含标题用词）\n${'='.repeat(72)}`)
  const contentRanks = []
  const topicRanks = []
  const skipped = []
  for (const entry of contentSample) {
    const probe = contentProbe(entry)
    // 跳过"非主题"探针：法条引用、案号、纯程序性表述。
    // 这类文本在多条问答中重复出现，用"必须找回原条目"衡量并不公平
    // （例如同一法条被 10 条问答引用，检索到其中任意一条都不算失败）。
    if (isNonTopicalProbe(probe)) { skipped.push(entry); continue }
    const results = await searchLaborKb(probe, { limit: TOP_K })
    contentRanks.push(rankOf(results, entry.id))
    // 同主题命中：top-k 中是否含同章同节的条目 —— 对"相近内容分散在多条"的语料更公平
    const sameTopic = results.findIndex((item) => item.chapter && item.chapter === entry.chapter && item.section === entry.section)
    topicRanks.push(sameTopic < 0 ? -1 : sameTopic + 1)
  }
  printSummary(summarize(contentRanks, '正文片段 → 原条目（严格）'))
  console.log(`   （已跳过 ${skipped.length} 条非主题探针，占 ${((skipped.length / contentSample.length) * 100).toFixed(1)}%）`)
  printSummary(summarize(topicRanks, '正文片段 → 同章同节条目（宽松）'))
  console.log('   说明：本语料同一主题常分散在多条问答中（如同一条法条被多条引用），')
  console.log('         "严格"版要求找回原条目，会低估真实可用性；"宽松"版衡量是否定位到正确主题。')

  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(72)}\n③ 对照：无 2-gram 分词（模拟中文分词修复前）\n${'='.repeat(72)}`)
  const legacy = buildLegacyIndex(entries)
  const legacyTitleRanks = titleSample.map((entry) => rankOf(legacySearch(legacy, entry.title), entry.id))
  const legacyContentRanks = contentSample.map((entry) => rankOf(legacySearch(legacy, contentProbe(entry)), entry.id))
  const legacyTitle = summarize(legacyTitleRanks, '标题 → 条目（无 2-gram）')
  const legacyContent = summarize(legacyContentRanks, '正文片段 → 条目（无 2-gram）')
  printSummary(legacyTitle)
  printSummary(legacyContent)

  const fix = (now, before, key) => {
    const delta = now.metrics[key] - before.metrics[key]
    return `${(now.metrics[key] * 100).toFixed(1)}% vs ${(before.metrics[key] * 100).toFixed(1)}%  (+${(delta * 100).toFixed(1)}pt)`
  }
  const titleNow = summarize(titleRanks, '')
  const contentNow = summarize(contentRanks, '')
  console.log('\n   2-gram 分词带来的提升：')
  console.log(`     标题 Recall@10   ${fix(titleNow, legacyTitle, 'recall@10')}`)
  console.log(`     标题 Recall@1    ${fix(titleNow, legacyTitle, 'recall@1')}`)
  console.log(`     内容 Recall@10   ${fix(contentNow, legacyContent, 'recall@10')}`)
  console.log(`     内容 Recall@1    ${fix(contentNow, legacyContent, 'recall@1')}`)
  console.log(`     MRR（标题）      ${titleNow.mrr.toFixed(4)} vs ${legacyTitle.mrr.toFixed(4)}`)

  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(72)}\n④ 真实提问抽样（需人工核对相关性 → 准确率）\n${'='.repeat(72)}`)
  const sampleSize = Number((args.includes('--sample') ? args[args.indexOf('--sample') + 1] : 5)) || 5
  const REAL_QUERIES = [
    '员工严重违纪，公司想解除劳动合同，需要注意哪些程序和证据',
    '试用期员工不符合录用条件，公司怎么合法解除',
    '竞业限制违约金约定多少合适',
    '加班费的计算基数怎么确定',
    '员工拒绝调岗，公司能否按旷工解除',
    '未缴社保员工被迫解除，经济补偿怎么算',
    '工伤停工留薪期有多久，期间工资怎么发',
    '员工隐婚隐孕能否按违反诚信解除',
    '年休假没休完，离职时怎么折算工资',
    '经济性裁员的法定程序和优先留用规则'
  ]
  const sampleQueries = REAL_QUERIES.slice(0, sampleSize)
  for (let index = 0; index < sampleQueries.length; index += 1) {
    const query = sampleQueries[index]
    const results = await search(query)
    console.log(`\n   ${index + 1}. 问：${query}`)
    if (results.retrieval) {
      const r = results.retrieval
      console.log(`      检索模式 ${r.mode}｜词法 ${r.lexical.count} 语义 ${r.vector.count} 重排 ${r.rerank.count}｜${r.elapsedMs}ms`)
    }
    results.slice(0, 5).forEach((item, rank) => {
      const cases = item.caseRefs.length ? ` [案号${item.caseRefs.length}]` : ''
      console.log(`      ${rank + 1}. [${item.book}] ${item.title.slice(0, 40)}${cases}`)
    })
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log('说明：① ② ③ 为确定性指标，可重复验证；④ 需人工判断"检索结果是否真的回答了问题"，')
  console.log('      这才是准确率（precision）。本脚本不自动给出准确率，避免用字符串比对冒充相关性判定。')
  console.log('='.repeat(72))

  legacy.close()
  close()
}

main().catch((error) => {
  console.error('[evaluate-labor-kb] 评测失败:', error.message || error)
  close()
  process.exit(1)
})
