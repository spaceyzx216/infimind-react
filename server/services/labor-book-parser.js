/**
 * 用工风险实务书籍解析器。
 *
 * 输入：从 .docx 提取的纯文本（每行一段，含目录区、重复页眉、页码）
 * 输出：结构化的风险问答条目 [{ book, chapter, section, subsection, questionNo, title, content }]
 *
 * 原文结构（五册一致）：
 *   目录
 *   第一章 xxx                      ← 章
 *   一、xxx                         ← 节
 *   （一）xxx                       ← 小节
 *   【问题N】xxx ... 12             ← 目录行（结尾带页码）
 *   …（目录区结束，正文开始）
 *   【问题N】xxx                    ← 正文条目（结尾无页码）
 *   （答案正文，可能被页眉与页码打断）
 *
 * 三个关键设计：
 *   1. **层级来自目录，而不是正文**。正文里会引用法条原文，而法条本身也用「（一）（二）」编号，
 *      若在正文里识别层级标题，会把答案从中间截断（实测会产生 25 字左右的残缺条目）。
 *      改为：先解析目录得到「问题 → 章/节/小节」映射，再按顺序贴回正文条目。
 *   2. **正文只按【问题N】切分**，其余行全部归入答案正文，从根本上避免截断。
 *   3. **剥离重复页眉与页码**，并按句末标点修复跨页断句——
 *      页眉插在句子中间会把"经济"切成"工经/济也"，使 2-gram 索引丢失该词。
 */

/** 句末/段末标点：以此为界切分段落 */
const SENTENCE_END = /[。！？；：…”』」）)\]】]$/
/** 章标题：第一章 xxx */
const CHAPTER_PATTERN = /^第[一二三四五六七八九十百零〇\d]+章[\s、.．:：]/
/** 节标题：一、xxx */
const SECTION_PATTERN = /^[一二三四五六七八九十]+、\s*\S/
/** 小节标题：（一）xxx */
const SUBSECTION_PATTERN = /^[（(][一二三四五六七八九十]+[）)]\s*\S/
/** 正文问答标记：【问题12】xxx */
const QUESTION_PATTERN = /^[【\[]\s*问题\s*(\d+)\s*[】\]]\s*(.*)$/
/** 纯页码行 */
const PAGE_NUMBER_PATTERN = /^[-—–\s]*\d{1,4}[-—–\s]*$/
/** 列表项：1、xxx / 1.xxx / （1）xxx（必须带真实序号标记，避免「2021年…」被误判） */
const LIST_ITEM_PATTERN = /^(?:[（(]\d{1,3}[）)]|\d{1,3}[、.．])\s*\S/

/**
 * 识别重复出现的页眉/页脚行。
 * @param {string[]} lines
 * @param {{ minRepeat?: number }} options
 * @returns {Set<string>}
 */
export function detectRunningHeaders(lines, { minRepeat = 5 } = {}) {
  const freq = new Map()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length < 8 || trimmed.length > 70) continue
    freq.set(trimmed, (freq.get(trimmed) || 0) + 1)
  }
  const headers = new Set()
  for (const [line, count] of freq) {
    if (count >= minRepeat) headers.add(line)
  }
  return headers
}

/** 去掉目录行尾部的页码与引导符号 */
const stripPageNumber = (text) => String(text || '')
  .replace(/[\s.．·…_—\-]+$/g, '')
  .replace(/[\s.．·…_—\-]*\d{1,4}$/g, '')
  .trim()

/** 目录里的问题行结尾带页码（如「……区别？22」）；正文问题行不带 */
const isTocQuestionLine = (line) => /[\s.．·…_—\-]*\d{1,4}$/.test(String(line || '').trim())

const normalizeTitle = (text) => String(text || '')
  .replace(/[\s　]+/g, '')
  .replace(/[，。、；：？！,.;:?!“”‘’"'（）()【】\[\]]/g, '')
  .toLowerCase()

/**
 * 定位正文起点：最后一个"目录样式"问题行之后即为正文。
 * 不能"遇到第一个不带页码的问题行就停"——目录里存在页码换行的条目，
 * 那样的条目看起来与正文一致，会提前终止目录解析（实测第二册只解析出 21 条目录记录）。
 * @returns {number}
 */
function findBodyStart(lines) {
  let lastToc = -1
  let firstQuestion = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    const question = line.match(QUESTION_PATTERN)
    if (!question) continue
    if (firstQuestion < 0) firstQuestion = index
    if (isTocQuestionLine(question[2])) lastToc = index
  }
  if (lastToc >= 0) return lastToc + 1
  return firstQuestion >= 0 ? firstQuestion : 0
}

/**
 * 解析目录区，得到「问题 → 章/节/小节」的有序映射。
 * @returns {Array}
 */
function parseToc(lines, bodyStart, headers) {
  const records = []
  let chapter = ''
  let section = ''
  let subsection = ''

  for (let index = 0; index < bodyStart; index += 1) {
    const line = lines[index].trim()
    if (!line || headers.has(line)) continue

    const question = line.match(QUESTION_PATTERN)
    if (question) {
      records.push({
        questionNo: `问题${question[1]}`,
        title: stripPageNumber(question[2]),
        chapter, section, subsection
      })
      continue
    }

    // 目录里的章/节/小节标题通常也带页码
    const heading = stripPageNumber(line)
    if (!heading || heading.length > 60) continue
    if (CHAPTER_PATTERN.test(heading)) {
      chapter = heading
      section = ''
      subsection = ''
      continue
    }
    if (SECTION_PATTERN.test(heading)) {
      section = heading
      subsection = ''
      continue
    }
    if (SUBSECTION_PATTERN.test(heading)) {
      subsection = heading
    }
  }
  return records
}

/**
 * 解析正文区，按【问题N】切分条目。
 * @returns {Array<{questionNo:string,title:string,content:string}>}
 */
function parseBody(lines, bodyStart, headers) {
  const entries = []
  let current = null
  let buffer = []
  let skippedHeaders = 0

  const flushParagraph = () => {
    if (!buffer.length) return
    const paragraph = buffer.join('').trim()
    buffer = []
    if (paragraph && current) current.paragraphs.push(paragraph)
  }

  const flushEntry = () => {
    flushParagraph()
    if (!current) return
    const content = current.paragraphs.join('\n').trim()
    if (content) entries.push({ questionNo: current.questionNo, title: current.title, content })
    current = null
  }

  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) { flushParagraph(); continue }
    if (PAGE_NUMBER_PATTERN.test(line)) continue
    if (headers.has(line)) { skippedHeaders += 1; continue }

    const question = line.match(QUESTION_PATTERN)
    if (question) {
      flushEntry()
      current = {
        questionNo: `问题${question[1]}`,
        title: stripPageNumber(question[2]),
        paragraphs: []
      }
      buffer = []
      continue
    }
    if (!current) continue

    // 跨页断句修复：上一行未以句末标点结束时与本行拼接
    const previous = buffer.length ? buffer[buffer.length - 1] : ''
    const startsListItem = LIST_ITEM_PATTERN.test(line)
    if (previous && !SENTENCE_END.test(previous) && !startsListItem) {
      buffer[buffer.length - 1] = previous + line
    } else {
      buffer.push(line)
    }
    if (SENTENCE_END.test(buffer[buffer.length - 1])) flushParagraph()
  }
  flushEntry()
  return { entries, skippedHeaders }
}

/**
 * 把目录里的层级映射贴回正文条目。
 * 优先按「问题号 + 标题」精确匹配；标题对不上时退化为按问题号顺序匹配。
 * @param {Array} bodyEntries
 * @param {Array} tocRecords
 */
function attachHierarchy(bodyEntries, tocRecords) {
  const used = new Set()
  const findByTitle = (entry) => {
    const target = normalizeTitle(entry.title)
    if (!target) return -1
    return tocRecords.findIndex((record, index) =>
      !used.has(index) && record.questionNo === entry.questionNo && normalizeTitle(record.title) === target)
  }
  const findByOrder = (entry) => tocRecords.findIndex((record, index) =>
    !used.has(index) && record.questionNo === entry.questionNo)

  return bodyEntries.map((entry) => {
    let index = findByTitle(entry)
    if (index < 0) index = findByOrder(entry)
    if (index >= 0) used.add(index)
    const record = index >= 0 ? tocRecords[index] : null
    return {
      ...entry,
      chapter: record?.chapter || '',
      section: record?.section || '',
      subsection: record?.subsection || ''
    }
  })
}

/**
 * 解析一册书。
 * @param {string} text  .docx 提取的纯文本
 * @param {{ book?: string }} options
 * @returns {{ entries: Array, stats: object, headers: string[] }}
 */
export function parseLaborBook(text, { book = '' } = {}) {
  const rawLines = String(text || '').split('\n')
  const headers = detectRunningHeaders(rawLines)
  const bodyStart = findBodyStart(rawLines)
  const records = parseToc(rawLines, bodyStart, headers)
  const { entries: bodyEntries, skippedHeaders } = parseBody(rawLines, bodyStart, headers)
  const entries = attachHierarchy(bodyEntries, records).map((entry) => ({ ...entry, book }))

  return {
    entries,
    headers: [...headers],
    stats: {
      book,
      totalLines: rawLines.length,
      bodyStartLine: bodyStart + 1,
      tocRecords: records.length,
      entries: entries.length,
      strippedHeaderLines: skippedHeaders,
      runningHeaders: headers.size,
      withHierarchy: entries.filter((entry) => entry.chapter).length
    }
  }
}

/** 从答案里提取裁判文书案号，便于把书中的真实案例单独标出 */
const CASE_NO_PATTERN = /[（(]\s*(?:19|20)\d{2}\s*[）)]\s*[\u4e00-\u9fffA-Za-z0-9]{1,12}\s*(?:民终|民初|民再|行终|行初|执|民申|刑终|民辖终)\s*\d{1,6}\s*号/g

/**
 * @param {string} content
 * @returns {string[]} 去重后的案号
 */
export function extractCaseNumbers(content) {
  return [...new Set(String(content || '').match(CASE_NO_PATTERN) || [])]
}

/** 归一化：去掉多余空行与首尾空白，压缩连续空格 */
export function normalizeContent(content) {
  return String(content || '')
    .replace(/[ \t\u3000]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
