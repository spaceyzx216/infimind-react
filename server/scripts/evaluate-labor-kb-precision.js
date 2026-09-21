/**
 * 用工咨询知识库「准确率」评测（LLM 相关性判定）。
 *
 * 为什么需要单独的脚本：召回率可以用"能否找回原条目"做字符串比对，
 * 但准确率问的是"检索到的条目是否真的回答了这个问题"——这是相关性判定，
 * 无法由字符串得出。本脚本用模型对「提问 × 检索结果」逐对判定相关性。
 *
 * 用法：
 *   node server/scripts/evaluate-labor-kb-precision.js            # 全量 30 题
 *   node server/scripts/evaluate-labor-kb-precision.js --limit 10  # 只跑前 10 题
 *
 * 指标定义：
 *   精确率 Precision@5 = top-5 中判定为「相关」的比例（分母固定为 5，含不足 5 条的情况）
 *   命中率 HitRate@5   = 至少含 1 条「相关」条目的提问比例 —— 对咨询场景更有意义，
 *                        因为只要有一条好证据，模型就能给出可用答复
 *   首位相关率         = top-1 即为「相关」的提问比例
 *
 * 判定口径：模型只回答「这些检索结果对回答该问题是否有实质帮助」，
 * 不判断答案内容质量（那是另一层评测）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { searchLaborKb, initializeLaborKb } from '../services/labor-kb.js'
import { chat, getFlashModel } from '../services/llm-client.js'
import { close } from '../services/law-whitelist.js'

const TOP_K = Number((process.argv.find((a) => a.startsWith('--topk=')) || '--topk=10').split('=')[1]) || 10
const __dirname = dirname(fileURLToPath(import.meta.url))
/**
 * 判定结果缓存。
 * 打分函数调优需要反复评测，若每次都重新调用模型判定，成本高且结论不可比
 * （模型判定本身有随机性）。缓存后可在**同一批判定**上比较不同打分方案。
 */
const LABEL_CACHE = join(__dirname, '..', 'knowledge-base', 'labor-kb-labels.json')
const USE_CACHE = !process.argv.includes('--no-cache')

/**
 * 真实形态的企业方提问，覆盖五册主要专题。
 * 这些问题**不是**从条目标题改写而来，而是模拟用户自然提问，避免"标题泄漏"。
 */
const QUESTIONS = [
  '员工连续旷工三天，公司按严重违纪解除需要哪些证据',
  '试用期两个月，觉得员工不合适，怎么解除最稳妥',
  '签了竞业限制但没付补偿金，协议还有效吗',
  '加班费的计算基数包含奖金和补贴吗',
  '员工拒绝调岗，公司能否按旷工处理',
  '公司没缴社保，员工提出解除能要经济补偿吗',
  '工伤员工停工留薪期一般多长，期间工资怎么发',
  '女职工怀孕期间能不能调岗降薪',
  '年休假没休完，员工离职时要不要折现',
  '经济性裁员的法定程序是什么，哪些人优先留用',
  '员工入职时隐瞒了婚育情况，公司能解除吗',
  'offer发出后公司反悔，要赔多少钱',
  '员工手册没有经过民主程序，还能作为解除依据吗',
  '病假工资按什么标准发，可以低于最低工资吗',
  '员工下班途中发生交通事故，算不算工伤',
  '劳务派遣员工被退回，派遣公司能否直接解除',
  '员工主动辞职，公司还需要支付经济补偿吗',
  '不定时工时制的员工有加班费吗',
  '员工违反保密协议泄露客户名单，公司怎么索赔',
  '医疗期满员工不能从事原工作，公司怎么处理',
  '公司能否以业绩不达标为由直接解除劳动合同',
  '员工打架斗殴，公司解除需要报警记录吗',
  '未签书面劳动合同，二倍工资最多支持几个月',
  '员工退休返聘，还受劳动法保护吗',
  '试用期可以不缴社保吗',
  '员工离职后去了竞争对手，公司怎么取证',
  '公司搬迁导致通勤变远，员工辞职能否要补偿',
  '迟到早退多次，公司能否累计按严重违纪解除',
  '员工工伤后拒绝做劳动能力鉴定，公司怎么办',
  '劳务外包和劳务派遣在用工风险上有什么区别'
]

const JUDGE_SYSTEM_PROMPT = `你是检索质量评测员。用户会给你一个「企业向的劳动法问题」和若干条「检索到的知识库条目」。
请逐条判断该条目对回答这个问题是否有实质帮助。

判定标准：
- "相关"：条目直接讨论该问题，或提供了回答该问题所需的关键规则、操作步骤、裁判口径。
- "部分相关"：条目讨论的是相邻主题，能提供背景但不能直接回答问题。
- "不相关"：条目讨论的是其它主题。

只输出 JSON，格式：{"results":[{"index":1,"label":"相关"},...]}
label 只能是"相关"、"部分相关"、"不相关"三者之一。不要输出任何解释。`

/** 把一条检索结果压缩成判定用的简短文本 */
const renderEntry = (item, index) => {
  const path = [item.book, item.chapter, item.section].filter(Boolean).join(' > ')
  return `${index}. 标题：${item.title}
   出处：${path || '未标注'}
   内容摘要：${String(item.content || '').replace(/\s+/g, ' ').slice(0, 320)}`
}

async function judgeBatch(question, results) {
  const userMessage = `# 问题
${question}

# 检索到的条目
${results.map((item, index) => renderEntry(item, index + 1)).join('\n\n')}

请逐条判定，输出 JSON。`
  const raw = await chat(JUDGE_SYSTEM_PROMPT, userMessage, {
    model: getFlashModel(),
    temperature: 0,
    maxTokens: 800,
    thinking: { type: 'disabled' }
  })
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error(`判定输出不是 JSON：${raw.slice(0, 120)}`)
  const parsed = JSON.parse(raw.slice(first, last + 1))
  return (parsed.results || []).map((item) => String(item.label || '')).slice(0, results.length)
}

async function main() {
  const args = process.argv.slice(2)
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : QUESTIONS.length
  const questions = QUESTIONS.slice(0, limit)

  initializeLaborKb()
  console.log('='.repeat(74))
  console.log('用工咨询知识库准确率评测（LLM 相关性判定）')
  console.log('='.repeat(74))
  console.log(`提问数：${questions.length}　Top-K：${TOP_K}　判定模型：${getFlashModel()}`)
  console.log(`判定缓存：${USE_CACHE ? LABEL_CACHE : '已禁用（--no-cache）'}\n`)

  let relevant = 0
  let partial = 0
  let judged = 0
  let hitAt5 = 0
  let top1Relevant = 0
  const perQuestion = []
  /** 每条检索结果的 (分数, 相关性判定)，用于推导最小匹配度阈值 */
  const scoreSamples = []

  // 缓存按「提问 → 条目id → 判定」存储，与打分无关，因此可跨打分方案复用
  let cache = {}
  if (USE_CACHE && existsSync(LABEL_CACHE)) {
    try { cache = JSON.parse(readFileSync(LABEL_CACHE, 'utf8')) } catch { cache = {} }
  }
  let cacheHits = 0

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]
    const results = await searchLaborKb(question, { limit: TOP_K })
    if (!results.length) {
      perQuestion.push({ question, labels: [], hit: false })
      console.log(`${String(i + 1).padStart(2)}. ✗ 无检索结果  ${question}`)
      continue
    }
    let labels = []
    const cached = cache[question] || {}
    if (USE_CACHE && results.every((item) => cached[item.id])) {
      labels = results.map((item) => cached[item.id])
      cacheHits += 1
    } else {
      try {
        labels = await judgeBatch(question, results)
        cache[question] = {}
        results.forEach((item, index) => { if (labels[index]) cache[question][item.id] = labels[index] })
      } catch (error) {
        console.log(`${String(i + 1).padStart(2)}. ⚠ 判定失败(${error.message.slice(0, 40)})  ${question}`)
        continue
      }
    }
    const rel = labels.filter((label) => label === '相关').length
    const par = labels.filter((label) => label === '部分相关').length
    relevant += rel
    partial += par
    judged += results.length
    if (rel > 0) hitAt5 += 1
    if (labels[0] === '相关') top1Relevant += 1
    perQuestion.push({ question, labels, hit: rel > 0, top: results[0]?.title })

    // 记录「分数 × 相关性」样本，用于阈值分析
    results.forEach((item, index) => {
      const label = labels[index] || ''
      if (label) {
        scoreSamples.push({
          score: item.score,
          // 重排原始分是**绝对分**（bge-reranker 输出的相关度），
          // 而 item.score 是池内归一化后的融合分（本轮最低者恒为 0），
          // 只有原始分才能跨查询比较、用于设定全局阈值。
          rerank: item.rerankScore ?? null,
          label,
          question
        })
      }
    })

    const mark = rel > 0 ? '✓' : par > 0 ? '~' : '✗'
    console.log(`${String(i + 1).padStart(2)}. ${mark} 相关${rel}/部分${par}/${results.length}  ${question}`)
    console.log(`      首位：${String(results[0]?.title || '').slice(0, 52)}`)
    if (rel === 0) {
      console.log(`      判定：${labels.join('、')}`)
    }
  }

  console.log(`\n${'='.repeat(74)}`)
  console.log('结果')
  console.log('='.repeat(74))
  const pct = (v) => `${(v * 100).toFixed(1)}%`
  const answered = perQuestion.filter((item) => item.labels.length > 0).length
  console.log(`  已判定提问：${answered} / ${questions.length}`)
  console.log(`  精确率 Precision@${TOP_K}（相关 / 已判定条数）：${pct(relevant / judged)}   [${relevant}/${judged}]`)
  console.log(`  精确率（相关+部分相关）：                       ${pct((relevant + partial) / judged)}`)
  console.log(`  命中率 HitRate@${TOP_K}（至少 1 条相关）：        ${pct(hitAt5 / answered)}   [${hitAt5}/${answered}]`)
  console.log(`  首位相关率（top-1 即相关）：                    ${pct(top1Relevant / answered)}   [${top1Relevant}/${answered}]`)
  // ---- 按 k 的曲线：一次评测即可看出"取几条最合适" ----
  console.log(`\n  ${'─'.repeat(60)}`)
  console.log('  截断位置调优：precision@k / hitrate@k')
  console.log(`  ${'k'.padStart(3)}  ${'precision'.padStart(10)}  ${'hitrate'.padStart(9)}  ${'非相关条数'.padStart(11)}`)
  const rows = perQuestion.filter((item) => item.labels.length)
  for (let k = 1; k <= TOP_K; k += 1) {
    let rel = 0
    let total = 0
    let hit = 0
    for (const item of rows) {
      const labels = item.labels.slice(0, k)
      if (!labels.length) continue
      total += labels.length
      const r = labels.filter((label) => label === '相关').length
      rel += r
      if (r > 0) hit += 1
    }
    if (!total) continue
    console.log(`  ${String(k).padStart(3)}  ${pct(rel / total).padStart(10)}  ${pct(hit / rows.length).padStart(9)}  ${String(total - rel).padStart(11)}`)
  }

  // ---- 阈值分析：相关 / 部分相关 / 不相关 的分数分布 ----
  console.log(`\n  ${'─'.repeat(60)}`)
  console.log('  最小匹配度阈值调优：分数分布')
  const buckets = { 相关: [], 部分相关: [], 不相关: [] }
  const rerankBuckets = { 相关: [], 部分相关: [], 不相关: [] }
  scoreSamples.forEach((sample) => {
    if (buckets[sample.label]) buckets[sample.label].push(sample.score)
    if (sample.rerank !== null && rerankBuckets[sample.label]) rerankBuckets[sample.label].push(sample.rerank)
  })
  const stats = (arr) => arr.length
    ? `n=${String(arr.length).padStart(3)}  最低 ${Math.min(...arr).toFixed(1)}  中位 ${arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)].toFixed(1)}  最高 ${Math.max(...arr).toFixed(1)}`
    : 'n=0'
  console.log('  【融合分（池内归一化，仅供参考）】')
  Object.entries(buckets).forEach(([label, arr]) => console.log(`  ${label.padEnd(5)} ${stats([...arr])}`))
  console.log('  【重排原始分（绝对分，可跨查询比较）】')
  Object.entries(rerankBuckets).forEach(([label, arr]) => console.log(`  ${label.padEnd(5)} ${stats([...arr])}`))
  // 基于重排原始分的阈值分析
  const rerankSamples = scoreSamples.filter((s) => s.rerank !== null)
  if (rerankSamples.length) {
    const relCount = rerankSamples.filter((s) => s.label === '相关').length
    const noiseCount = rerankSamples.filter((s) => s.label === '不相关').length
    console.log(`\n  基于重排原始分的阈值（相关 ${relCount} 条 / 不相关 ${noiseCount} 条）：`)
    for (const t of [0.05, 0.1, 0.2, 0.3, 0.5]) {
      const kept = rerankSamples.filter((s) => s.rerank >= t)
      const dropped = rerankSamples.filter((s) => s.rerank < t)
      const relKept = kept.filter((s) => s.label === '相关').length
      const relLost = dropped.filter((s) => s.label === '相关').length
      const noiseCut = dropped.filter((s) => s.label === '不相关').length
      const keptTotal = kept.length || 1
      console.log(`    阈值 ${t.toFixed(2)}： 保留 ${kept.length} 条（precision ${(relKept / keptTotal * 100).toFixed(1)}%）`
        + `｜误杀相关 ${relLost}｜滤掉不相关 ${noiseCut}｜相关保留率 ${(relKept / Math.max(1, relCount) * 100).toFixed(1)}%`)
    }
  }
  const all = scoreSamples.map((s) => s.score).sort((a, b) => a - b)
  if (all.length) {
    console.log(`\n  若设置阈值，被丢弃的检索结果占比与影响：`)
    for (const q of [0, 0.1, 0.25, 0.5, 0.75]) {
      const cut = all[Math.floor(all.length * q)]
      const kept = scoreSamples.filter((s) => s.score >= cut)
      const dropped = scoreSamples.filter((s) => s.score < cut)
      const relKept = kept.filter((s) => s.label === '相关').length
      const relDropped = dropped.filter((s) => s.label === '相关').length
      const noiseDropped = dropped.filter((s) => s.label === '不相关').length
      console.log(`    阈值 ${cut.toFixed(2)}（丢弃分数最低的 ${(q * 100).toFixed(0)}%）：`
        + ` 保留相关 ${relKept}，误丢相关 ${relDropped}，丢弃不相关 ${noiseDropped}`)
    }
  }

  console.log(`\n  未命中提问：`)
  perQuestion.filter((item) => item.labels.length && !item.hit)
    .forEach((item) => console.log(`    - ${item.question}`))

  // 写入判定缓存：后续调整打分函数时可在同一批判定上比较，无需重复调用模型
  if (USE_CACHE) {
    try {
      mkdirSync(dirname(LABEL_CACHE), { recursive: true })
      writeFileSync(LABEL_CACHE, JSON.stringify(cache, null, 2), 'utf8')
      console.log(`\n  判定缓存命中 ${cacheHits}/${questions.length}　已写入 ${LABEL_CACHE}`)
    } catch (error) {
      console.warn(`  判定缓存写入失败：${error.message}`)
    }
  }

  close()
}

main().catch((error) => {
  console.error('[precision-eval] 评测失败:', error.message || error)
  close()
  process.exit(1)
})
