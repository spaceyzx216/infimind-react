import { createHash } from 'node:crypto'
import { estimateTokens, CONTEXT_WINDOW_TOKENS, OUTPUT_RESERVE_TOKENS, CONTEXT_SAFETY_TOKENS } from '../../src/utils/context-budget.js'

export const HANDBOOK_UNIT_TOKENS = Math.min(6000, Math.floor((CONTEXT_WINDOW_TOKENS - OUTPUT_RESERVE_TOKENS - CONTEXT_SAFETY_TOKENS) / 8))
export const fingerprint = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

const heading = /^(?:第[一二三四五六七八九十百零〇\d]+[章节篇编]|[一二三四五六七八九十]+[、．.]|\d+(?:\.\d+)*[、．.]?\s+).{1,65}$/
const clause = /^(?:第[一二三四五六七八九十百零〇\d]+条|[（(][一二三四五六七八九十百\d]+[）)]|\d+[、．.])/u
const topicPatterns = [
  ['考勤工时', /考勤|旷工|迟到|早退|打卡|工时|加班|工作时间|出勤|缺勤|到岗|签到|刷卡/u],
  ['薪酬待遇', /工资|薪酬|奖金|扣款|薪资|报酬|经济损失|发薪|薪金|月薪/u],
  ['休假福利', /休假|病假|年假|产假|福利|社保|社会保险/u],
  ['奖惩解除', /违纪|处分|处罚|解除|辞退|离职|开除|奖惩/u],
  ['绩效岗位', /绩效|不胜任|考核|调岗|培训|岗位|工作能力/u],
  ['信息隐私', /个人信息|隐私|监控|保密|数据|网络|电脑|商业秘密|竞业限制/u],
  ['安全与平等', /安全|性骚扰|歧视|工伤|职业健康/u],
  ['制定告知', /民主程序|职工代表|工会|公示|告知|签收|生效|修订/u]
]
export const handbookTopics = (text) => topicPatterns.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic)

// Rank candidate blocks by the specific wording as well as the broad topic.
// IDF downweights shared boilerplate. This is lexical ranking, not vector search.
export function rankHandbookChunks(query, chunks) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/法定休假日/g, '法定节假日')
  const tokens = (value) => {
    const words = [...normalize(value).matchAll(/[\u4e00-\u9fff]+|[a-z0-9]+/g)].flatMap(([word]) =>
      /^[a-z0-9]+$/.test(word) ? [word] : Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2)))
    return new Set(words)
  }
  const wanted = tokens(query), topics = handbookTopics(query)
  const entries = chunks.map((chunk) => ({ chunk, terms: tokens(`${chunk.sectionTitle || ''}\n${chunk.text}`), titleTerms: tokens(chunk.sectionTitle) }))
  const frequencies = new Map()
  for (const { terms } of entries) for (const term of terms) frequencies.set(term, (frequencies.get(term) || 0) + 1)
  return entries.map(({ chunk, terms, titleTerms }, index) => {
    let score = chunk.topics.filter((topic) => topics.includes(topic)).length
    for (const term of wanted) if (terms.has(term)) score += Math.log(1 + entries.length / (frequencies.get(term) || 1)) * (titleTerms.has(term) ? 2 : 1)
    return { chunk, score, index }
  }).sort((left, right) => right.score - left.score || left.index - right.index)
}

// Every interval partitions the original text. No trimming or silent text loss.
function splitInterval(text, start, end, budget) {
  const intervals = []
  while (start < end) {
    if (estimateTokens(text.slice(start, end)) <= budget) { intervals.push([start, end]); break }
    let low = start + 1
    let high = end
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (estimateTokens(text.slice(start, middle)) <= budget) low = middle
      else high = middle - 1
    }
    let cut = Math.max(start + 1, low)
    const floor = start + Math.floor((cut - start) / 2)
    const newline = text.lastIndexOf('\n', cut - 1)
    if (newline >= floor) cut = newline + 1
    else {
      const punctuation = Math.max(...['。', '；', ';'].map((mark) => text.lastIndexOf(mark, cut - 1)))
      if (punctuation >= floor) cut = punctuation + 1
    }
    // Avoid cutting a UTF-16 surrogate pair.
    if (cut < end && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1
    if (cut <= start) cut = Math.min(end, start + 2)
    intervals.push([start, cut])
    start = cut
  }
  return intervals
}

export function buildHandbookStructure(documents, { budget = HANDBOOK_UNIT_TOKENS, headings = [] } = {}) {
  if (!Number.isFinite(budget) || budget < 32) throw new Error('员工手册分块预算无效')
  const chunks = []
  const sections = []
  for (const document of documents) {
    const text = String(document.text || '')
    if (!text.trim()) continue
    const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((match) => match[0])
    const starts = [{ start: 0, title: document.fileName || '提交正文' }]
    for (const match of lines) {
      const label = match[0].trim()
      if (heading.test(label) && !clause.test(label)) {
        if (match.index === 0) starts[0].title = label
        else starts.push({ start: match.index, title: label })
      }
    }
    for (const hint of headings.filter((item) => item.fileId === document.fileId)) {
      const line = lines.find((item) => item.index === hint.startOffset)
      if (!line || line[0].trim() !== hint.title || hint.title.length > 80 || clause.test(hint.title)) continue
      if (hint.startOffset === 0) starts[0].title = hint.title
      else if (!starts.some((item) => item.start === hint.startOffset)) starts.push({ start: hint.startOffset, title: hint.title })
    }
    starts.sort((a, b) => a.start - b.start)
    for (let sectionIndex = 0; sectionIndex < starts.length; sectionIndex += 1) {
      const { start, title } = starts[sectionIndex]
      const end = starts[sectionIndex + 1]?.start ?? text.length
      const sectionId = `${document.fileId}:section:${sectionIndex}`
      sections.push({ id: sectionId, fileId: document.fileId, title, startOffset: start, endOffset: end })
      const boundaries = [start, ...lines.filter((line) => line.index > start && line.index < end && clause.test(line[0].trim())).map((line) => line.index), end]
      let batchStart = start
      let batchEnd = start
      const publish = (from, to) => {
        for (const [begin, finish] of splitInterval(text, from, to, budget)) {
          const partText = text.slice(begin, finish)
          chunks.push({ id: `${document.fileId}:${begin}:${finish}`, fileId: document.fileId, fileName: document.fileName,
            sectionId, sectionTitle: title, startOffset: begin, endOffset: finish, text: partText,
            ...(/OCR识别待核对/.test(text) ? { sourceNeedsVerification: true } : {}),
            topics: handbookTopics(`${title}\n${partText}`) })
        }
      }
      for (let index = 0; index < boundaries.length - 1; index += 1) {
        const candidateEnd = boundaries[index + 1]
        if (batchEnd > batchStart && estimateTokens(text.slice(batchStart, candidateEnd)) > budget) {
          publish(batchStart, batchEnd)
          batchStart = batchEnd
        }
        batchEnd = candidateEnd
      }
      if (batchEnd > batchStart) publish(batchStart, batchEnd)
    }
    const joined = chunks.filter((chunk) => chunk.fileId === document.fileId).map((chunk) => chunk.text).join('')
    if (joined !== text) throw new Error('员工手册分块覆盖校验失败')
  }
  return { chunks, sections }
}

// Relationships are retrieval candidates, not a legal judgment. Every candidate pair
// is checked; the number of issues and relation checks is not capped.
export function retrieveHandbookRelations(chunks, modelLinks = []) {
  const pairs = new Map()
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const add = (left, right, reason) => {
    if (!left || !right || left.id === right.id) return
    const ordered = [left, right].sort((a, b) => a.id.localeCompare(b.id))
    const id = fingerprint(ordered.map((chunk) => chunk.id)).slice(0, 20)
    const pair = pairs.get(id) || { id, chunkIds: ordered.map((chunk) => chunk.id), reasons: [] }
    if (!pair.reasons.includes(reason)) pair.reasons.push(reason)
    pairs.set(id, pair)
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const left = chunks[index]
    for (const right of chunks.slice(index + 1)) {
      const shared = left.topics.filter((topic) => right.topics.includes(topic))
      if (shared.length) add(left, right, shared.join('、'))
      else if (left.sectionId === right.sectionId) add(left, right, '同一章节')
      if (right.sectionTitle.length > 2 && left.text.includes(right.sectionTitle)) add(left, right, '章节引用')
      if (left.sectionTitle.length > 2 && right.text.includes(left.sectionTitle)) add(left, right, '章节引用')
    }
  }
  for (const link of modelLinks) add(byId.get(link.from), byId.get(link.to), '语义关联')
  return [...pairs.values()]
}

export function locateHandbookQuote(quote, chunk) {
  const wanted = String(quote || '').replace(/\s/g, '')
  if (!wanted || !chunk) return { status: 'not-found', matches: [] }
  let normalized = ''
  const offsets = []
  for (let index = 0; index < chunk.text.length; index += 1) {
    if (!/\s/.test(chunk.text[index])) { normalized += chunk.text[index]; offsets.push(index) }
  }
  const matches = []
  let index = normalized.indexOf(wanted)
  while (index !== -1) {
    const startOffset = chunk.startOffset + offsets[index]
    const endOffset = chunk.startOffset + offsets[index + wanted.length - 1] + 1
    matches.push({ fileId: chunk.fileId, fileName: chunk.fileName, sectionTitle: chunk.sectionTitle,
      startOffset, endOffset, excerpt: chunk.text.slice(offsets[index], offsets[index + wanted.length - 1] + 1) })
    index = normalized.indexOf(wanted, index + 1)
  }
  return { status: matches.length === 1 ? 'found' : matches.length ? 'ambiguous' : 'not-found', matches }
}
