import { extensionForFile } from './upload-config.js'
import { prepareOcrImage } from './ocr-preprocessing.js'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, extname, basename, dirname, delimiter } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { finalizeDocument } from './document-materials.js'
import { extractSpreadsheet, extractPresentation, openOfficeZip, appendImage, decodeDocumentBuffer } from './office-material-parser.js'

const execFileAsync = promisify(execFile)
const PLAIN_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm'])
const OFFICE_TEXT_EXTENSIONS = new Set(['.rtf', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp'])
const MACOS_TEXTUTIL_EXTENSIONS = new Set(['.rtf', '.odt'])

/**
 * 主入口：从上传文件 Buffer 中提取文本
 * @param {{ buffer: Buffer, originalname: string, mimetype: string }} file
 * @returns {Promise<{ text: string, pageCount: number|null, metadata: object }>}
 */
export async function extractText(file, options = {}) {
  options.signal?.throwIfAborted()
  if (file.preparseError) throw file.preparseError
  if (file.preparsed) return file.preparsed
  return finalizeDocument(await extractRawText(file, options), file)
}

async function recognizeDefaultImage(file, options = {}) {
  if (options.ocrInProcess || options.createOcrWorker) return extractImageText(file, options)
  const { recognizeIsolatedImage } = await import('./ocr-process.js')
  return recognizeIsolatedImage(file, options)
}

async function extractRawText(file, options = {}) {
  options.signal?.throwIfAborted()
  const extension = extensionForFile(file)
  if (!extname(file.originalname || '') && extension) file = { ...file, originalname: `document${extension}` }
  const mimeType = extension ? '' : file.mimetype || ''

  if (extension === '.pdf' || mimeType === 'application/pdf') {
    return extractPdfText(file, options)
  }

  // The commercial-review UI exports a self-contained HTML document with a
  // .doc suffix. Read that generated format directly instead of invoking LO.
  if ((extension === '.doc' || mimeType === 'application/msword') && isHtmlDocument(file.buffer)) {
    return extractPlainText(file, '.html')
  }

  if (extension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      return await extractDocxText(file, options)
    } catch (error) {
      // .docx 解析失败时，检测是否为伪装的旧版 .doc 文件
      if (
        error.message.includes('end of central directory') ||
        error.message.includes('zip') ||
        isLegacyWord(file.buffer)
      ) {
        console.warn(`[file-parser] ${file.originalname} 可能是旧版 .doc 文件伪装为 .docx，尝试转换`)
        return extractLegacyDocText(file, options)
      }
      throw error
    }
  }

  if (extension === '.doc' || mimeType === 'application/msword' || isLegacyWord(file.buffer)) {
    return extractLegacyDocText(file, options)
  }

  if (['.xlsx', '.csv', '.tsv'].includes(extension)) return extractSpreadsheet(file, { ...options, recognizeImage: options.recognizeImage || recognizeDefaultImage })
  if (extension === '.pptx') return extractPresentation(file, { ...options, recognizeImage: options.recognizeImage || recognizeDefaultImage })

  if (PLAIN_TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/')) {
    return extractPlainText(file, extension)
  }

  if (OFFICE_TEXT_EXTENSIONS.has(extension)) {
    return extractOfficeDocumentText(file, extension)
  }

  if (isImage(extension, mimeType)) {
    return (options.recognizeImage || recognizeDefaultImage)(file, options)
  }

  throw new Error(`暂不支持的文件格式: ${extension || mimeType || '未知'}`)
}

/**
 * 提取 Word 原生批注与修订足迹，与合同正文分开处理。
 * 旧 .doc 先沿用正文解析的转换链路变为 .docx，再读取批注层。
 */
export async function extractWordAnnotations(file) {
  const extension = extname(file.originalname || '').toLowerCase()
  const mimeType = file.mimetype || ''
  const isDocx = extension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const isDoc = extension === '.doc' || mimeType === 'application/msword' || isLegacyWord(file.buffer)
  if (!isDocx && !isDoc) return emptyWordAnnotations()
  if (isDoc && !isLegacyWord(file.buffer) && isHtmlDocument(file.buffer)) return emptyWordAnnotations()

  try {
    // macOS textutil 转换 .doc 会丢弃 comments.xml；批注解析必须优先使用 LibreOffice。
    const docxBuffer = isDoc ? await convertLegacyDocToDocx(file, { preserveAnnotations: true }) : file.buffer
    return await parseDocxAnnotations(docxBuffer)
  } catch (error) {
    throw new Error(`Word 批注解析失败: ${error.message}`)
  }
}

/** 只移除被旧版 Word 转换器意外混入正文的完整批注行。 */
export function stripNativeCommentText(text, annotations = []) {
  const comments = new Set(annotations
    .map((annotation) => normalizeInlineText(annotation.text))
    .filter(Boolean))
  if (!comments.size) return String(text || '')
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !comments.has(normalizeInlineText(line)))
    .join('\n')
}

/**
 * PDF 文本提取
 */
async function extractPdfText(file, { signal, recognizeImage = recognizeDefaultImage } = {}) {
  let parser
  let abort
  try {
    const { PDFParse } = await import('pdf-parse')
    // Copy into a transferable Uint8Array; a pooled Node Buffer is not transferable.
    parser = new PDFParse({ data: new Uint8Array(file.buffer) })
    abort = () => { void parser.destroy().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    signal?.throwIfAborted()
    const data = await parser.getText()
    const pages = []
    const ocrRegions = [], ocrWords = [], unreadableParts = [], ocrWarnings = []
    for (const page of data.pages || []) {
      signal?.throwIfAborted()
      if (page.text?.trim()) {
        let text = page.text
        const metadata = { warnings: [], unreadableParts: [], ocrRegions: [] }
        try {
          const extracted = await parser.getImage({ partial: [page.num], imageThreshold: 0, imageDataUrl: false, imageBuffer: true })
          const images = extracted.pages.flatMap((item) => item.images)
          for (const [index, image] of images.entries()) text += await appendImage(Buffer.from(image.data), {
            kind: 'pdf-image', page: page.num, imageIndex: index, label: `第${page.num}页内嵌图片${index + 1}` }, recognizeImage, metadata, signal)
        } catch (error) { signal?.throwIfAborted(); metadata.unreadableParts.push(`第${page.num}页图片未读取成功：${String(error.message).slice(0, 100)}`) }
        ocrRegions.push(...metadata.ocrRegions); unreadableParts.push(...metadata.unreadableParts)
        ocrWords.push(...(metadata.ocrWords || [])); ocrWarnings.push(...metadata.warnings)
        pages.push({ page: page.num, text, method: metadata.ocrRegions.length || text !== page.text ? 'text+ocr' : 'text' })
        continue
      }
      // Render one empty-text page at a time; never render a whole PDF into memory.
      try {
        const rendered = await parser.getScreenshot({ partial: [page.num], desiredWidth: 1800, imageDataUrl: false })
        const image = rendered.pages[0]
        const recognized = image ? await recognizeImage({ originalname: `${file.originalname} 第${page.num}页.png`, buffer: Buffer.from(image.data) }, { signal }) : null
        ocrRegions.push(...(recognized?.metadata?.ocrRegions || []).map((region) => ({ ...region,
          id: `page-${page.num}-${region.id}`, origin: { kind: 'pdf-page', page: page.num, width: 1800 } })))
        ocrWords.push(...(recognized?.metadata?.ocrWords || []).map((word)=>({...word,origin:{kind:'pdf-page',page:page.num,width:1800}})))
        ocrWarnings.push(...(recognized?.metadata?.warnings || []).filter((warning)=>!warning.startsWith('本文件使用OCR识别')).map((warning)=>`第${page.num}页：${warning}`))
        pages.push({ page: page.num, text: recognized?.text || '', method: 'ocr', confidence: recognized?.metadata?.confidence ?? null })
      } catch (error) {
        signal?.throwIfAborted()
        // Preserve readable pages even when another scan cannot be recognized.
        pages.push({ page: page.num, text: '', method: 'ocr', error: String(error.message || '').slice(0, 180) })
      }
    }
    let text = ''
    const sections = []
    for (const page of pages.filter((p) => p.text.trim())) {
      if (text) text += '\n\n'
      const start = text.length
      text += `【第${page.page}页${page.method !== 'text' ? '，OCR识别待核对' : ''}】\n${page.text}`
      sections.push({ start, end: text.length, source: { page: page.page, method: page.method } })
    }
    return {
      text,
      pageCount: data.total || pages.length,
      metadata: { pages, sections, ocrRegions, ocrWords, unreadableParts, warnings: [...ocrWarnings,...pages.filter((page) => !page.text.trim() || page.method !== 'text').map((page) =>
        !page.text.trim() || (page.confidence != null && Number(page.confidence) < 82)
          ? `第${page.page}页未读取成功或OCR置信度较低，请核对原件中的日期、金额及请求。`
          : `第${page.page}页使用OCR识别，请核对原件中的姓名、日期、金额及请求；识别置信度不代表逐字准确。`)] }
    }
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(`PDF 解析失败: ${error.message}`)
  } finally {
    signal?.removeEventListener('abort', abort)
    await parser?.destroy().catch(() => {})
  }
}

/**
 * DOCX 文本提取
 */
async function extractDocxText(file, options = {}) {
  try {
    const zip = await openOfficeZip(file.buffer, 'word/document.xml')
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: file.buffer })

    if (result.messages?.length) {
      const warnings = result.messages.filter((m) => m.type === 'warning')
      if (warnings.length) {
        console.warn(`[file-parser] DOCX warnings:`, warnings.map((m) => m.message).join('; '))
      }
    }

    const xml = await zip.file('word/document.xml').async('string')
    if (!/<w:tbl\b|<(?:\w+:)?(?:drawing|pict)\b/.test(xml)) return { text: result.value || '', pageCount: null, metadata: { format: 'docx' } }
    const metadata = { format: 'docx', warnings: [], unreadableParts: [], ocrRegions: [] }
    const images = []
    const marker = `FAFEE_${randomUUID()}_IMAGE_`
    const converted = await mammoth.convertToHtml({ buffer: file.buffer }, { externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        const buffer = await image.readAsBuffer()
        const entry = Object.values(zip.files).find((item) => item.name.startsWith('word/media/') && !item.dir)
        const index = images.length
        images.push({ buffer, entry, index })
        return { src: `fafee-image-${index}` }
      }) })
    let html = converted.value
    for (const image of images) html = html.replace(new RegExp(`<img\\b[^>]*src="fafee-image-${image.index}"[^>]*>`, 'g'), `\n${marker}${image.index}_END\n`)
    let text = stripMarkup(html.replace(/<\/(?:td|th)>/g, '\t'))
    for (const image of images) {
      let path = ''
      for (const entry of Object.values(zip.files).filter((entry) => entry.name.startsWith('word/media/') && !entry.dir)) {
        if ((await entry.async('nodebuffer')).equals(image.buffer)) { path = entry.name; break }
      }
      const imageText = await appendImage(image.buffer, { kind: 'zip-image', path, label: `Word内嵌图片${image.index + 1}` }, options.recognizeImage || recognizeDefaultImage, metadata, options.signal)
      image.text = imageText
      text = text.replaceAll(`${marker}${image.index}_END`, imageText)
    }
    if (/<(?:td|th)\b[^>]*(?:rowspan|colspan)=/.test(html)) metadata.warnings.push('Word含合并单元格，请核对行列适用关系。')
    if (/<(?:\w+:)?(?:drawing|pict)\b/.test(xml) && !images.length) metadata.unreadableParts.push('Word包含绘图或链接图片，未提取到图片，请核对原件。')
    metadata.sections = []
    let tableIndex = 0, searchFrom = 0
    for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
      let tableText = stripMarkup(table[0].replace(/<\/(?:td|th)>/g, '\t'))
      for (const image of images) tableText = tableText.replaceAll(`${marker}${image.index}_END`, image.text)
      const start = text.indexOf(tableText, searchFrom)
      const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      const header = rows.slice(0, 3).map((row) => stripMarkup(row[1].replace(/<\/(?:td|th)>/g, '\t'))).join('\n')
      if (start >= 0) { metadata.sections.push({ start, end: start + tableText.length, header, source: { table: ++tableIndex } }); searchFrom = start + tableText.length }
    }
    if (!result.value.trim() && !metadata.imageTextLength) text = ''
    metadata.embeddedImages = images.length
    metadata.warnings.push(...converted.messages.map((item) => item.message))
    return { text, pageCount: null, metadata }
  } catch (error) {
    throw new Error(`DOCX 解析失败: ${error.message}`)
  }
}

/**
 * 旧版 DOC 转换 + 提取
 */
async function extractLegacyDocText(file, options = {}) {
  const originalName = file.originalname || 'document.doc'
  const safeBaseName = sanitizeFilename(basename(originalName, extname(originalName)) || 'document')
  const docxBuffer = await convertLegacyDocToDocx(file)
  return extractDocxText({ buffer: docxBuffer, originalname: `${safeBaseName}.docx`, mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, options)
}

/**
 * RTF、OpenDocument、Excel 与 PowerPoint 使用系统可用的文档转换器提取文本。
 * LibreOffice 能保持跨平台一致；macOS 上 RTF/ODT 还能直接由 textutil 处理。
 */
async function extractOfficeDocumentText(file, extension) {
  let text
  try {
    text = await convertDocumentToText(file, extension)
  } catch (error) {
    // RTF 是文本容器，转换器对历史编码文件可能返回空内容；可安全回退到控制字解析。
    if (extension !== '.rtf') throw error
    text = extractRtfText(file.buffer)
    if (!text) throw error
    console.warn(`[file-parser] RTF converter fallback used for ${file.originalname}`)
  }
  return {
    text,
    pageCount: null,
    metadata: { format: extension.slice(1), converted: true }
  }
}

function extractRtfText(buffer) {
  return decodeTextBuffer(buffer)
    .replace(/\\par[d]?\b/gi, '\n')
    .replace(/\\line\b/gi, '\n')
    .replace(/\\tab\b/gi, '\t')
    .replace(/\\u(-?\d+)[^\\{}]?/g, (_, value) => String.fromCharCode((Number(value) + 65536) % 65536))
    .replace(/\\'([0-9a-f]{2})/gi, (_, value) => String.fromCharCode(parseInt(value, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/\\[^a-z]/gi, '')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function convertDocumentToText(file, extension) {
  const tempDir = await mkdtemp(join(tmpdir(), 'office-text-'))
  const originalName = file.originalname || `document${extension}`
  const safeBaseName = sanitizeFilename(basename(originalName, extname(originalName)) || 'document')
  const normalizedExtension = OFFICE_TEXT_EXTENSIONS.has(extension) ? extension : '.doc'
  const inputPath = join(tempDir, `${safeBaseName}${normalizedExtension}`)
  const outputPath = join(tempDir, `${safeBaseName}.txt`)

  try {
    await writeFile(inputPath, file.buffer)
    if (process.platform === 'darwin' && MACOS_TEXTUTIL_EXTENSIONS.has(normalizedExtension)) {
      await execFileAsync('textutil', ['-convert', 'txt', '-encoding', 'UTF-8', inputPath, '-output', outputPath], { timeout: 60000 })
    } else {
      await runLibreOfficeConversion(inputPath, tempDir, 'txt:Text')
    }
    const text = decodeTextBuffer(await readFile(outputPath))
    if (!text.trim()) throw new Error('转换后未提取到文字')
    return text
  } catch (error) {
    throw new Error(`${extension.slice(1).toUpperCase()} 解析失败: ${error.message}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function convertLegacyDocToDocx(file, { preserveAnnotations = false } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'doc-parse-'))
  const originalName = file.originalname || 'document.doc'
  const safeBaseName = sanitizeFilename(basename(originalName, extname(originalName)) || 'document')
  const inputPath = join(tempDir, `${safeBaseName}.doc`)
  const outputPath = join(tempDir, `${safeBaseName}.docx`)

  try {
    await writeFile(inputPath, file.buffer)

    if (preserveAnnotations) {
      await runLibreOfficeConversion(inputPath, tempDir)
    } else if (process.platform === 'darwin') {
      try {
        await execFileAsync('textutil', ['-convert', 'docx', inputPath, '-output', outputPath], { timeout: 60000 })
      } catch (textutilError) {
        // 部分旧版编码/复合文档不被 textutil 接受，回退到 LibreOffice。
        console.warn(`[file-parser] textutil 转换失败，尝试 LibreOffice: ${textutilError.message}`)
        await runLibreOfficeConversion(inputPath, tempDir)
      }
    } else {
      await runLibreOfficeConversion(inputPath, tempDir)
    }

    return await readFile(outputPath)
  } catch (error) {
    throw new Error(`旧版 Word .doc 转换失败，请先另存为 .docx 后再上传: ${error.message}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function parseDocxAnnotations(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const commentsFile = zip.file('word/comments.xml')
  const documentFile = zip.file('word/document.xml')
  if (!commentsFile || !documentFile) return emptyWordAnnotations()

  const [commentsXml, documentXml] = await Promise.all([commentsFile.async('string'), documentFile.async('string')])
  const rangeAnchors = extractCommentRangeAnchors(documentXml)
  const paragraphAnchors = extractCommentParagraphAnchors(documentXml)
  const comments = []
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = xmlAttribute(match[1], 'id')
    const text = extractXmlText(match[2])
    if (!id || !text) continue
    comments.push({
      id,
      author: xmlAttribute(match[1], 'author'),
      date: xmlAttribute(match[1], 'date'),
      text,
      // 整段锚点比局部选中文字更适合审核阶段对照；没有批注引用时再回退到选中区间。
      anchor: paragraphAnchors.get(id) || rangeAnchors.get(id) || ''
    })
  }

  return {
    comments,
    revisions: {
      insertions: (documentXml.match(/<w:ins\b/g) || []).length,
      deletions: (documentXml.match(/<w:del\b/g) || []).length
    }
  }
}

function emptyWordAnnotations() {
  return { comments: [], revisions: { insertions: 0, deletions: 0 } }
}

function extractCommentRangeAnchors(documentXml) {
  const activeIds = new Set()
  const anchors = new Map()
  const tokenPattern = /<w:commentRangeStart\b([^>]*)\/>|<w:commentRangeEnd\b([^>]*)\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<\/w:p>/g
  for (const match of documentXml.matchAll(tokenPattern)) {
    if (match[1] !== undefined) {
      const id = xmlAttribute(match[1], 'id')
      if (id) {
        activeIds.add(id)
        if (!anchors.has(id)) anchors.set(id, '')
      }
      continue
    }
    if (match[2] !== undefined) {
      activeIds.delete(xmlAttribute(match[2], 'id'))
      continue
    }
    const value = match[3] !== undefined
      ? decodeXmlEntities(match[3])
      : match[0].startsWith('</w:p') ? '\n' : ' '
    for (const id of activeIds) anchors.set(id, `${anchors.get(id) || ''}${value}`)
  }
  return new Map([...anchors].map(([id, text]) => [id, normalizeInlineText(text)]).filter(([, text]) => text))
}

function extractCommentParagraphAnchors(documentXml) {
  const anchors = new Map()
  for (const paragraph of documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const text = extractXmlText(paragraph[1])
    if (!text) continue
    for (const reference of paragraph[1].matchAll(/<w:commentReference\b([^>]*)\/>/g)) {
      const id = xmlAttribute(reference[1], 'id')
      if (id && !anchors.has(id)) anchors.set(id, text)
    }
  }
  return anchors
}

function extractXmlText(xml) {
  return normalizeInlineText([...String(xml || '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlEntities(match[1]))
    .join(''))
}

function xmlAttribute(attributes, name) {
  return decodeXmlEntities(String(attributes || '').match(new RegExp(`\\bw:${name}="([^"]*)"`, 'i'))?.[1] || '')
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/**
 * 图片 OCR 文本提取
 */
async function extractPlainText(file, extension) {
  const source = decodeTextBuffer(file.buffer)
  const text = ['.html', '.htm', '.xml'].includes(extension) ? stripMarkup(source) : source
  return {
    text,
    pageCount: null,
    metadata: { format: extension.slice(1) || 'text' }
  }
}

function decodeTextBuffer(buffer) { return decodeDocumentBuffer(Buffer.from(buffer || [])) }

function stripMarkup(source) {
  return decodeXmlEntities(String(source || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim()
}

/**
 * 图片 OCR：按字高处理小字，清晰文字保留原尺寸；局部重识别仅保存候选，不改写正文。
 * Jimp 为纯 JavaScript 依赖，避免部署时编译原生图像库。
 */
async function extractImageText(file, { signal, createOcrWorker } = {}) {
  let abort
  let worker
  try {
    signal?.throwIfAborted()
    const createWorker = createOcrWorker || (await import('tesseract.js')).createWorker
    console.log(`[file-parser] Starting OCR for: ${file.originalname}`)

    let imageBuffer = file.buffer
    let preprocessed = false
    let scaleX = 1, scaleY = 1, originalWidth = 0, originalHeight = 0, processedWidth = 0, processedHeight = 0, lineHeight = null
    try {
      const image = await prepareOcrImage(file.buffer)
      originalWidth = image.originalWidth; originalHeight = image.originalHeight
      processedWidth = image.width; processedHeight = image.height; lineHeight = image.lineHeight
      scaleX = image.scaleX; scaleY = image.scaleY; imageBuffer = image.buffer
      preprocessed = true
    } catch (error) {
      if (String(error.message).includes('像素超限')) throw error
      // 解码失败时仍交给 Tesseract 处理原始格式，避免预处理阻断可识别图片。
      console.warn(`[file-parser] Image preprocessing skipped for ${file.originalname}: ${error.message}`)
    }

    // Initialization may load language resources. Stop waiting immediately on cancel,
    // and release a worker that finishes initializing after the task has stopped.
    const initializing = Promise.resolve(createWorker(['eng', 'chi_sim']))
    let abortInitialization
    try {
      worker = signal ? await Promise.race([initializing, new Promise((_, reject) => {
        abortInitialization = () => reject(signal.reason || new Error('OCR 初始化已停止'))
        if (signal.aborted) abortInitialization()
        else signal.addEventListener('abort', abortInitialization, { once: true })
      })]) : await initializing
    } catch (error) {
      void initializing.then((lateWorker) => lateWorker.terminate()).catch(() => {})
      throw error
    } finally {
      if (abortInitialization) signal.removeEventListener('abort', abortInitialization)
    }
    abort = () => { void worker.terminate().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    let data
    const alternates = [], retryWarnings = []
    try {
      signal?.throwIfAborted()
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', user_defined_dpi: '300' })
      const primary = (await worker.recognize(imageBuffer, {}, { text: true, blocks: true })).data
      data = primary
      const lines = ocrLines(primary)
      const eligibleLines = lines.filter((line) => isCriticalOcrText(line.text) || line.words.some((word) => word.confidence < 82))
        .sort((a,b) => Number(b.words.some((word) => word.confidence < 82)) - Number(a.words.some((word) => word.confidence < 82)))
      const retryLines = eligibleLines.slice(0,4)
      if(eligibleLines.length > retryLines.length) retryWarnings.push('可疑行较多，本次仅补读最多4行；其余已标记文字仍需对照原图核对。')
      for (const line of retryLines) {
        signal?.throwIfAborted()
        const box = line.bbox
        if(!box || !processedWidth || !processedHeight) continue
        const left = Math.max(0,Math.floor(box.x0)-6), top = Math.max(0,Math.floor(box.y0)-6)
        const rectangle = {left,top,width:Math.min(processedWidth-left,Math.ceil(box.x1)-left+6),height:Math.min(processedHeight-top,Math.ceil(box.y1)-top+6)}
        if(rectangle.width <= 0 || rectangle.height <= 0) continue
        line.rectangle = rectangle
        try {
          await worker.setParameters({tessedit_pageseg_mode:'7',preserve_interword_spaces:'1',user_defined_dpi:'300'})
          const alternate = (await worker.recognize(imageBuffer,{rectangle},{text:true,blocks:true})).data
          alternates.push({...alternate,bounds:box,primaryLine:line.text})
        } catch {
          signal?.throwIfAborted()
          retryWarnings.push('部分局部OCR核对未完成，保留第一次识别文字，请对照原图核对。')
        }
      }
      // A low-confidence Chinese name may be read as Latin letters by the
      // bilingual model. Keep a Chinese-only local candidate, never replace it.
      const chineseLines = retryLines.filter((line)=>line.rectangle && /[\u4e00-\u9fff]/.test(line.text) && line.words.some((word)=>word.confidence<82))
      if(chineseLines.length && typeof worker.reinitialize === 'function') {
        try {
          await worker.reinitialize('chi_sim')
          await worker.setParameters({tessedit_pageseg_mode:'7',preserve_interword_spaces:'1',user_defined_dpi:'300'})
          for(const line of chineseLines) {
            signal?.throwIfAborted()
            const alternate = (await worker.recognize(imageBuffer,{rectangle:line.rectangle},{text:true,blocks:true})).data
            alternates.push({...alternate,bounds:line.bbox,primaryLine:line.text})
          }
        } catch {
          signal?.throwIfAborted()
          retryWarnings.push('中文局部候选读取未完成，请直接对照原图核对姓名等文字。')
        }
      }
      if (!lines.length && Number(primary?.confidence || 0) < 82) {
        try {
          await worker.setParameters({tessedit_pageseg_mode:'11',preserve_interword_spaces:'1',user_defined_dpi:'300'})
          alternates.push((await worker.recognize(imageBuffer,{},{text:true,blocks:true})).data)
        } catch {
          signal?.throwIfAborted()
          retryWarnings.push('补充OCR核对未完成，保留第一次识别文字，请对照原图核对。')
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      await worker.terminate().catch(() => {})
    }
    signal?.throwIfAborted()

    if (!(data?.blocks || []).length && Number(data?.confidence || 0) < 82 && originalWidth && originalHeight) {
      data.blocks = [{ paragraphs: [{ lines: [{ words: [{ text: data.text || '未识别文字', confidence: data.confidence || 0,
        bbox: { x0: 0, y0: 0, x1: originalWidth * scaleX, y1: originalHeight * scaleY } }] }] }] }]
    }
    const text = normalizeOcrText(data?.text || '')
    const recordedWords = ocrLines(data).flatMap((line)=>line.words)
    if(recordedWords.length > 10000) retryWarnings.push('OCR词级记录超过10000项，核对记录只保留前10000项；正文未截断，请对照原件核对其余文字。')
    console.log(`[file-parser] OCR completed, text length: ${text.length}`)

    return {
      text,
      pageCount: null,
      metadata: {
        format: 'image',
        confidence: data?.confidence ?? null,
        originalWidth, originalHeight, scaleX, scaleY, lineHeight, preprocessingStrategy:'adaptive-text-height',
        ocrWords: recordedWords.slice(0,10000).map((word) => ({text:word.text,confidence:word.confidence,
          bbox:{x0:word.bbox.x0/scaleX,y0:word.bbox.y0/scaleY,x1:word.bbox.x1/scaleX,y1:word.bbox.y1/scaleY}})),
        ocrRegions: (data?.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((line) => (line.words || []).map((word) => ({ ...word,
          criticalLine: isCriticalOcrText(line.text || (line.words || []).map((w) => w.text).join('')) })))))
          .filter((word) => word.bbox && (word.criticalLine || word.confidence < 82 || isCriticalOcrText(word.text)))
          .slice(0, 10000).map((word, index) => {
            const candidates = ocrWordAlternatives(word,alternates,data.text)
            return { id: `word-${index}`, text: word.text, confidence: word.confidence,
            bbox: { x0: word.bbox.x0 / scaleX, y0: word.bbox.y0 / scaleY, x1: word.bbox.x1 / scaleX, y1: word.bbox.y1 / scaleY },
            origin: { kind: 'file-image' }, candidates,
            reason: candidates.length ? '两次识别结果有差异' : word.confidence < 82 ? '识别置信度偏低' : '关键文字待核对' }}),
        languages: 'eng+chi_sim',
        preprocessed,
        warnings: [...new Set(['本文件使用OCR识别，请核对原件中的姓名、日期、金额及请求；识别置信度不代表逐字准确。', ...retryWarnings])]
      }
    }
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(`图片 OCR 识别失败: ${error.message}`)
  }
}


const isCriticalOcrText = (text) => /[0-9０-９]|姓名|员工|工资|金额|期限|不得|不能|可以|日期|解除|补偿|应当|\b(?:employee|name|salary|amount|term|date|not|must|pay)\b/i.test(text || '')
const overlapsOcrBox = (a,b) => a && b && Math.min(a.x1,b.x1)>Math.max(a.x0,b.x0) && Math.min(a.y1,b.y1)>Math.max(a.y0,b.y0)
function ocrLines(data) {
  return (data?.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => (p.lines || []).map((line) => {
    const words = (line.words || []).filter((word) => word.bbox)
    const bbox = line.bbox || (words.length ? {x0:Math.min(...words.map((w)=>w.bbox.x0)),y0:Math.min(...words.map((w)=>w.bbox.y0)),
      x1:Math.max(...words.map((w)=>w.bbox.x1)),y1:Math.max(...words.map((w)=>w.bbox.y1))} : null)
    return {...line,words,bbox,text:line.text || words.map((word)=>word.text).join('')}
  })))
}
function ocrWordAlternatives(word, alternates, primaryText) {
  const values = alternates.flatMap((alternate) => {
    if (!alternate || alternate.text === primaryText || (alternate.bounds && !overlapsOcrBox(word.bbox,alternate.bounds))) return []
    const text = normalizeOcrText(alternate.text)
    if(text.replace(/\s/g,'') === String(alternate.primaryLine || '').replace(/\s/g,'')) return []
    if(text.length <= 160) return text ? [text] : []
    return ocrLines(alternate).flatMap((line)=>line.words).filter((candidate)=>candidate.text!==word.text && overlapsOcrBox(candidate.bbox,word.bbox)).map((candidate)=>candidate.text)
  })
  return [...new Set(values)].slice(0,3)
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- Helpers ---

function isImage(extension, mimeType) {
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.gif']
  return imageExts.includes(extension) || mimeType.startsWith('image/')
}

function isLegacyWord(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  )
}

function isHtmlDocument(buffer) {
  if (isLegacyWord(buffer)) return false
  let prefix
  try { prefix = decodeTextBuffer(Buffer.from(buffer || []).subarray(0, 4096)).trimStart() }
  catch { return false }
  return /^(?:<!doctype\s+html\b|<html\b|<\?xml[\s\S]*?<html\b)/i.test(prefix)
}

async function runLibreOfficeConversion(inputPath, outputDir, outputFormat = 'docx') {
  // Each conversion has its own profile so concurrent uploads do not reuse a
  // running desktop process or compete for LibreOffice's user-profile lock.
  const profileUrl = pathToFileURL(join(outputDir, 'lo-profile')).href
  const args = [`-env:UserInstallation=${profileUrl}`, '--headless', '--convert-to', outputFormat, '--outdir', outputDir, inputPath]
  const commands = [String(process.env.LIBREOFFICE_BIN || '').trim(), 'libreoffice', 'soffice']
  if (process.platform === 'win32') {
    const installRoots = [process.env.LIBREOFFICE_HOME, 'E:\\LibreOffice'].filter(Boolean)
    for (const root of installRoots) {
      commands.push(join(root, 'program', 'soffice.com'), join(root, 'program', 'soffice.exe'))
      commands.push(join(root, 'soffice.com'), join(root, 'soffice.exe'))
    }
    for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (programFiles) {
        commands.push(join(programFiles, 'LibreOffice', 'program', 'soffice.com'))
        commands.push(join(programFiles, 'LibreOffice', 'program', 'soffice.exe'))
      }
    }
  }

  let missingCommandError = null
  for (const command of [...new Set(commands.filter(Boolean))]) {
    try {
      const commandDirectory = dirname(command)
      const env = process.platform === 'win32' && commandDirectory !== '.'
        ? { ...process.env, PATH: [commandDirectory, process.env.PATH].filter(Boolean).join(delimiter) }
        : process.env
      await execFileAsync(command, args, { timeout: 60000, env, windowsHide: true })
      return
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        missingCommandError ||= error
        continue
      }
      throw new Error(`LibreOffice 转换失败：${error.message || '转换进程异常'}`)
    }
  }

  const detail = String(missingCommandError?.message || '未找到可执行文件').slice(0, 240)
  throw new Error(`当前服务进程找不到 LibreOffice（${detail}）。请将其加入启动服务时的 PATH，设置 LIBREOFFICE_BIN 指向 soffice 可执行文件，或设置 LIBREOFFICE_HOME 为安装目录；也可将 .doc 另存为 .docx 后上传。`)
}

function sanitizeFilename(name) {
  return name
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'document'
}
