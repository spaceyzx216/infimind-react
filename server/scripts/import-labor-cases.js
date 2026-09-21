/**
 * 劳动争议案例导入脚本。
 *
 * 用法：
 *   node server/scripts/import-labor-cases.js                    # 导入内置种子（第四批典型案例）
 *   node server/scripts/import-labor-cases.js ./cases.json       # 导入外部 JSON 数组
 *   node server/scripts/import-labor-cases.js --list             # 查看当前库内案例
 *
 * 外部 JSON 结构（数组，字段均可选，title 必填）：
 *   [{ "title": "...", "caseType": "典型案例", "batch": "...", "publishedAt": "2025-04-09",
 *      "caseNo": "", "court": "", "region": "", "disputeFocus": "", "facts": "",
 *      "holding": "", "result": "", "legalBasis": "", "source": "", "sourceUrl": "" }]
 *
 * ⚠️ 数据合规红线：只导入**公开发布**且允许引用的案例（政府/法院公开发布的典型案例、
 *    指导性案例，或依法公开的裁判文书）。不得导入含个人隐私未脱敏内容的文书。
 */
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import {
  initialize,
  addCase,
  listCases,
  getLaborStatus,
  seedLaborCases,
  close
} from '../services/law-whitelist.js'
import { LABOR_CASES_SEED } from '../knowledge-base/labor-cases-seed.js'

const REQUIRED_HINT = 'title（案例标题）为必填字段'

/** 校验并规范化一条案例；返回 { ok, item, error } */
function normalizeCase(raw, index) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `第 ${index + 1} 条不是对象` }
  const title = String(raw.title || '').trim()
  if (!title) return { ok: false, error: `第 ${index + 1} 条缺少 ${REQUIRED_HINT}` }
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const sensitive = /(1[3-9]\d{9}|[1-9]\d{5}(?:19|20)\d{2}[01]\d[0-3]\d{4}|\d{17}[\dXx])/
  const joined = [title, text(raw.facts), text(raw.holding)].join(' ')
  if (sensitive.test(joined)) {
    return { ok: false, error: `第 ${index + 1} 条疑似包含未脱敏的手机号/身份证号，请先脱敏` }
  }
  return {
    ok: true,
    item: {
      title,
      caseNo: text(raw.caseNo),
      court: text(raw.court),
      region: text(raw.region),
      caseType: text(raw.caseType) || '典型案例',
      judgedAt: text(raw.judgedAt) || null,
      publishedAt: text(raw.publishedAt) || null,
      batch: text(raw.batch),
      disputeFocus: text(raw.disputeFocus),
      facts: text(raw.facts),
      holding: text(raw.holding),
      result: text(raw.result),
      legalBasis: text(raw.legalBasis),
      source: text(raw.source),
      sourceUrl: text(raw.sourceUrl)
    }
  }
}

function printStatus(status) {
  console.log('[labor-cases] 当前库状态：')
  console.log(`  法规白名单：${status.laws} 条（已核对 ${status.verifiedLaws} · 待核对 ${status.pendingReviewLaws} · 现行有效 ${status.effectiveLaws}）`)
  console.log(`  案例：${status.cases} 条${status.casesByType.length ? `（${status.casesByType.map((item) => `${item.caseType} ${item.count}`).join(' · ')}）` : ''}`)
}

async function main() {
  const arg = process.argv[2]
  initialize()

  if (arg === '--list') {
    const cases = listCases()
    console.log(`[labor-cases] 共 ${cases.length} 条案例：`)
    cases.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.title}`)
      console.log(`     类型=${item.caseType}｜焦点=${item.disputeFocus || '未标注'}｜来源=${item.batch || item.source || '未标注'}`)
    })
    printStatus(getLaborStatus())
    close()
    return
  }

  let records = LABOR_CASES_SEED
  let origin = '内置种子（人社部、最高法第四批劳动人事争议典型案例）'

  if (arg) {
    const filePath = resolve(process.cwd(), arg)
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    if (!Array.isArray(raw)) throw new Error('外部文件必须是 JSON 数组')
    records = raw
    origin = filePath
  }

  console.log(`[labor-cases] 导入来源：${origin}`)
  const valid = []
  const errors = []
  records.forEach((raw, index) => {
    const result = normalizeCase(raw, index)
    if (result.ok) valid.push(result.item)
    else errors.push(result.error)
  })

  // 内置种子走幂等封装；外部文件逐条插入（同标题会重复，由调用方自行去重）
  let inserted = 0
  let skipped = 0
  if (!arg) {
    const result = seedLaborCases(valid)
    inserted = result.inserted
    skipped = result.skipped
  } else {
    const existingTitles = new Set(listCases({ limit: 10000 }).map((item) => item.title))
    for (const item of valid) {
      if (existingTitles.has(item.title)) { skipped += 1; continue }
      addCase(item)
      inserted += 1
    }
  }

  console.log(`[labor-cases] 导入完成：新增 ${inserted} 条，跳过 ${skipped} 条`)
  if (errors.length) {
    console.warn(`[labor-cases] ${errors.length} 条被拒绝：`)
    errors.forEach((error) => console.warn(`  - ${error}`))
  }
  printStatus(getLaborStatus())
  close()
}

main().catch((error) => {
  console.error('[labor-cases] 导入失败:', error.message || error)
  close()
  process.exit(1)
})
