import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { Readable } from 'node:stream'
import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeOfficeNamespaces } from './office-xml-namespaces.js'

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues:false })
const ordered = new XMLParser({ ignoreAttributes: false, preserveOrder: true, parseTagValue: false, parseAttributeValue: false, trimValues:false })
const list = (v) => v == null ? [] : Array.isArray(v) ? v : [v]
export const imageHash = (buffer) => createHash('sha256').update(buffer).digest('hex')
export function parseOfficeXml(xml, preserveOrder = false) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('文档包含不支持的XML实体声明')
  return (preserveOrder ? ordered : parser).parse(normalizeOfficeNamespaces(xml))
}

// Inspect central-directory sizes before inflating any Office entries.
export async function openOfficeZip(buffer, requiredPart) {
  if (buffer.length < 22) throw new Error('Office文件损坏或不是ZIP文件')
  let position = buffer.length - 22
  const floor = Math.max(0, buffer.length - 65557)
  while (position >= floor && buffer.readUInt32LE(position) !== 0x06054b50) position--
  if (position < floor) throw new Error('Office文件损坏：缺少ZIP目录')
  const count = buffer.readUInt16LE(position + 10)
  let offset = buffer.readUInt32LE(position + 16), total = 0
  if (count > 10000) throw new Error('Office文件条目过多，请拆分')
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Office ZIP目录损坏')
    const size = buffer.readUInt32LE(offset + 24), packed = buffer.readUInt32LE(offset + 20)
    total += size
    if (size > 64 * 1024 * 1024 || total > 256 * 1024 * 1024 || (size > 1024 * 1024 && size / Math.max(1, packed) > 1000)) throw new Error('Office解压内容超限，请拆分')
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  const zip = await JSZip.loadAsync(buffer)
  if (requiredPart && !zip.file(requiredPart)) throw new Error(`文件内容与扩展名不一致：缺少${requiredPart}`)
  return zip
}

export function textNodes(nodes) {
  if (!nodes || typeof nodes !== 'object') return ''
  if (Array.isArray(nodes)) return nodes.map(textNodes).join('')
  return Object.entries(nodes).map(([key, value]) => key === '#text' ? String(value) : key === ':@' ? ''
    : /(?:^|:)t$/.test(key) ? textNodes(value) : /(?:^|:)br$/.test(key) ? '\n'
      : /(?:^|:)(p|tr)$/.test(key) ? `${textNodes(value)}\n` : /(?:^|:)tc$/.test(key) ? `${textNodes(value)}\t` : textNodes(value)).join('')
}

export function decodeDocumentBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer)
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer) }
    catch { throw new Error('文本编码无法识别，请另存为UTF-8后上传。') }
  }
}

async function appendImage(buffer, origin, recognizeImage, metadata, signal) {
  signal?.throwIfAborted()
  try {
    const result = await recognizeImage({ buffer, originalname: `${origin.label}.png`, mimetype: 'image/png' }, { signal })
    signal?.throwIfAborted()
    metadata.imageTextLength = (metadata.imageTextLength || 0) + (result.text?.trim().length || 0)
    metadata.warnings.push(`${origin.label}使用OCR识别，姓名、日期、金额及否定词待核对。`)
    metadata.warnings.push(...(result.metadata?.warnings || []).filter((warning)=>!warning.startsWith('本文件使用OCR识别')).map((warning)=>`${origin.label}：${warning}`))
    metadata.ocrWords ||= []
    metadata.ocrWords.push(...(result.metadata?.ocrWords || []).map((word)=>({...word,origin:{...origin,hash:imageHash(buffer)}})))
    metadata.ocrRegions.push(...(result.metadata?.ocrRegions || []).map((region) => ({ ...region, id: imageHash(Buffer.from(`${origin.label}:${region.id}`)).slice(0, 24), origin: { ...origin, hash: imageHash(buffer) } })))
    if (!result.text?.trim()) metadata.unreadableParts.push(`${origin.label}未识别到文字，请核对原件是否包含文字。`)
    return `\n【${origin.label}，OCR识别待核对】\n${result.text || '未识别到文字'}\n`
  } catch (error) {
    signal?.throwIfAborted()
    metadata.unreadableParts.push(`${origin.label}未读取成功：${String(error.message).slice(0, 140)}`)
    return `\n【${origin.label}：未读取成功】\n`
  }
}

export async function extractSpreadsheet(file, { signal, recognizeImage } = {}) {
  let workbook = new ExcelJS.Workbook()
  const csv = /\.(csv|tsv)$/i.test(file.originalname)
  if (csv) await workbook.csv.read(Readable.from([decodeDocumentBuffer(file.buffer)]), { map: (v) => v,
    parserOptions: { delimiter: /\.tsv$/i.test(file.originalname) ? '\t' : ',', ignoreEmpty: false } })
  else workbook = await loadSpreadsheetWorkbook(file.buffer, { signal })
  let text = ''
  const metadata = { format: csv ? 'csv' : 'xlsx', sections: [], warnings: [], unreadableParts: [], ocrRegions: [] }
  let cellTextLength = 0
  for (const sheet of workbook.worksheets) {
    signal?.throwIfAborted()
    const start = text.length
    text += `【工作表：${sheet.name}${sheet.state !== 'visible' ? `，${sheet.state}` : ''}】\n`
    const rowTexts = []
    sheet.eachRow((row, number) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        let value = cell.value
        if (value && typeof value === 'object') {
          if ('formula' in value || 'sharedFormula' in value) value = `公式=${value.formula || value.sharedFormula}；缓存结果=${value.result == null ? '未保存，未重算' : typeof value.result === 'object' ? JSON.stringify(value.result) : value.result}`
          else if (value instanceof Date) value = value.toISOString().replace('T', ' ').replace('Z', '') + '（原表未声明时区）'
          else if (value.richText) value = value.richText.map((r) => r.text).join('')
          else value = value.text ?? value.error ?? JSON.stringify(value)
        }
        cellTextLength += String(value ?? '').length
        const fmt = cell.numFmt && cell.numFmt !== 'General' ? `；格式=${cell.numFmt}` : ''
        cells.push(`${cell.address || `${column}`}=${value === '' || value == null ? '【空】' : value}${fmt}${cell.isMerged ? `；合并主格=${cell.master.address}` : ''}`)
      })
      rowTexts.push(`行${number}：${cells.join('\t')}`)
    })
    text += rowTexts.join('\n') + '\n'
    const header = rowTexts.slice(0, 3).join('\n')
    const merges = list(sheet.model.merges)
    if (merges.length) text += `合并范围：${list(sheet.model.merges).join('、')}\n`
    for (const image of sheet.getImages()) {
      const data = workbook.getImage(image.imageId)
      if (data?.buffer) text += await appendImage(Buffer.from(data.buffer), { kind: 'xlsx-image', imageId: image.imageId,
        sheet: sheet.name, label: `${sheet.name}内嵌图片${image.imageId}`, anchor: image.range?.tl ? { row: image.range.tl.nativeRow, col: image.range.tl.nativeCol } : null }, recognizeImage, metadata, signal)
      else metadata.unreadableParts.push(`${sheet.name}图片${image.imageId}未保存可读取的图片数据，需核对原件。`)
    }
    metadata.sections.push({ start, end: text.length, header, source: { sheet: sheet.name } })
  }
  if (!cellTextLength && !metadata.imageTextLength) text = ''
  return { text, pageCount: null, metadata }
}

export async function loadSpreadsheetWorkbook(buffer, { signal } = {}) {
  const zip = await openOfficeZip(buffer, 'xl/workbook.xml')
  let changed = false
  for(const entry of Object.values(zip.files).filter((item) => !item.dir && /\.(?:xml|rels)$/.test(item.name))) {
    signal?.throwIfAborted()
    const xml = await entry.async('string'), normalized = normalizeOfficeNamespaces(xml)
    if(normalized !== xml) { zip.file(entry.name,normalized); changed = true }
  }
  const workbook = new ExcelJS.Workbook()
  const readable = changed ? await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}) : buffer
  try { await workbook.xlsx.load(readable) }
  catch (cause) { throw new Error('XLSX文件无法读取，请确认文件未加密、未损坏且使用标准工作簿格式。', {cause}) }
  signal?.throwIfAborted()
  return workbook
}

function relationships(zip, part) {
  const path = posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels')
  return zip.file(path)?.async('string').then((xml) => list(parseOfficeXml(xml).Relationships?.Relationship)) || Promise.resolve([])
}
function internalTarget(part, relation) {
  if (!relation || relation['@_TargetMode'] === 'External') return null
  const target = relation['@_Target'] || ''
  if (/^[a-z]+:/i.test(target)) return null
  const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target))
  return path.startsWith('../') ? null : path
}

export async function extractPresentation(file, { signal, recognizeImage } = {}) {
  const zip = await openOfficeZip(file.buffer, 'ppt/presentation.xml')
  const presentation = parseOfficeXml(await zip.file('ppt/presentation.xml').async('string'))
  const relations = await relationships(zip, 'ppt/presentation.xml')
  const slides = list(presentation['p:presentation']?.['p:sldIdLst']?.['p:sldId'])
  let text = ''
  const metadata = { format: 'pptx', sections: [], warnings: [], unreadableParts: [], ocrRegions: [] }
  let nativeTextLength = 0
  for (const [index, slide] of slides.entries()) {
    signal?.throwIfAborted()
    const start = text.length
    const part = internalTarget('ppt/presentation.xml', relations.find((r) => r['@_Id'] === slide['@_r:id']))
    if (!part || !zip.file(part)) { metadata.unreadableParts.push(`幻灯片${index + 1}无法读取`); continue }
    const xml = await zip.file(part).async('string')
    const slideText = textNodes(parseOfficeXml(xml, true))
    nativeTextLength += slideText.trim().length
    text += `【幻灯片${index + 1}】\n${slideText}\n`
    const rels = await relationships(zip, part)
    for (const r of rels) {
      const target = internalTarget(part, r)
      if (!target) { metadata.warnings.push(`幻灯片${index + 1}含外链，未读取外部资源。`); continue }
      if (/\/notesSlide$/.test(r['@_Type'] || '') && zip.file(target)) {
        const notes = textNodes(parseOfficeXml(await zip.file(target).async('string'), true))
        nativeTextLength += notes.trim().length
        text += `【幻灯片${index + 1}备注】\n${notes}\n`
      }
      if (/\/image$/.test(r['@_Type'] || '') && xml.includes(r['@_Id']) && zip.file(target)) text += await appendImage(await zip.file(target).async('nodebuffer'), {
        kind: 'zip-image', path: target, page: index + 1, label: `幻灯片${index + 1}图片${r['@_Id']}` }, recognizeImage, metadata, signal)
    }
    if (/graphicData|chart|oleObj/.test(xml)) metadata.warnings.push(`幻灯片${index + 1}含表格、图表或绘图；已提取文字，复杂空间关系需核对。`)
    metadata.sections.push({ start, end: text.length, source: { slide: index + 1 } })
  }
  if (!nativeTextLength && !metadata.imageTextLength) text = ''
  return { text, pageCount: slides.length, metadata }
}

export { appendImage }
