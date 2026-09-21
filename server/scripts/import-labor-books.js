/**
 * 用工风险实务书籍导入脚本。
 *
 * 用法：
 *   node server/scripts/import-labor-books.js <资料目录>            # 解析目录下所有 .docx
 *   node server/scripts/import-labor-books.js <目录> --reset        # 先清空问答库再导入
 *   node server/scripts/import-labor-books.js --list                # 查看问答库状态
 *   node server/scripts/import-labor-books.js --dump "关键词"       # 检索验证
 *
 * 产物：
 *   1. server/knowledge-base/labor-books/*.txt —— 归一化后的纯文本（保留来源，便于重新切分）
 *   2. labor.db 的 labor_kb_entries + labor_kb_fts —— 结构化问答条目
 *
 * 为什么要保存归一化文本：原始 .docx 不在仓库内，保留文本后无需重新解析 Word
 * 即可重跑切分逻辑（调整切分规则时很有用）。
 */
import { readdir, readFile, writeFile, mkdir } from 'fs/promises'
import { join, extname, basename, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { extractText } from '../services/file-parser.js'
import { parseLaborBook, normalizeContent, extractCaseNumbers } from '../services/labor-book-parser.js'
import { initializeLaborKb, addKbEntry, resetLaborKb, getLaborKbStatus, searchLaborKb, listKbEntries } from '../services/labor-kb.js'
import { close } from '../services/law-whitelist.js'
import { toIndexText } from '../services/cjk-tokenizer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(__dirname, '..', 'knowledge-base', 'labor-books')

/** 册名取自文件名（去掉扩展名与括号后缀） */
const bookNameOf = (file) => basename(file, extname(file)).replace(/[（(]\d+[）)]$/, '').trim()

const hashOf = (entry) => createHash('sha256')
  .update(`${entry.book}|${entry.questionNo}|${entry.title}|${entry.content}`)
  .digest('hex').slice(0, 32)

/** 归一化文本：剥离页眉/页码，仅保留正文，供人工核对与重新切分 */
function renderNormalizedText(parsed) {
  const lines = [`# ${parsed.stats.book}`, '']
  let lastChapter = ''
  for (const entry of parsed.entries) {
    if (entry.chapter && entry.chapter !== lastChapter) {
      lines.push('', `## ${entry.chapter}`, '')
      lastChapter = entry.chapter
    }
    if (entry.section) lines.push(`### ${entry.section}`)
    if (entry.subsection) lines.push(`#### ${entry.subsection}`)
    lines.push('', `【${entry.questionNo}】${entry.title}`, '', entry.content, '')
  }
  return lines.join('\n')
}

async function listDocx(dir) {
  const children = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const child of children) {
    if (child.name.startsWith('.')) continue
    const full = join(dir, child.name)
    if (child.isDirectory()) files.push(...await listDocx(full))
    else if (extname(child.name).toLowerCase() === '.docx' && !child.name.startsWith('~$')) files.push(full)
  }
  return files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function printStatus() {
  const status = getLaborKbStatus()
  console.log('[labor-books] 问答库状态：')
  console.log(`  条目总数：${status.entries}`)
  console.log(`  含裁判案号：${status.withCaseRefs}（${status.entries ? Math.round(status.withCaseRefs / status.entries * 100) : 0}%）`)
  console.log(`  平均答案长度：${status.averageLength} 字`)
  status.byBook.forEach((item) => console.log(`  ${item.book}：${item.count} 条`))
}

async function main() {
  const args = process.argv.slice(2)
  initializeLaborKb()

  if (args[0] === '--list') {
    printStatus()
    console.log('\n前 10 条：')
    listKbEntries({ limit: 10 }).forEach((entry) => {
      console.log(`  [${entry.book}] ${entry.questionNo} ${entry.title}`)
      console.log(`      ${entry.chapter} > ${entry.section}${entry.subsection ? ` > ${entry.subsection}` : ''}`)
    })
    close()
    return
  }

  if (args[0] === '--dump') {
    const query = args[1] || ''
    if (!query) throw new Error('用法：--dump "关键词"')
    console.log(`[labor-books] 检索："${query}"`)
    const results = searchLaborKb(query, { limit: 5 })
    if (!results.length) console.log('  未命中任何条目')
    results.forEach((entry, index) => {
      console.log(`\n  ${index + 1}. [${entry.book}] ${entry.questionNo} ${entry.title}  (score=${entry.score.toFixed(3)})`)
      console.log(`     ${entry.chapter} > ${entry.section}`)
      console.log(`     ${entry.content.slice(0, 160).replace(/\n/g, ' ')}…`)
      if (entry.caseRefs.length) console.log(`     案号：${entry.caseRefs.join('、')}`)
    })
    close()
    return
  }

  const dir = resolve(process.cwd(), args[0] || join(__dirname, '..', '..'))
  if (args.includes('--reset')) {
    resetLaborKb()
    console.log('[labor-books] 已清空问答库')
  }

  const files = await listDocx(dir)
  if (!files.length) throw new Error(`目录中没有 .docx 文件：${dir}`)
  console.log(`[labor-books] 找到 ${files.length} 份资料，来源目录：${dir}`)
  await mkdir(OUTPUT_DIR, { recursive: true })

  let inserted = 0
  let skipped = 0
  let totalChars = 0
  const summaries = []

  for (const path of files) {
    const book = bookNameOf(path)
    process.stdout.write(`  [解析] ${basename(path)} … `)
    const buffer = await readFile(path)
    const { text } = await extractText({
      buffer,
      originalname: basename(path),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })
    const parsed = parseLaborBook(text, { book })

    await writeFile(join(OUTPUT_DIR, `${book}.txt`), renderNormalizedText(parsed), 'utf8')

    let bookInserted = 0
    let bookSkipped = 0
    for (const raw of parsed.entries) {
      const content = normalizeContent(raw.content)
      if (!content || !raw.title) { bookSkipped += 1; continue }
      const entry = {
        book,
        chapter: raw.chapter,
        section: raw.section,
        subsection: raw.subsection,
        questionNo: raw.questionNo,
        title: raw.title,
        content,
        caseRefs: extractCaseNumbers(content)
      }
      // 校验：正文里不应残留页眉（导入期发现比线上发现便宜）
      const result = addKbEntry(entry, hashOf(entry))
      if (result.inserted) { bookInserted += 1; totalChars += content.length }
      else bookSkipped += 1
    }
    inserted += bookInserted
    skipped += bookSkipped
    console.log(`条目 ${parsed.entries.length}（新增 ${bookInserted} / 跳过 ${bookSkipped}），去页眉 ${parsed.stats.strippedHeaderLines} 行`)
    summaries.push({ book, parsed: parsed.entries.length, inserted: bookInserted, skipped: bookSkipped, stats: parsed.stats })
  }

  console.log(`\n[labor-books] 导入完成：新增 ${inserted} 条，跳过 ${skipped} 条，正文合计 ${totalChars.toLocaleString()} 字`)
  console.log(`[labor-books] 归一化文本已写入：${OUTPUT_DIR}`)
  printStatus()

  // 抽样自检：把索引态还原成可读形式，确认 2-gram 索引里有真实 token
  const probe = '竞业限制'
  console.log(`\n[labor-books] 分词自检：toIndexText("${probe}") = "${toIndexText(probe)}"`)
  const sanity = searchLaborKb(probe, { limit: 3 })
  console.log(`[labor-books] 检索自检："${probe}" 命中 ${sanity.length} 条${sanity.length ? `，首条=${sanity[0].title}` : ''}`)

  close()
}

main().catch((error) => {
  console.error('[labor-books] 导入失败:', error.message || error)
  close()
  process.exit(1)
})
