#!/usr/bin/env node
/**
 * 知识库基线门禁：跑一遍评测，与「已人工批准的基线」比较，退化就失败退出。
 *
 * ★ 断言原则（重要，别改成断言召回）：
 * 实测三次证明「**召回下降 ≠ 改坏了**」—— 当前召回里有一部分是靠"跨类型错捞"凑出来的，
 * 任何让检索**变准**的改动都会先让召回下降（见计划表 §7.1、§6 第 12 条）。
 * 所以本门禁断言的是「**对口程度 + 精度 + 空交付/零召回**」；
 * **召回只记录、不参与通过判定**，仅设一个防灾难的下限（`recallFloor`）。
 *
 * 用法：
 *   node server/scripts/check-kb-baseline.js            # 比对当前实现与基线
 *   node server/scripts/check-kb-baseline.js --update   # 人工确认无问题后，把当前值写成新基线
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const reportPath = join(__dirname, '..', 'knowledge-base', 'evaluation-report.json')
const baselinePath = join(__dirname, '..', 'knowledge-base', 'kb-baseline.json')
const evalScript = join(__dirname, 'evaluate-knowledge-base.js')

/** 断言项：min = 不得低于基线；max = 不得高于基线 */
const CHECKS = [
  { key: 'finalCategoryPrecision', label: '最终层类别精度', direction: 'min', tolerance: 0.01 },
  { key: 'finalTypeMismatchRate', label: '类型错配率（对口程度）', direction: 'max', tolerance: 0.01 },
  { key: 'finalEmptyRate', label: '空交付率', direction: 'max', tolerance: 0.01 },
  { key: 'finalZeroRecallRate', label: '零召回率', direction: 'max', tolerance: 0.01 }
]

/** 记录项：不参与通过判定 */
const RECORD_ONLY = [
  { key: 'finalCategoryRecall', label: '最终层类别召回（仅记录：下降不等于退化）' }
]

const round4 = (value) => Number(Number(value || 0).toFixed(4))
const pct = (value) => `${(Number(value || 0) * 100).toFixed(2)}%`

function runEvaluation() {
  console.log('[check-kb] 跑评测（约 40 秒）…')
  const result = spawnSync(process.execPath, [evalScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, RAG_RERANKER_MODE: 'heuristic' }
  })
  if (result.status !== 0) {
    console.error('[check-kb] 评测执行失败：')
    console.error(((result.stdout || '') + (result.stderr || '')).slice(-1500))
    process.exit(1)
  }
}

function pickMetrics(report) {
  const final = report?.layers?.final
  if (!final) throw new Error('评测报告缺少 layers.final，无法比对')
  return {
    finalCategoryRecall: round4(final.meanCategoryRecall),
    finalCategoryPrecision: round4(final.meanCategoryPrecision),
    finalTypeMismatchRate: round4(final.meanTypeMismatchRate),
    finalEmptyRate: round4(final.emptyRate),
    finalZeroRecallRate: round4(final.zeroRecallRate)
  }
}

/**
 * 运行环境指纹。**指标值脱离口径就没有意义** —— 同一个 0.5974，在"纯词法"和
 * "词法+向量"下是两回事（实测：向量在无子类型过滤时 −0.81pp、有子类型过滤时 +0.98pp）。
 * 所以基线必须连口径一起记，并在比对前先确认口径没变。
 */
function pickEnvironment(report) {
  const config = report?.config || {}
  return {
    // 运行态标注优先于配置态：报告带 runtimeDegraded 说明向量实际已退回词法，
    // 这份报告不能当向量口径的基线用
    reranker: config.reranker?.enabled ? `siliconflow:${config.reranker.model}` : 'heuristic',
    vector: config.vector?.runtimeDegraded ? 'lexical(runtime-degraded)' : (config.vector?.mode || 'unknown'),
    subTypeFilter: config.subTypeFilter?.requested ? 'on' : 'off',
    contractTypeHint: config.contractTypeHint === false ? 'off' : 'on',
    // 9-22 的教训：cap 3→4→5 改了三次，基线口径跟着变，全靠人肉记得 --update——
    // 指纹不记 cap/limit 的话，门禁会拿旧口径的基线静默判新口径的结果
    cap: config.referenceCombo?.cap ?? '(未记录)',
    limit: config.topK ?? '(未记录)'
  }
}

function diffEnvironment(baselineEnv, currentEnv) {
  if (!baselineEnv) return ['（基线里没有 environment 字段，无法确认口径）']
  const diffs = []
  for (const key of Object.keys(currentEnv)) {
    const before = baselineEnv[key] ?? '(未记录)'
    if (String(before) !== String(currentEnv[key])) diffs.push(`${key}: ${before} → ${currentEnv[key]}`)
  }
  return diffs
}

function main() {
  const isUpdate = process.argv.includes('--update')

  if (isUpdate) {
    runEvaluation()
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const metrics = pickMetrics(report)
    const payload = {
      updatedAt: new Date().toISOString(),
      note: '知识库评测基线。由 check-kb-baseline.js --update 写入，人工确认无问题后再提交。',
      assertionRule: '断言：精度不得下降、对准度指标不得升高（容差 0.01）。召回只记录、不参与判定。',
      tolerance: 0.01,
      recallFloor: 0.45,
      environment: pickEnvironment(report),
      metrics
    }
    writeFileSync(baselinePath, JSON.stringify(payload, null, 2), 'utf8')
    console.log(`[check-kb] 基线已更新：${baselinePath}`)
    console.log(JSON.stringify(metrics, null, 2))
    return
  }

  if (!existsSync(baselinePath)) {
    console.error(`[check-kb] 找不到基线文件 ${baselinePath}`)
    console.error('[check-kb] 先执行：node server/scripts/check-kb-baseline.js --update')
    process.exit(1)
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  runEvaluation()
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const current = pickMetrics(report)
  const tolerance = Number(baseline.tolerance ?? 0.01)

  // 先确认口径一致 —— 指标值脱离口径没有意义，不同口径下的"退化"其实是另一回事
  const environmentDiffs = diffEnvironment(baseline.environment, pickEnvironment(report))
  if (environmentDiffs.length) {
    console.error('\n[check-kb] ❌ 运行口径与基线不一致，指标不能直接比较：')
    for (const diff of environmentDiffs) console.error('   · ' + diff)
    console.error('   基线口径：' + JSON.stringify(baseline.environment || {}))
    console.error('   当前口径：' + JSON.stringify(pickEnvironment(report)))
    console.error('[check-kb] 若这次口径切换是预期的，请先确认新口径下的指标合理，再更新基线：')
    console.error('   node server/scripts/check-kb-baseline.js --update')
    process.exit(1)
  }

  const failures = []
  console.log('\n[check-kb] 断言项（容差 ' + tolerance + '）')
  console.log('指标'.padEnd(24), '基线'.padEnd(10), '当前'.padEnd(10), '结论')
  for (const check of CHECKS) {
    const base = Number(baseline.metrics?.[check.key] ?? 0)
    const now = Number(current[check.key] ?? 0)
    const limit = check.direction === 'min' ? base - tolerance : base + tolerance
    const ok = check.direction === 'min' ? now >= limit : now <= limit
    if (!ok) failures.push({ ...check, base, now, limit })
    console.log(
      check.label.padEnd(24),
      pct(base).padEnd(10),
      pct(now).padEnd(10),
      ok ? '✅ 通过' : `❌ 退化（下限/上限 ${pct(limit)}）`
    )
  }

  console.log('\n[check-kb] 记录项（不参与判定）')
  for (const record of RECORD_ONLY) {
    const base = Number(baseline.metrics?.[record.key] ?? 0)
    const now = Number(current[record.key] ?? 0)
    const delta = ((now - base) * 100).toFixed(2)
    console.log(`  ${record.label}：${pct(base)} → ${pct(now)}（${delta >= 0 ? '+' : ''}${delta}pp）`)
  }
  const recallFloor = Number(baseline.recallFloor ?? 0.45)
  if (Number(current.finalCategoryRecall) < recallFloor) {
    failures.push({
      key: 'finalCategoryRecall', label: '最终层类别召回（防灾难下限）',
      base: recallFloor, now: current.finalCategoryRecall, limit: recallFloor
    })
    console.log(`  ⚠️ 召回 ${pct(current.finalCategoryRecall)} 低于防灾难下限 ${pct(recallFloor)}`)
  } else {
    console.log(`  （召回防灾难下限 ${pct(recallFloor)}，当前达标）`)
  }

  if (failures.length) {
    console.error(`\n[check-kb] ❌ 门禁未通过：${failures.length} 项退化`)
    console.error('[check-kb] 若确认是「检索变准带来的合理变化」，请分别处理：')
    console.error('  · 精度 / 对口指标的退化通常是真的退化，先定位用例');
    console.error('  · 确认无问题后用 --update 更新基线，并在提交信息里写明原因')
    process.exit(1)
  }
  console.log('\n[check-kb] ✅ 门禁通过（召回未作通过条件，理由见脚本头注释）')
}

main()
