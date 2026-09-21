/**
 * 混合检索参数扫描。
 *
 * 用同一批判定缓存（labor-kb-labels.json）评估不同参数组合，
 * 指标取 k=6（实际送入模型的条数）处的 precision 与 hitrate。
 *
 * 用法：
 *   node server/scripts/tune-labor-kb.js                 # 扫描全部参数
 *   node server/scripts/tune-labor-kb.js --only=blend    # 只扫某一项
 *
 * ⚠️ 参数扫描必须走真实的 searchLaborKb（含真实的候选池大小），
 *    否则结论不可迁移——本项目已因"离线宽候选池调参"踩过一次坑（见 docs 第十四节）。
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { initializeLaborKb } from '../services/labor-kb.js'
import { initializeLaborVector } from '../services/labor-vector.js'
import { close } from '../services/law-whitelist.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LABEL_CACHE = join(__dirname, '..', 'knowledge-base', 'labor-kb-labels.json')
const K = 6

const QUESTIONS = JSON.parse(readFileSync(LABEL_CACHE, 'utf8'))
const GRID = {
  blend: [0, 0.3, 0.5, 0.7, 0.8, 0.9, 1.0],
  pool: [12, 18, 24, 36, 48],
  rrfk: [10, 30, 60, 100],
  vector: [10, 20, 30, 50],
  minrerank: [0, 0.02, 0.05, 0.1, 0.2]
}
const ENV_OF = {
  blend: (v) => ({ LABOR_KB_RERANK_BLEND: String(v) }),
  pool: (v) => ({ LABOR_KB_RERANK_POOL: String(v) }),
  rrfk: (v) => ({ LABOR_KB_RRF_K: String(v) }),
  vector: (v) => ({ LABOR_KB_VECTOR_CANDIDATES: String(v) }),
  minrerank: (v) => ({ LABOR_KB_MIN_RERANK: String(v) })
}

async function evaluate({ label }) {
  // 参数以环境变量传入，模块级常量在首次 import 时读取——
  // 因此每个组合都需要在独立进程里跑（见下方 spawn）。
  const { searchLaborKb } = await import('../services/labor-kb.js')
  let rel = 0
  let total = 0
  let hit = 0
  let top1 = 0
  let empty = 0
  let latency = 0
  for (const [question, labelMap] of Object.entries(QUESTIONS)) {
    const results = await searchLaborKb(question, { limit: K })
    latency += results.retrieval?.elapsedMs || 0
    if (!results.length) { empty += 1; continue }
    let r = 0
    results.forEach((item) => {
      const l = labelMap[item.id]
      if (l) { total += 1; if (l === '相关') { r += 1; rel += 1 } }
    })
    if (r > 0) hit += 1
    if (labelMap[results[0].id] === '相关') top1 += 1
  }
  const q = Object.keys(QUESTIONS).length
  return { label, precision: rel / Math.max(1, total), hitrate: hit / q, top1: top1 / q, empty, avgMs: Math.round(latency / q) }
}

/** 在子进程中跑一个参数组合（模块常量只在 import 时读取一次） */
async function runInChild(env) {
  const { spawnSync } = await import('child_process')
  const script = `
    import { initializeLaborKb } from '${join(__dirname, '..', 'services', 'labor-kb.js').replace(/\\/g, '/')}'
    import { initializeLaborVector } from '${join(__dirname, '..', 'services', 'labor-vector.js').replace(/\\/g, '/')}'
    import { searchLaborKb } from '${join(__dirname, '..', 'services', 'labor-kb.js').replace(/\\/g, '/')}'
    import { readFileSync } from 'fs'
    initializeLaborKb(); initializeLaborVector()
    const Q = JSON.parse(readFileSync('${LABEL_CACHE.replace(/\\/g, '/')}', 'utf8'))
    let rel=0,total=0,hit=0,top1=0,empty=0,ms=0
    for (const [question, labelMap] of Object.entries(Q)) {
      const r = await searchLaborKb(question, { limit: ${K} })
      ms += r.retrieval?.elapsedMs || 0
      if (!r.length) { empty++; continue }
      let rr=0
      r.forEach(it => { const l=labelMap[it.id]; if(l){total++; if(l==='相关'){rr++;rel++}} })
      if (rr>0) hit++
      if (labelMap[r[0].id]==='相关') top1++
    }
    const n = Object.keys(Q).length
    console.log(JSON.stringify({ precision: rel/Math.max(1,total), hitrate: hit/n, top1: top1/n, empty, avgMs: Math.round(ms/n) }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 900000
  })
  const line = (result.stdout || '').trim().split('\n').pop()
  try { return JSON.parse(line) } catch { return null }
}

async function main() {
  const args = process.argv.slice(2)
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]
  initializeLaborKb()
  initializeLaborVector()

  console.log('='.repeat(78))
  console.log('混合检索参数扫描（k=6，判定缓存 30 题）')
  console.log('='.repeat(78))

  const baseline = await runInChild({})
  if (!baseline) throw new Error('基线运行失败')
  console.log(`\n基线（默认参数）：precision@6 ${(baseline.precision * 100).toFixed(1)}%｜`
    + `hitrate@6 ${(baseline.hitrate * 100).toFixed(1)}%｜首位相关 ${(baseline.top1 * 100).toFixed(1)}%｜平均 ${baseline.avgMs}ms`)

  for (const [name, values] of Object.entries(GRID)) {
    if (only && only !== name) continue
    console.log(`\n${'─'.repeat(78)}\n扫描 ${name}：`)
    console.log('  取值'.padEnd(12) + 'precision@6   hitrate@6    首位相关   空结果   平均耗时')
    for (const value of values) {
      const r = await runInChild(ENV_OF[name](value))
      if (!r) { console.log(`  ${String(value).padEnd(12)} 运行失败`); continue }
      const mark = Math.abs(r.precision - baseline.precision) < 1e-9 && Math.abs(r.hitrate - baseline.hitrate) < 1e-9 ? ' ←基线' : ''
      console.log(`  ${String(value).padEnd(12)}${(r.precision * 100).toFixed(1)}%`.padEnd(26)
        + `${(r.hitrate * 100).toFixed(1)}%`.padEnd(13) + `${(r.top1 * 100).toFixed(1)}%`.padEnd(11)
        + `${String(r.empty).padEnd(9)}${r.avgMs}ms${mark}`)
    }
  }
  close()
}

main().catch((error) => { console.error('[tune] 失败:', error.message || error); close(); process.exit(1) })
