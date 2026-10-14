import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractText } from '../services/file-parser.js'
import { renderOcrRegion } from '../services/ocr-region-image.js'
import { ocrCacheDirectory } from '../services/ocr-process.js'
import { cleanOcrTestText, containsOcrTestField } from './ocr-test-metrics.js'

const [directory, baselinePath] = process.argv.slice(2)
if(!directory || !baselinePath) throw new Error('Usage: node test-ocr-corpus.js <fictional-gold-dir> <baseline-parser.js>')
const folder = resolve(directory), baseline = await import(pathToFileURL(resolve(baselinePath)).href)
const cases = JSON.parse(await readFile(join(folder,'gold.json'),'utf8'))
process.chdir(ocrCacheDirectory)
const clean = cleanOcrTestText
assert.equal(containsOcrTestField('工资80000元','8000'),false)
assert.equal(containsOcrTestField('工资16000元','6000'),false)
assert.equal(containsOcrTestField('工资1,008.600元','1,008.60'),false)
function distance(a,b) {
  a=[...clean(a)]; b=[...clean(b)]
  let row=Array.from({length:b.length+1},(_,i)=>i)
  for(let i=1;i<=a.length;i++) {
    const next=[i]
    for(let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1))
    row=next
  }
  return row[b.length]
}
const results=[]
for(const sample of cases) {
  const file={originalname:sample.file,buffer:await readFile(join(folder,sample.file))}
  const beforeStart=Date.now(),before=await baseline.extractText(file,{ocrInProcess:true}),beforeMs=Date.now()-beforeStart
  const afterStart=Date.now(),after=await extractText(file,{ocrInProcess:true}),afterMs=Date.now()-afterStart
  assert.ok(after.metadata.ocrRegions.length,'Must retain critical-field review regions')
  const region=after.metadata.ocrRegions[0]
  assert.ok(region.bbox.x0>=0 && region.bbox.x1<=after.metadata.originalWidth)
  await writeFile(join(folder,`${sample.id}-crop.png`),await renderOcrRegion(file,region))
  const metric=(document,elapsedMs)=>({text:document.text,edits:distance(sample.gold,document.text),elapsedMs,
    missingFields:sample.fields.filter((field)=>!containsOcrTestField(document.text,field))})
  results.push({id:sample.id,gold:sample.gold,goldCharacters:[...clean(sample.gold)].length,fields:sample.fields,
    before:metric(before,beforeMs),after:{...metric(after,afterMs),regions:after.metadata.ocrRegions.length,scaleX:after.metadata.scaleX,lineHeight:after.metadata.lineHeight,
      uncertain:after.metadata.ocrRegions.filter((r)=>r.confidence<82 || r.candidates.length).slice(0,20).map((r)=>({text:r.text,confidence:r.confidence,candidates:r.candidates,reason:r.reason,bbox:r.bbox}))}})
  console.log(JSON.stringify({id:sample.id,before:results.at(-1).before.edits,after:results.at(-1).after.edits,scale:after.metadata.scaleX,lineHeight:after.metadata.lineHeight}))
}
const summary={cases:results.length,goldCharacters:results.reduce((n,r)=>n+r.goldCharacters,0),fields:results.reduce((n,r)=>n+r.fields.length,0)}
for(const side of ['before','after']) summary[side]={edits:results.reduce((n,r)=>n+r[side].edits,0),missingFields:results.reduce((n,r)=>n+r[side].missingFields.length,0),
  exactCases:results.filter((r)=>r[side].edits===0).length,elapsedMs:results.reduce((n,r)=>n+r[side].elapsedMs,0)}
await writeFile(join(folder,'comparison.json'),JSON.stringify({summary,results,limitation:'小规模虚构印刷体样例；不代表所有版面、真实业务或法律准确率。'},null,2))
console.log(JSON.stringify({summary}))
assert.ok(summary.after.edits <= summary.before.edits,'Corpus total character edits must not regress')
assert.ok(summary.after.missingFields <= summary.before.missingFields,'Critical fields must not regress')
assert.equal(results.find((r)=>r.id==='original').after.edits,0,'Original two misread characters must be recognized correctly')
