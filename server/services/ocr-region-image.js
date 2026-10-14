import { readOcrImage } from './ocr-image-decoder.js'
import { JimpMime } from 'jimp'
import { openOfficeZip, imageHash, loadSpreadsheetWorkbook } from './office-material-parser.js'
import { convertLegacyDocToDocx } from './file-parser.js'

export async function renderOcrRegion(file, region) {
  const origin = region.origin || { kind: 'file-image' }
  let buffer = file.buffer
  if (origin.kind === 'zip-image') {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) buffer = await convertLegacyDocToDocx(file)
    const zip = await openOfficeZip(buffer)
    if (!zip.file(origin.path)) throw new Error('原图不存在')
    buffer = await zip.file(origin.path).async('nodebuffer')
  } else if (origin.kind === 'xlsx-image') {
    const workbook = await loadSpreadsheetWorkbook(buffer)
    buffer = workbook.getImage(origin.imageId)?.buffer
    if (!buffer) throw new Error('工作表原图不存在')
  } else if (origin.kind === 'pdf-page' || origin.kind === 'pdf-image') {
    const { PDFParse } = await import('pdf-parse')
    const pdf = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      if (origin.kind === 'pdf-page') buffer = (await pdf.getScreenshot({ partial: [origin.page], desiredWidth: origin.width || 1800, imageDataUrl: false })).pages[0]?.data
      else buffer = (await pdf.getImage({ partial: [origin.page], imageThreshold: 0, imageDataUrl: false, imageBuffer: true })).pages.flatMap((p) => p.images)[origin.imageIndex]?.data
    } finally { await pdf.destroy() }
    if (!buffer) throw new Error('PDF原图不存在')
  }
  buffer = Buffer.from(buffer)
  if (origin.hash && origin.hash !== imageHash(buffer)) throw new Error('原图与识别时的图片不一致，请重新解析')
  const image = await readOcrImage(buffer)
  if (image.width * image.height > 40_000_000) throw new Error('原图像素超限')
  const box = region.bbox
  if (!box || !Object.values(box).every(Number.isFinite)) throw new Error('识别区域坐标不可用')
  const x = Math.max(0, Math.floor(box.x0) - 20), y = Math.max(0, Math.floor(box.y0) - 20)
  const w = Math.min(image.width - x, Math.ceil(box.x1) - x + 20), h = Math.min(image.height - y, Math.ceil(box.y1) - y + 20)
  if (w <= 0 || h <= 0) throw new Error('识别区域超出原图')
  return image.crop({ x, y, w, h }).getBuffer(JimpMime.png)
}
