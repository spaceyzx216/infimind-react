import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import express from 'express'
import { Jimp, JimpMime } from 'jimp'
import { extractText } from '../services/file-parser.js'
import { splitDocument, selectMaterialBlocks } from '../services/document-materials.js'
import { indexMaterialDocuments, prepareTaskMaterials } from '../services/material-processing.js'
import { isAcceptableFile } from '../services/upload-config.js'
import { mergeMaterials, getMaterials, materialStoreKey } from '../services/consult-material-store.js'
import { createMaterialRouter } from '../routes/materials.js'
import { readOcrImage } from '../services/ocr-image-decoder.js'
import { renderOcrRegion } from '../services/ocr-region-image.js'

let passed = 0
async function test(name, operation) { await operation(); passed++; console.log(`PASS ${name}`) }
const file = (name, buffer, mimetype = 'application/octet-stream') => ({ id: 'file-a', originalname: name, buffer: Buffer.from(buffer), mimetype })

await test('XLSX保留多个工作表、单元格对应、合并、公式和前导零格式', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('工资记录')
  sheet.addRows([['姓名', '工资', '编号'], ['虚构员工', 8000, 12]])
  sheet.getCell('C2').numFmt = '000000'
  sheet.getCell('D2').value = { formula: 'B2*2', result: 16000 }
  sheet.mergeCells('A4:B4'); sheet.getCell('A4').value = '补充条款'
  workbook.addWorksheet('隐藏条件', { state: 'hidden' }).getCell('A1').value = '后续核对条件'
  const parsed = await extractText(file('工资.xlsx', await workbook.xlsx.writeBuffer()))
  assert.match(parsed.text, /B2=8000/); assert.match(parsed.text, /C2=12；格式=000000/)
  assert.match(parsed.text, /缓存结果=16000/); assert.match(parsed.text, /A4:B4/)
  assert.match(parsed.text, /隐藏条件，hidden/); assert.equal(parsed.metadata.completeness, 'complete')
})
await test('CSV引用逗号、换行、空列、前导零和UTF16不丢失', async () => {
  const source = '编号,名称,备注,工资\n0012,"虚构,员工","第一行\n第二行",8000\n0020,,备注,9000'
  const parsed = await extractText(file('记录.csv', Buffer.concat([Buffer.from([255, 254]), Buffer.from(source, 'utf16le')])))
  assert.match(parsed.text, /A2=0012/); assert.match(parsed.text, /B2=虚构,员工/)
  assert.match(parsed.text, /第一行\n第二行/); assert.match(parsed.text, /B3=【空】/)
  const unnamed = file('blob', source, 'text/csv')
  assert.equal(isAcceptableFile(unnamed), true)
  assert.match((await extractText(unnamed)).text, /A2=0012/)
})
await test('PPT按presentation顺序读取正文、表格文字和备注', async () => {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId r:id="rB"/><p:sldId r:id="rA"/></p:sldIdLst></p:presentation>')
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rA" Target="slides/slide1.xml"/><Relationship Id="rB" Target="slides/slide2.xml"/></Relationships>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>第二页条件</a:t></a:r></a:p></p:sld>')
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>第一页条件</a:t></a:r></a:p><a:tr><a:tc><a:p><a:t>表头</a:t></a:p></a:tc><a:tc><a:p><a:t>金额8000</a:t></a:p></a:tc></a:tr></p:sld>')
  zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="n" Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>')
  zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><a:p><a:t>备注中的例外</a:t></a:p></p:notes>')
  const parsed = await extractText(file('条件.pptx', await zip.generateAsync({ type: 'nodebuffer' })))
  assert.ok(parsed.text.indexOf('第一页条件') < parsed.text.indexOf('第二页条件'))
  assert.match(parsed.text, /备注中的例外/); assert.match(parsed.text, /金额8000/)
})
await test('文本、Markdown保留全文；坏Office、伪装扩展名和超长正文明确失败', async () => {
  for (const ext of ['txt', 'md']) assert.equal((await extractText(file(`正文.${ext}`, '# 标题\n尾部关键条件'))).text, '# 标题\n尾部关键条件')
  for (const ext of ['xlsx', 'pptx']) await assert.rejects(extractText(file(`坏文件.${ext}`, 'not a zip')))
  assert.equal(isAcceptableFile({ originalname: 'bad.exe', mimetype: 'text/plain' }), false)
  await assert.rejects(extractText(file('超长.txt', 'a'.repeat(2_000_001))), /200万/)
})
await test('空Office不能把结构标签当正文；XML实体及压缩炸弹拒绝读取', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('空表')
  assert.equal((await extractText(file('空表.xlsx', await workbook.xlsx.writeBuffer()))).metadata.completeness, 'empty')
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId r:id="rA"/></p:sldIdLst></p:presentation>')
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rA" Target="slides/slide1.xml"/></Relationships>')
  zip.file('ppt/slides/slide1.xml', '<p:sld/>')
  assert.equal((await extractText(file('空演示.pptx', await zip.generateAsync({ type: 'nodebuffer' })))).metadata.completeness, 'empty')
  zip.file('ppt/presentation.xml', '<!DOCTYPE p [<!ENTITY external SYSTEM "file:///example">]><p:presentation/>')
  await assert.rejects(extractText(file('实体.pptx', await zip.generateAsync({ type: 'nodebuffer' }))), /实体|DOCTYPE|XML/)
  zip.file('ppt/presentation.xml', 'x'.repeat(2_000_000))
  await assert.rejects(extractText(file('过度压缩.pptx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))), /解压|压缩|资源/)
})
await test('分块不丢字符、不切断代理对；选段命中文件后半部分', () => {
  const source = '普通段落\n'.repeat(6000) + '末尾工资条件：每月8000元\n😀'
  const blocks = splitDocument(source)
  assert.equal(blocks.map((b) => b.text).join(''), source)
  const selected = selectMaterialBlocks([{ fileId: 'a', fileName: '长合同', text: source }], '工资条件', 6500)
  assert.ok(selected.blocks.some((b) => b.text.includes('每月8000元')))
  assert.equal(selected.coverage.partial, true)
  const sections = [{ start: 0, end: 4, source: { page: 1 } }, { start: 4, end: 8, source: { page: 2 } }]
  const paged = splitDocument('第一页文第二页文', { sections })
  assert.deepEqual(paged.map((b) => [b.start, b.end, b.source.page]), [[0, 4, 1], [4, 8, 2]])
  const tableDocs = [{ fileId: 'table', text: '普通内容\n'.repeat(1500) + '0012 8000', parseMetadata: { sections: [{ start: 7500, end: 7509, header: '补贴编号 金额', source: { sheet: '补贴表' } }] } }]
  assert.ok(selectMaterialBlocks(tableDocs, '补贴编号', 6500).blocks.some((b) => b.text.includes('0012')))
})
await test('咨询存储完整正文，后续追问能取回尾部', () => {
  const source = 'a'.repeat(50000) + '尾部工资8000'
  mergeMaterials('consult-long-test', [{ name: '合同', text: source }])
  assert.equal(getMaterials('consult-long-test')[0].text, source)
  assert.notEqual(materialStoreKey('owner', 'x'.repeat(80) + 'a'), materialStoreKey('owner', 'x'.repeat(80) + 'b'))
  assert.notEqual(materialStoreKey('owner', 'thread'), materialStoreKey('other', 'thread'))
})
await test('遍历摘录验证原文、失败保留检查点、恢复不重复已完成块', async () => {
  const documents = [{ fileId: 'a', fileName: '证据', text: '普通记录\n'.repeat(2000) + '末尾关键证据8000元' }]
  const saved = new Map(), seen = []
  const opts = { checkpoint: async (key, value) => saved.set(key, { result: value }), getCheckpoint: (key) => saved.get(key),
    generate: async (_prompt, text) => {
      seen.push(text)
      return { finishReason: 'stop', content: JSON.stringify({ complete: true, quotes: text.includes('末尾关键证据') ? [{ quote: '末尾关键证据8000元', topic: '工资', kind: 'fact' }] : [] }) }
    } }
  const index = await indexMaterialDocuments(documents, opts)
  assert.ok(index.some((entry) => entry.quotes.some((q) => q.quote === '末尾关键证据8000元')))
  const calls = seen.length
  await indexMaterialDocuments(documents, opts); assert.equal(seen.length, calls)
  await assert.rejects(indexMaterialDocuments([{ fileId: 'b', text: '原文' }], { generate: async () => ({ finishReason: 'stop', content: '{"complete":true,"quotes":[{"quote":"编造"}]}' }) }), /未匹配原文/)
  await assert.rejects(indexMaterialDocuments([{ fileId: 'c', text: '原文' }], { generate: async () => ({ finishReason: 'length', content: '{}' }) }), /未完整结束/)
  const realIndex = await indexMaterialDocuments(documents, { ...opts, getCheckpoint: () => null, retainedIndex: index })
  assert.equal(realIndex.length, index.length); assert.equal(seen.length, calls)
  const simulated = await indexMaterialDocuments(documents, { fakeLlm: true })
  await indexMaterialDocuments(documents, { ...opts, getCheckpoint: () => null, retainedIndex: simulated })
  assert.ok(seen.length > calls, '模拟索引不得复用为真实模型读取')
})
await test('咨询同名材料替换、历史任务正文保持权威', async () => {
  const saved = new Map()
  const args = { task: { id: 'task-new', productId: 'labor-consult' }, input: {}, fakeLlm: true,
    sourceDocuments: [{ fileId: 'old', fileName: '合同.txt', text: '旧合同' }], files: [file('合同.txt', '新合同')],
    checkpoint: async (key, result) => saved.set(key, { result }), getCheckpoint: (key) => saved.get(key), emit: async () => {} }
  const result = await prepareTaskMaterials(args)
  assert.equal(result.materialDocuments.length, 1); assert.equal(result.materialDocuments[0].text, '新合同')
  const historical = { ...args, getCheckpoint: (key) => key === 'parsing' ? { result: { text: '旧版本权威正文' } } : null }
  assert.equal(await prepareTaskMaterials(historical), historical)
})
await test('OCR保存原图坐标、低置信度和关键文字；二次结果不会覆盖正文', async () => {
  const image = await new Jimp({ width: 100, height: 100, color: 0xffffffff }).getBuffer(JimpMime.png)
  assert.equal((await extractText(file('注入.png', image), { recognizeImage: async () => ({ text: '核对注入', metadata: { format: 'image' } }) })).text, '核对注入')
  let calls = 0
  const parsed = await extractText(file('截图.png', image, 'image/png'), { createOcrWorker: async () => ({ setParameters: async () => {}, terminate: async () => {},
    recognize: async () => ({ data: { text: ++calls === 1 ? '工资8000' : '工资80000', confidence: 60,
      blocks: [{ paragraphs: [{ lines: [{ words: [{ text: '8000', confidence: 60, bbox: { x0: 30, y0: 30, x1: 90, y1: 60 } }] }] }] }] } }) }) })
  assert.equal(parsed.text, '工资8000')
  const region = parsed.metadata.ocrRegions[0]
  assert.equal(region.bbox.x0, 30); assert.ok(region.candidates.includes('工资80000'))
  assert.equal(region.reason,'两次识别结果有差异')
  const small = new Jimp({width:100,height:100,color:0xffffffff})
  for(let y=10;y<22;y++) for(let x=10;x<70;x++) small.setPixelColor(0x000000ff,x,y)
  const resized = await extractText(file('小字.png',await small.getBuffer(JimpMime.png)), {createOcrWorker:async()=>({setParameters:async()=>{},terminate:async()=>{},
    recognize:async()=>({data:{text:'工资8000',confidence:90,blocks:[{paragraphs:[{lines:[{words:[{text:'8000',confidence:90,bbox:{x0:30,y0:30,x1:90,y1:60}}]}]}]}]}})})})
  assert.equal(resized.metadata.scaleX,2)
  assert.equal(resized.metadata.ocrRegions[0].bbox.x0,15)
})
await test('隔离OCR进程可取消，取消结果不能伪装为读取成功', async () => {
  const image = await new Jimp({ width: 100, height: 100, color: 0xffffffff }).getBuffer(JimpMime.png)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 50)
  try { await assert.rejects(extractText(file('取消.png', image, 'image/png'), { signal: controller.signal }), (error) => error.name === 'AbortError') }
  finally { clearTimeout(timer) }
})
await test('补读失败保留初次文字，局部补读时取消必须终止并释放worker', async () => {
  const image = await new Jimp({width:100,height:100,color:0xffffffff}).getBuffer(JimpMime.png)
  let calls=0,terminated=0
  const fallback = await extractText(file('无词框.png',image), {createOcrWorker:async()=>({setParameters:async()=>{},terminate:async()=>{terminated++},
    recognize:async()=> {if(++calls>1) throw new Error('synthetic secondary failure'); return {data:{text:'工资8000',confidence:60,blocks:[]}}}})})
  assert.equal(fallback.text,'工资8000'); assert.ok(fallback.metadata.warnings.some((w)=>w.includes('补充OCR核对未完成'))); assert.equal(terminated,1)
  const controller=new AbortController(); calls=0;terminated=0
  await assert.rejects(extractText(file('局部取消.png',image), {signal:controller.signal,createOcrWorker:async()=>({setParameters:async()=>{},terminate:async()=>{terminated++},
    recognize:async()=> {if(++calls>1) {controller.abort(); throw controller.signal.reason} return {data:{text:'工资8000',confidence:60,blocks:[{paragraphs:[{lines:[{words:[{text:'8000',confidence:60,bbox:{x0:10,y0:10,x1:60,y1:40}}]}]}]}]}}}})}), (error)=>error.name==='AbortError')
  assert.ok(terminated>0)
})
await test('WebP复用PDF画布解码并可核对原图，超大像素在解码前拒绝', async () => {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(100, 100)
  canvas.getContext('2d').fillRect(0, 0, 100, 100)
  const buffer = await canvas.encode('webp')
  assert.equal((await readOcrImage(buffer)).width, 100)
  const crop = await renderOcrRegion(file('截图.webp', buffer), { bbox: { x0: 20, y0: 20, x1: 60, y1: 40 }, origin: { kind: 'file-image' } })
  assert.ok(crop.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
  const oversized = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized)
  oversized.writeUInt32BE(50000, 16); oversized.writeUInt32BE(50000, 20)
  await assert.rejects(readOcrImage(oversized), /像素超限/)
})
await test('核对接口限制用户、任务、区域及原件保存期限，不泄漏存储路径', async () => {
  const image = await new Jimp({ width: 100, height: 100, color: 0xffffffff }).getBuffer(JimpMime.png)
  const document = { fileId: 'file-a', fileName: '截图', text: '8000', parseMetadata: { ocrRegions: [{ id: 'word-0', text: '8000', bbox: { x0: 20, y0: 20, x1: 60, y1: 40 }, origin: { kind: 'file-image' } }] } }
  const now = Date.now(); let expired = false
  const app = express(); app.use((req, _res, next) => { req.user = { id: req.get('x-user') || 'owner' }; next() })
  app.use('/api', createMaterialRouter({ taskService: {
    getTask: (id, user) => id === 'task-a' && user === 'owner' ? { id, resultExpiresAt: new Date(now + 60000).toISOString() } : null,
    getCheckpoint: (_id, stage) => stage === 'material-source' ? { result: { documents: [document] } } : null,
    getFiles: () => [{ id: 'file-a', cleanupAt: new Date(expired ? now - 1000 : now + 60000).toISOString(), storagePath: 'private' }] },
    fileStore: { readFiles: async () => [file('截图.png', image)] } }))
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const base = `http://127.0.0.1:${server.address().port}/api/tasks/task-a/materials/file-a`
  try {
    assert.equal((await fetch(base, { headers: { 'x-user': 'other' } })).status, 404)
    const detail = await (await fetch(base)).json(); assert.equal(detail.regions[0].origin, undefined)
    assert.equal((await fetch(base + '/regions/word-0')).status, 200)
    assert.equal((await fetch(base + '/regions/not-a-region')).status, 404)
    expired = true; assert.equal((await fetch(base + '/regions/word-0')).status, 410)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
console.log(`document materials: ${passed} scenarios passed`)
