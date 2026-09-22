#!/usr/bin/env node
/**
 * 严重度批量重标（问题 9）。
 *
 * 现状：`inferSeverity` 只升不降 ⇒ 604 条里 503"中"、101"高"、0"低"，分级形同虚设。
 * 修法：改用 `scoreSeverity()` 的三维打分（法定强制 / 金额敞口 / 权利不对等），
 * 判档理由一并输出，便于法务抽检。**不调 LLM**。
 *
 * 用法：
 *   node server/scripts/rescore-severity.js             # 预览（默认 dry-run，不改数据）
 *   node server/scripts/rescore-severity.js --apply     # 落库（只 UPDATE severity 列，
 *                                                       #   不重建 DB，不影响 FTS 与向量索引）
 *   node server/scripts/rescore-severity.js --json      # 输出 JSON（供复核/抽检）
 */
import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { scoreSeverity } from '../services/knowledge-processor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = join(__dirname, '..', 'knowledge-base', 'templates.db')
const isApply = process.argv.includes('--apply')
const asJson = process.argv.includes('--json')
const db = new Database(dbPath, { readonly: !isApply })

const rows = db.prepare(`
  SELECT r.id, r.category, r.severity, r.trigger_text, r.risk_text, r.recommendation,
         t.contract_type, t.source_file
  FROM risk_rules r JOIN templates t ON t.id = r.template_id ORDER BY r.id
`).all()

const before = { 高: 0, 中: 0, 低: 0 }
const after = { 高: 0, 中: 0, 低: 0 }
const changes = []
let changed = 0

for (const row of rows) {
  const text = [row.trigger_text, row.risk_text, row.recommendation].filter(Boolean).join('\n')
  const scored = scoreSeverity(text)
  before[row.severity] = (before[row.severity] || 0) + 1
  after[scored.level] = (after[scored.level] || 0) + 1
  if (scored.level !== row.severity) {
    changed++
    changes.push({
      id: row.id, from: row.severity, to: scored.level, reasons: scored.reasons,
      category: row.category, contractType: row.contract_type,
      source: String(row.source_file || '').split('/').pop(),
      text: String(row.trigger_text || '').replace(/\s+/g, ' ').slice(0, 60)
    })
  }
}

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, before, after, changed, changes }, null, 2))
} else {
  console.log(`规则总数 ${rows.length}`)
  console.log('\n重标前分布:', JSON.stringify(before))
  console.log('重标后分布:', JSON.stringify(after))
  console.log(`变更 ${changed} 条（${(changed / rows.length * 100).toFixed(1)}%）`)
  const byDirection = {}
  for (const change of changes) {
    const key = `${change.from} → ${change.to}`
    byDirection[key] = (byDirection[key] || 0) + 1
  }
  console.log('\n变更方向:', JSON.stringify(byDirection))
  console.log('\n--- 抽样（前 15 条，含判档理由）---')
  for (const change of changes.slice(0, 15)) {
    console.log(`[#${change.id}] ${change.from} → ${change.to}  [${change.reasons.join('、')}]`)
    console.log(`    ${change.contractType} · ${change.category} · ${change.source}`)
    console.log(`    ${change.text}`)
  }
}

if (isApply) {
  const update = db.prepare('UPDATE risk_rules SET severity = ? WHERE id = ?')
  const apply = db.transaction((items) => {
    for (const item of items) update.run(item.to, item.id)
  })
  apply(changes)
  console.log(`\n✅ 已落库：${changes.length} 条 severity 更新（未重建 DB，FTS 与向量索引不受影响）`)
} else if (!asJson) {
  console.log('\n（dry-run，未改数据。确认后加 --apply）')
}

db.close()
