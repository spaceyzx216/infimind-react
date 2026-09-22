#!/usr/bin/env node
/**
 * 标注质量复核（AI 独立复核，不是金标）。
 *
 * 定位：**不重新标注，只找分歧** —— 把人的审查范围从 604 条压到几十条。
 * 产物是一份分级排序的分歧清单，最终裁定权在 mentor / 法务。
 *
 * 判据（当前实现①②，全部只读、不需要读合同全文）：
 *  ① 自相矛盾：同一 trigger_text 被归进不同 category / 标了不同 severity / 跨不同 contract_type
 *     —— 同一句话不可能同时属于两个互斥类别，至少一条错（数学上必然）
 *  ② 交叉验证：用库内现成的 inferRiskCategory() 词表对 trigger+risk_text 再推一遍类别，
 *     与现有 category 对比。⚠️ 若现有类别本就由该函数生成，此项只是"一致性检查"而非独立意见，
 *     报告里会注明。真正独立的第二意见来自"多数投票"（同 trigger 在多处的类别，少数派可疑）。
 *
 * 用法：node server/scripts/audit-labels.js [--markdown]
 */
import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { inferRiskCategory } from '../services/knowledge-processor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const db = new Database(join(__dirname, '..', 'knowledge-base', 'templates.db'), { readonly: true })

const rows = db.prepare(`
  SELECT r.id, r.trigger_text, r.risk_text, r.category, r.severity,
         t.contract_type, t.sub_type, t.source_file
  FROM risk_rules r JOIN templates t ON t.id = r.template_id
  ORDER BY r.id
`).all()

/** 触发条款的分组键：去空白后取前 80 字（trigger_text 有 1000 字截断，全文比对会因截断差异漏配） */
const normKey = (s) => String(s || '').replace(/\s+/g, '').slice(0, 80)
const short = (s, n = 46) => String(s || '').replace(/\s+/g, ' ').slice(0, n)
const fileName = (s) => String(s || '').split('/').pop()

const byTrigger = new Map()
for (const row of rows) {
  const key = normKey(row.trigger_text)
  if (!key) continue
  if (!byTrigger.has(key)) byTrigger.set(key, [])
  byTrigger.get(key).push(row)
}

// ---- ① 自相矛盾 ----
const categoryConflicts = []   // 同 trigger 跨类别
const severityConflicts = []   // 同 trigger 跨严重度
const typeConflicts = []       // 同 trigger 跨合同类型
for (const [key, group] of byTrigger) {
  if (group.length < 2) continue
  const cats = [...new Set(group.map((g) => g.category))]
  const sevs = [...new Set(group.map((g) => g.severity))]
  const types = [...new Set(group.map((g) => g.contract_type))]
  if (cats.length > 1) {
    // 多数投票：出现次数最多的类别作为"建议"，其余标为可疑
    const counts = {}
    for (const g of group) counts[g.category] = (counts[g.category] || 0) + 1
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
    categoryConflicts.push({ key, group, cats, majority: ranked[0], ranked })
  }
  if (sevs.length > 1) severityConflicts.push({ key, group, sevs })
  if (types.length > 1) typeConflicts.push({ key, group, types })
}

// ---- ② inferRiskCategory 交叉验证 ----
const crossCheck = []
for (const row of rows) {
  const derived = inferRiskCategory(`${row.trigger_text}\n${row.risk_text}`)
  if (derived && derived !== row.category) {
    crossCheck.push({ row, derived })
  }
}

// ---- 汇总输出 ----
const lines = []
const push = (s = '') => lines.push(s)

push('# 标注质量复核报告（AI 独立复核）')
push('')
push(`> 生成：${new Date().toISOString().slice(0, 16)} ｜ 数据：${rows.length} 条风险规则 / ${byTrigger.size} 个不同 trigger_text`)
push('> **定位声明**：这是**AI 独立复核**，不是金标 —— 604 条规则本就由 AI 从批注抽取，')
push('> 同一来源再做标注不构成交叉验证。本报告只负责**把人的审查范围从 604 条压到下面这几组**，')
push('> **裁定权在 mentor / 法务**。裁定后按裁定修数据、重灌、重测。')
push('')
push('## 汇总')
push('')
push('| 检查项 | 结果 | 读法 |')
push('|---|---|---|')
push(`| ① 同 trigger 归进不同类别 | **${categoryConflicts.length} 组** | 每组**至少各有一条错**（可能互斥） |`)
push(`| ① 同 trigger 标了不同严重度 | **${severityConflicts.length} 组** | severity 是规则级属性，不该有两个值 |`)
push(`| ① 同 trigger 跨不同合同类型 | **${typeConflicts.length} 组** | ${typeConflicts.length ? '⚠️ 存在跨类型错标' : '✅ 无（规则没有跑到别的类型去）'} |`)
push(`| ② inferRiskCategory 交叉验证 | **${crossCheck.length} 条不一致** | ${crossCheck.length ? '见下方说明（可能含同义反复成分）' : '✅ 无'} |`)
push('')
push(`> 出现 ≥2 次的 trigger 共 ${[...byTrigger.values()].filter((g) => g.length >= 2).length} 个 —— 冲突都从这里来；只出现一次的 trigger 无法用本方法检验。`)
push('')

push('## 一、类别冲突（需人从候选里挑一个）')
push('')
for (const [index, conflict] of categoryConflicts.entries()) {
  const first = conflict.group[0]
  push(`### ${index + 1}. ${short(first.trigger_text)}`)
  push('')
  push(`- 出现 ${conflict.group.length} 次，类别分布：${conflict.ranked.map(([cat, n]) => `${cat}×${n}`).join('、')} —— **多数派建议：${conflict.majority[0]}**`)
  for (const g of conflict.group) {
    const mark = g.category === conflict.majority[0] ? '✅' : '⚠️'
    push(`  - ${mark} [#${g.id}] **${g.category}** / ${g.severity} ｜ ${g.contract_type}${g.sub_type ? ` · ${g.sub_type}` : ''} ｜ ${fileName(g.source_file)}`)
  }
  push(`- 原文：${short(first.trigger_text, 120)}`)
  push('')
}

push('## 二、严重度不一致（需人挑一个）')
push('')
for (const [index, conflict] of severityConflicts.entries()) {
  const first = conflict.group[0]
  push(`${index + 1}. ${short(first.trigger_text)} —— ${conflict.sevs.join(' vs ')}（${conflict.group.length} 处）`)
}
push('')

push('## 三、inferRiskCategory 交叉验证')
push('')
push('> ⚠️ 注意：条款表的 category 本就由该函数推导，风险规则的 category 来自批注解析。')
push('> 若某条的 category 实际也来自此函数，则这项属于**同义反复**，仅当参考；')
push('> **真正独立的意见是第一节的"多数投票"**。')
push('')
for (const [index, item] of crossCheck.slice(0, 40).entries()) {
  push(`${index + 1}. [#${item.row.id}] 现有 **${item.row.category}** ≠ 推导 **${item.derived}** ｜ ${short(item.row.trigger_text)}`)
}
if (crossCheck.length > 40) push(`…… 其余 ${crossCheck.length - 40} 条见完整输出`)
push('')

push('## 四、建议的裁定流程')
push('')
push('1. 先过「一、类别冲突」—— 每组从候选里挑一个（多数派是建议，不是答案）')
push('2. 再过「二、严重度」—— 同一规则定一个档')
push('3. 「三、交叉验证」只抽看明显离谱的（如同一条既讲付款又标了质量）')
push('4. 裁定结果给我，我按裁定修数据 → 重灌 → 重测')
push('')

const output = lines.join('\n')
console.log(output)

// --markdown 时不额外写文件（由调用方重定向），这里仅打印统计摘要便于人看
if (!process.argv.includes('--markdown')) {
  console.error(`\n[audit-labels] 摘要：类别冲突 ${categoryConflicts.length} 组｜严重度 ${severityConflicts.length} 组｜跨类型 ${typeConflicts.length} 组｜交叉验证 ${crossCheck.length} 条`)
}
db.close()
