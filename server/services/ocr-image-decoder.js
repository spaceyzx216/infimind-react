import { Jimp } from 'jimp'

const LIMIT = 40_000_000
function checkPixels(width, height) {
  if (width > 0 && height > 0 && width * height > LIMIT) throw new Error('图片像素超限，请缩小后上传')
}

export function inspectImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const type = buffer.toString('ascii', 12, 16)
    if (type === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
    if (type === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    if (type === 'VP8L') { const bits = buffer.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 } }
  }
  if (buffer.length > 4 && buffer[0] === 255 && buffer[1] === 216) {
    let at = 2
    while (at + 4 < buffer.length) {
      if (buffer[at] !== 255) break
      const marker = buffer[at + 1]
      if (marker === 218 || marker === 217) break
      const length = buffer.readUInt16BE(at + 2)
      if (length < 2 || at + 2 + length > buffer.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) }
      at += 2 + length
    }
  }
  return null
}

export async function readOcrImage(buffer) {
  const dimensions = inspectImageDimensions(buffer)
  if (dimensions) checkPixels(dimensions.width, dimensions.height)
  let image
  try { image = await Jimp.read(buffer) }
  catch (error) {
    // pdf-parse already depends on this canvas runtime. No remote image loading.
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw error
    const { loadImage, createCanvas } = await import('@napi-rs/canvas')
    const original = await loadImage(buffer)
    checkPixels(original.width, original.height)
    const canvas = createCanvas(original.width, original.height)
    canvas.getContext('2d').drawImage(original, 0, 0)
    image = await Jimp.read(await canvas.encode('png'))
  }
  checkPixels(image.width, image.height)
  return image
}
