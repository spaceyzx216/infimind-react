import { JimpMime } from 'jimp'
import { readOcrImage } from './ocr-image-decoder.js'

// Image dimensions do not tell us text size. A wide screenshot with 40px text
// must not be enlarged just because its height is small.
function estimateInkLineHeight(image) {
  const step = Math.max(1, Math.floor(image.width / 1200))
  const samples = Math.ceil(image.width / step), heights = []
  let start = -1, lastInk = -1
  for (let y = 0; y <= image.height; y++) {
    let count = 0
    if(y < image.height) for(let x=0; x<image.width; x+=step) {
      const at = (y * image.width + x) * 4
      if(image.bitmap.data[at+3] > 128 && image.bitmap.data[at] < 160) count++
    }
    const ink = count >= 3 && count < samples * .8
    if(ink) { if(start < 0) start = y; lastInk = y }
    if(start >= 0 && (y - lastInk > 2 || y === image.height)) {
      const height = lastInk - start + 1
      if(height >= 7 && height < image.height * .5) heights.push(height)
      start = -1
    }
  }
  heights.sort((a,b)=>a-b)
  return heights.length ? heights[Math.floor(heights.length/2)] : null
}

export async function prepareOcrImage(buffer) {
  const image = await readOcrImage(buffer)
  const originalWidth = image.width, originalHeight = image.height
  image.greyscale()
  const lineHeight = estimateInkLineHeight(image)
  const scale = lineHeight && lineHeight < 20 ? Math.min(2,24 / lineHeight,Math.sqrt(40_000_000/(image.width*image.height))) : 1
  if(scale > 1) image.resize({w:Math.round(image.width*scale),h:Math.round(image.height*scale)})
  return { buffer:await image.getBuffer(JimpMime.png), originalWidth, originalHeight,
    width:image.width, height:image.height, scaleX:image.width/originalWidth, scaleY:image.height/originalHeight, lineHeight }
}
