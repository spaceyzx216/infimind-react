import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { Jimp, JimpMime } from 'jimp'
import { extractText } from '../services/file-parser.js'
import { renderOcrRegion } from '../services/ocr-region-image.js'
import { normalizeOfficeNamespaces } from '../services/office-xml-namespaces.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const workbook = new ExcelJS.Workbook()
const sheet = workbook.addWorksheet('名字 空格 & 编号')
sheet.addRows([['编号', '工资', '备注'], ['0012', 8000, '  前后空格 & <标签>  ']])
sheet.getCell('D2').value = { formula: 'B2*2', result: 16000 }
sheet.getCell('E2').value = { formula: '1/0', result: { error: '#DIV/0!' } }
sheet.getCell('F2').value = { formula:'B2+1000', result:12345 } // Deliberately stale cache; parsing must not recalculate it.
sheet.mergeCells('A4:C4'); sheet.getCell('A4').value = '合并说明'
workbook.addWorksheet('另一表').getCell('A1').value = '另一表条件'
const image = await new Jimp({ width:100, height:100, color:0xffffffff }).getBuffer(JimpMime.png)
const imageId = workbook.addImage({ buffer:image, extension:'png' })
sheet.addImage(imageId,'F1:G3')
const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
for(const entry of Object.values(zip.files).filter((entry) => !entry.dir && /\.xml$/.test(entry.name))) {
  let xml = await entry.async('string')
  if (!xml.includes(`xmlns="${main}"`)) continue
  xml = xml.replace(`xmlns="${main}"`,`xmlns:alias="${main}"`)
    .replace(/<(\/?)([a-zA-Z][\w.-]*)(?=[\s/>])/g, '<$1alias:$2')
  zip.file(entry.name,xml)
}
const file = { originalname:'不同命名空间.xlsx',buffer:await zip.generateAsync({type:'nodebuffer'}) }
if(process.argv[2]) {await mkdir(process.argv[2],{recursive:true});await writeFile(join(process.argv[2],'原始带前缀.xlsx'),file.buffer)}
const parsed = await extractText(file,{recognizeImage:async()=>({text:'图片文字',metadata:{ocrRegions:[{id:'word',text:'图片文字',bbox:{x0:10,y0:10,x1:40,y1:40}}],
  ocrWords:[{text:'图片文字',confidence:65,bbox:{x0:10,y0:10,x1:40,y1:40}}],warnings:['部分局部OCR核对未完成']}})})
for(const term of ['A2=0012','缓存结果=16000','缓存结果=12345','#DIV/0!','  前后空格 & <标签>  ','另一表条件','A4:C4','图片文字']) assert.ok(parsed.text.includes(term),term)
const crop = await renderOcrRegion(file,parsed.metadata.ocrRegions[0])
assert.ok(crop.length>0)
assert.equal(parsed.metadata.ocrWords[0].origin.kind,'xlsx-image')
assert.ok(parsed.metadata.warnings.some((warning)=>warning.includes('部分局部OCR核对未完成')))
// Default PresentationML and renamed relationship prefixes are equivalent to p/r.
const ppt = new JSZip()
ppt.file('ppt/presentation.xml','<presentation xmlns="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sldIdLst><sldId q:id="id1"/></sldIdLst></presentation>')
ppt.file('ppt/_rels/presentation.xml.rels','<j:Relationships xmlns:j="http://schemas.openxmlformats.org/package/2006/relationships"><j:Relationship Id="id1" Target="slides/slide1.xml"/></j:Relationships>')
ppt.file('ppt/slides/slide1.xml','<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:z="http://schemas.openxmlformats.org/drawingml/2006/main"><z:p><z:t xml:space="preserve">第一行 </z:t><z:t>第二行</z:t></z:p></p:sld>')
const presentation = await extractText({originalname:'默认命名空间.pptx',buffer:await ppt.generateAsync({type:'nodebuffer'})})
assert.equal(presentation.pageCount,1); assert.ok(presentation.text.includes('第一行 第二行'))
const unknown = '<u:workbook xmlns:u="urn:fictional-custom"><u:sheet>保留外部名字</u:sheet></u:workbook>'
assert.equal(normalizeOfficeNamespaces(unknown),unknown)
assert.throws(()=>normalizeOfficeNamespaces('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///fictional">]><x/>'),/实体/)
console.log('Office namespace compatibility passed: XLSX text/styles/formula caches/merges/images/crops and PPT namespaces/space preservation')
