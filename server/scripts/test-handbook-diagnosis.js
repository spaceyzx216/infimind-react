import assert from 'node:assert/strict'
import express from 'express'
import JSZip from 'jszip'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHandbookStructure, locateHandbookQuote } from '../services/handbook-structure.js'
import { runHandbookDiagnosis, normalizeHandbookFindings, mergeHandbookFindings, fakeHandbookResponse } from '../workflows/handbook-diagnosis.js'
import { loadHandbookReferences } from '../services/handbook-references.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskService } from '../services/task-service.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskProcessor } from '../services/task-processor.js'
import { createTaskQueue } from '../services/task-queue.js'
import { createTaskRouter } from '../routes/tasks.js'
import { initialize, close as closeLaws } from '../services/law-whitelist.js'
import { readHandbookEvents, formatHandbookReport } from '../../src/utils/handbook-result.js'
import { extractHandbookText, HANDBOOK_PARSER_VERSION } from '../services/handbook-materials.js'

initialize(':memory:')
const directory = mkdtempSync(join(tmpdir(), 'fafee-handbook-test-'))
const text = '测试员工手册\n第一章 考勤制度\n第一条 员工迟到时，公司应先提醒并允许补正记录。\n第二条 员工忘打卡时，公司须核实实际出勤。\n第二章 奖惩制度\n第三条 员工迟到一次，公司可以解除劳动合同。\n'
const noReferences = async () => ({ documents: [], versions: [], warnings: [] })
const makeRunner = () => {
  const checkpoints = new Map()
  const events = []
  return { checkpoints, events, options: { checkpoint: async (key, value) => checkpoints.set(key, { result: structuredClone(value) }),
    getCheckpoint: (key) => checkpoints.get(key), emit: async (event, payload) => events.push({ event, payload: structuredClone(payload) }),
    referenceLoader: noReferences, lawLoader: async () => [], fakeLlm: true } }
}
let passed = 0
const test = async (name, run) => { await run(); passed += 1; console.log(`PASS ${name}`) }

const material = (name) => ({ id: name, originalname: name, buffer: readFileSync(fileURLToPath(new URL(`../../docs/员工手册诊断测试/材料/${name}`, import.meta.url))) })
const imageText = '超过一个工作日未补正的忘打卡记录一律认定旷工。'
await test('Word表格保留列分隔，内嵌图片条款进入原文且OCR文字不解释为HTML', async () => {
  const parsed = await extractHandbookText(material('T11图文表格手册.docx'), {
    recognizeImage: async () => ({ text: `${imageText}\n<公司标记>`, metadata: { confidence: 88 } }) })
  assert.ok(parsed.text.includes(imageText))
  assert.ok(parsed.text.includes('<公司标记>'))
  assert.ok(parsed.text.includes('\t'))
  assert.equal(parsed.metadata.embeddedImages, 1)
  assert.deepEqual(parsed.metadata.unreadableParts, [])
  assert.ok(parsed.metadata.warnings.some((item) => item.includes('OCR')))
})
await test('PDF文字层不能跳过同页图片条款，页码和原有文字仍保留', async () => {
  const parsed = await extractHandbookText(material('T15图文混排.pdf'), { recognizeImage: async () => ({ text: imageText }) })
  assert.ok(parsed.text.includes(imageText))
  assert.ok(parsed.text.includes('补正'))
  assert.equal(parsed.metadata.pages[0].page, 1)
  assert.equal(parsed.metadata.pages[0].method, 'text+ocr')
  assert.deepEqual(parsed.metadata.unreadableParts, [])
})
await test('内嵌图片失败或未识别文字先暂停，明确选择已读部分后才完成', async () => {
  for (const recognizeImage of [async () => { throw new Error('虚构OCR读取失败') }, async () => ({ text: '' })]) {
    const runner = makeRunner()
    const opts = { ...runner.options, files: [material('T11图文表格手册.docx')], parseFile: (file) => extractHandbookText(file, { recognizeImage }) }
    const blocked = await runHandbookDiagnosis(opts)
    assert.equal(blocked.analysisStatus, 'blocked')
    assert.equal(blocked.findings.length, 0)
    assert.ok(blocked.unreadableMaterials.some((item) => item.reason.includes('图片')))
    const partial = await runHandbookDiagnosis({ ...opts, input: { allowPartial: true } })
    assert.equal(partial.analysisStatus, 'completed')
    assert.ok(partial.unreadableMaterials.length)
  }
})
await test('旧解析检查点不能隐藏未读图片，新解析版本恢复后补读', async () => {
  const runner = makeRunner()
  runner.checkpoints.set('handbook-parsing', { result: { documents: [{ fileId: 'x', fileName: '旧缓存', text: '员工应按规定考勤。' }], failures: [], warnings: [] } })
  let reparsed = 0
  const report = await runHandbookDiagnosis({ ...runner.options, files: [material('T11图文表格手册.docx')], input: { action: 'restart' },
    parseFile: (file) => { reparsed += 1; return extractHandbookText(file, { recognizeImage: async () => ({ text: imageText }) }) } })
  assert.equal(reparsed, 1)
  assert.ok(report.sourceDocuments[0].text.includes(imageText))
  assert.equal(runner.checkpoints.get('handbook-parsing').result.parserVersion, HANDBOOK_PARSER_VERSION)
})
await test('共享解析正文只读取一次，报告不暴露图片内部来源描述', async () => {
  const runner = makeRunner(), file = { id: 'shared-source', originalname: '虚构制度.txt' }
  const report = await runHandbookDiagnosis({ ...runner.options, files: [file],
    materialDocuments: [{ fileId: file.id, text: '第一章 考勤\n员工须核对实际出勤。', parseMetadata: {
      parserVersion: 1, completeness: 'complete', warnings: ['OCR待核对'], ocrRegions: [{ origin: { path: 'internal/zip/image.png' } }],
      blocks: [{ id: 'block', start: 0, end: 22, source: { method: 'ocr', path: 'internal/source' } }] } }],
    parseFile: async () => { throw new Error('不应重新读取已经共享解析的文件') } })
  assert.equal(report.analysisStatus, 'completed')
  assert.equal(report.sourceDocuments[0].parseMetadata.ocrRegionCount, 1)
  assert.ok(!JSON.stringify(report).includes('internal/'))
  assert.equal(report.sourceDocuments[0].parseMetadata.blocks[0].source.method, 'ocr')
})
await test('旧解析版本的追问保留历史原文，不重新解释源文件', async () => {
  const runner = makeRunner(), text = '员工应按实际出勤核对考勤。'
  runner.checkpoints.set('handbook-parsing', { result: { parserVersion: 2, documents: [{ fileId: 'historical', fileName: '历史文本', text }], failures: [], warnings: [] } })
  const result = await runHandbookDiagnosis({ ...runner.options, input: { action: 'followup', message: '解释实际出勤要求' },
    report: { analysisStatus: 'completed', findings: [] }, parseFile: async () => { throw new Error('追问不应重读') } })
  assert.equal(result.kind, 'followup')
  assert.equal(runner.checkpoints.get('handbook-parsing').result.documents[0].text, text)
})
await test('取消内嵌图OCR不能降级为可读部分继续诊断', async () => {
  const controller = new AbortController()
  await assert.rejects(extractHandbookText(material('T11图文表格手册.docx'), { signal: controller.signal,
    recognizeImage: async () => { controller.abort(new Error('取消图片读取')); throw controller.signal.reason } }), /取消图片读取/)
})
await test('OCR冲突能定位识别文本但不能冒称已核实原件', () => {
  const chunks = buildHandbookStructure([{ fileId: 'a', fileName: '正文', text: '第一章 补正\n员工可在三个工作日内补正。' },
    { fileId: 'b', fileName: '图片', text: '【第1页，含OCR识别待核对】\n员工仅可在一个工作日内补正。' }]).chunks
  const finding = normalizeHandbookFindings([{ kind: 'conflict', title: '补正期限矛盾', explanation: '同一对象和条件，期限不能同时执行。', status: 'risk',
    evidence: chunks.map((chunk) => ({ chunkId: chunk.id, quote: chunk.text })), authorities: [] }], chunks)[0]
  assert.equal(finding.locationStatus, 'found')
  assert.equal(finding.status, 'pending')
  assert.ok(finding.verificationNote.includes('图片原件'))
  assert.ok(formatHandbookReport({ findings: [finding] }).includes(finding.verificationNote))
})
await test('OCR文档后续分块仍保留待核对状态，不因图片标记位于前一块丢失', () => {
  const chunks = buildHandbookStructure([{ fileId: 'a', fileName: '扫描件', text: '【第1页，OCR识别待核对】\n第一章 考勤\n员工可在三个工作日内补正。\n第二章 处理\n员工仅可在一个工作日内补正。' }]).chunks
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((chunk) => chunk.sourceNeedsVerification))
})
await test('明确归并可增加背景引文，但必须完整保留旧冲突的每个定位区间', () => {
  const chunks = buildHandbookStructure([{ fileId: 'a', fileName: '背景', text: '两章同日起适用于同一员工。' },
    { fileId: 'b', fileName: '条款一', text: '员工可在三个工作日内补正。其他员工应当做好安全检查。' },
    { fileId: 'c', fileName: '条款二', text: '超过一个工作日未补正即按旷工处理。其他员工不得跳过安全检查。' }]).chunks
  const make = (title, evidence) => normalizeHandbookFindings([{ kind: 'conflict', title, explanation: '具体处理不同', evidence, authorities: [] }], chunks)[0]
  const refs = chunks.map((chunk) => ({ chunkId: chunk.id, quote: chunk.text }))
  const old = make('原冲突', refs.slice(1)), expanded = { ...make('补充背景的同一冲突', refs), supersedesFindingIds: [old.id] }
  assert.equal(mergeHandbookFindings([old], [expanded], [old.id]).length, 1)
  const unrelated = { ...make('另一冲突', [refs[0], { chunkId: chunks[1].id, quote: '其他员工应当做好安全检查。' },
    { chunkId: chunks[2].id, quote: '其他员工不得跳过安全检查。' }]), supersedesFindingIds: [old.id] }
  assert.equal(mergeHandbookFindings([old], [unrelated], [old.id]).length, 2)
})
await test('同一正文块内的两条矛盾规则可以定位，重复或重叠引文不能冒充冲突双方', () => {
  const first = '员工可在三个工作日内补正。', second = '超过一个工作日即拒绝补正。'
  const chunk = buildHandbookStructure([{ fileId: 'a', fileName: '制度', text: `${first}\n${second}` }]).chunks[0]
  const make = (quotes) => normalizeHandbookFindings([{ kind: 'conflict', title: '内部补正期限冲突', explanation: '同一对象期限不同', status: 'risk',
    evidence: quotes.map((quote) => ({ chunkId: chunk.id, quote })), authorities: [] }], [chunk])[0]
  assert.equal(make([first, second]).locationStatus, 'found')
  assert.equal(make([first, second]).status, 'risk')
  for (const quotes of [[first, first], [first, '三个工作日内补正']]) {
    assert.equal(make(quotes).locationStatus, 'unverified')
    assert.equal(make(quotes).suggestedClause, '')
  }
})

await test('手册脱敏保留公司泛称前的怀孕条件和补正期限，实名主体与直接标识仍替换', async () => {
  const runner = makeRunner(), messages = []
  const source = '公司名称：虚构澄星科技有限公司\n第一章 考勤与保护\n第一条 员工怀孕后公司不得仅因此解除劳动合同。\n第二条 从考勤异常通知送达次日起三个工作日内可通过公司考勤系统提交证据。\n联系人：张三；电话13812345678。'
  await runHandbookDiagnosis({ ...runner.options, fakeLlm: false, input: { text: source },
    generateCompletion: async (prompt, message) => {
      messages.push(message)
      const payload = JSON.parse(message)
      const stage = prompt.includes('本阶段只判断') ? 'scope' : payload.pairs ? 'relations' : 'review'
      return { content: JSON.stringify(fakeHandbookResponse(stage, payload)), finishReason: 'stop' }
    } })
  assert.ok(messages.some((message) => message.includes('员工怀孕后公司')))
  assert.ok(messages.some((message) => message.includes('从考勤异常通知送达次日起三个工作日内可通过公司')))
  assert.ok(messages.every((message) => !message.includes('虚构澄星科技有限公司') && !message.includes('13812345678') && !message.includes('张三')))
})

for (const repair of [false, true]) await test(repair ? '引用归属纠正仅重试一次并验证当前块' : 'context引用不能代替当前块的条款诊断', async () => {
  let corrections = 0
  const run = () => runHandbookDiagnosis({ ...makeRunner().options, input: { text }, fakeLlm: false, generateCompletion: async (prompt, message) => {
    const payload = JSON.parse(message)
    if (payload.chunk && !payload.context) return { content: JSON.stringify(fakeHandbookResponse('scope', payload)) }
    if (payload.pairs) return { content: JSON.stringify({ complete: true, findings: [], checkedRelationIds: payload.pairs.map((pair) => pair.id) }) }
    const partner = payload.context?.find((chunk) => chunk.text.includes('第三条'))
    if (payload.chunk?.text.includes('第一条') && partner) {
      const correcting = prompt.includes('引用归属需纠正')
      if (correcting) corrections += 1
      const source = repair && correcting ? payload.chunk : partner
      return { content: JSON.stringify({ complete: true, findings: [{ kind: 'clause', title: '原文条件待核实', explanation: '测试引用归属', evidence: [{ chunkId: source.id, quote: source.text }] }] }) }
    }
    return { content: JSON.stringify({ complete: true, findings: [] }) }
  } })
  if (repair) assert.equal((await run()).analysisStatus, 'completed')
  else await assert.rejects(run, /当前.*引用/)
  assert.equal(corrections, 1)
})
for (const retain of [false, true]) await test(retain ? '关联归并可明确保留独立冲突' : '关联归并不能遗漏已提供冲突的处置', async () => {
  const run = () => runHandbookDiagnosis({ ...makeRunner().options, input: { text }, fakeLlm: false, generateCompletion: async (prompt, message) => {
    const payload = JSON.parse(message)
    if (payload.chunk && !payload.context) return { content: JSON.stringify(fakeHandbookResponse('scope', payload)) }
    if (payload.pairs) return { content: JSON.stringify({ complete: true, findings: retain ? payload.findings : [], checkedRelationIds: payload.pairs.map((pair) => pair.id) }) }
    const partner = payload.context?.find((chunk) => chunk.text.includes('第三条'))
    const findings = payload.chunk?.text.includes('第一条') && partner ? [{ kind: 'conflict', title: '同一迟到处理需协调', explanation: '两处规则需要同时核对',
      evidence: [payload.chunk, partner].map((chunk) => ({ chunkId: chunk.id, quote: chunk.text })) }] : []
    return { content: JSON.stringify({ complete: true, findings }) }
  } })
  if (retain) assert.equal((await run()).analysisStatus, 'completed')
  else await assert.rejects(run, /归并.*处置/)
})
await test('非冲突条款的时点不能在修订稿中无确认地漂移', () => {
  const chunks = buildHandbookStructure([{ fileId: 'time', fileName: '到岗规则', text: '办公室员工每个工作日上午十时到岗。' }]).chunks
  const input = { kind: 'clause', title: '条件待补充', explanation: '补充依法请假的例外', evidence: [{ chunkId: chunks[0].id, quote: chunks[0].text }], authorities: [],
    suggestedClause: '办公室员工每个工作日上午九时到岗；依法请假除外。' }
  const changed = normalizeHandbookFindings([input], chunks)[0]
  assert.equal(changed.locationStatus, 'found')
  assert.equal(changed.suggestedClause, '')
  assert.match(changed.verificationNote, /时点/)
  const equivalent = normalizeHandbookFindings([{ ...input, suggestedClause: '办公室员工每个工作日上午10点到岗；依法请假除外。' }], chunks)[0]
  assert.ok(equivalent.suggestedClause)
  const proposed = normalizeHandbookFindings([{ ...input, suggestedClause: '办公室员工每个工作日上午【待确认：九时】到岗；依法请假除外。' }], chunks)[0]
  assert.ok(proposed.suggestedClause)
})
await test('关联已召回时，正文上下文不能被封面背景挤掉', async () => {
  const files = [
    { id: 'pay-a', originalname: '发薪安排.txt', buffer: Buffer.from('中国大陆普通标准工时员工，同一版本。\n第一章 发薪安排\n第一条 同一员工同一月份的劳动报酬固定每月十五日发放。') },
    { id: 'pay-b', originalname: '薪金安排.txt', buffer: Buffer.from('中国大陆普通标准工时员工，同一版本。\n第二章 薪金安排\n第二条 同一员工同一月份的薪金固定每月十日发放。') }
  ]
  let checked = false
  await runHandbookDiagnosis({ ...makeRunner().options, files, fakeLlm: false, generateCompletion: async (prompt, message) => {
    const input = JSON.parse(message)
    if (input.chunk && !input.context) return { content: JSON.stringify({ complete: true, type: 'policy-fragment', acceptedEvidence: input.chunk.text, background: {}, relatedSections: [] }) }
    if (input.chunk?.text.includes('十五日')) {
      checked = true
      assert.ok(input.context.some((chunk) => chunk.text.includes('薪金固定每月十日')), '已召回的十日薪金条款未进入上下文')
    }
    return { content: JSON.stringify({ complete: true, findings: [], questions: [], checkedRelationIds: input.pairs?.map((pair) => pair.id) || [] }) }
  } })
  assert.ok(checked)
})
await test('分块保留全部原文，长段落不截断且位置能复原', () => {
  const source = { fileId: 'a', fileName: '合成手册', text: text + '第三章 长条款\n' + '员工应遵守安全规定。'.repeat(1000) }
  const structure = buildHandbookStructure([source], { budget: 80 })
  assert.equal(structure.chunks.map((chunk) => chunk.text).join(''), source.text)
  assert.ok(structure.chunks.length > 10)
  for (const chunk of structure.chunks) assert.equal(source.text.slice(chunk.startOffset, chunk.endOffset), chunk.text)
})
await test('关联确认可接受明确true的对象，false和遗漏仍阻止完成', async () => {
  for (const checked of [true, false, undefined]) {
    const runner = makeRunner()
    const run = () => runHandbookDiagnosis({ ...runner.options, fakeLlm: false, input: { text },
      generateCompletion: async (prompt, message) => {
        const payload = JSON.parse(message)
        const stage = prompt.includes('本阶段只判断') ? 'scope' : payload.pairs ? 'relations' : 'review'
        const output = fakeHandbookResponse(stage, payload)
        if (stage === 'relations') output.checkedRelationIds = payload.pairs.map((pair) => ({ pairId: pair.id, checked }))
        return { content: JSON.stringify(output), finishReason: 'stop' }
      } })
    if (checked === true) {
      const report = await run()
      assert.equal(report.analysisStatus, 'completed')
      assert.equal(report.relationCoverage.completed, report.relationCoverage.total)
    } else await assert.rejects(run, /跨章节关系尚未全部检查/)
  }
})
await test('重复原文不猜位置，引用不存在不放行', () => {
  const chunk = buildHandbookStructure([{ fileId: 'a', fileName: '测试', text: '员工应遵守规定。\n员工应遵守规定。' }]).chunks[0]
  assert.equal(locateHandbookQuote('员工应遵守规定。', chunk).status, 'ambiguous')
  assert.equal(locateHandbookQuote('累计旷工三日解除', chunk).status, 'not-found')
})
await test('同一原文的不同问题不丢失，虚构引用不生成修订文本', () => {
  const chunk = buildHandbookStructure([{ fileId: 'a', fileName: '测试', text: '员工迟到一次，公司可以解除劳动合同。' }]).chunks[0]
  const findings = normalizeHandbookFindings(['条件不清', '流程不清'].map((title) => ({ title, topic: '考勤', explanation: title,
    evidence: [{ chunkId: chunk.id, quote: chunk.text }], suggestedClause: '示例' })), [chunk])
  assert.notEqual(findings[0].id, findings[1].id)
  const ungrounded = normalizeHandbookFindings([{ title: '模型虚构', explanation: '未引用上传正文', evidence: [{ chunkId: chunk.id, quote: '旧参考手册中的条款' }], suggestedClause: '不能发布' }], [chunk])[0]
  assert.equal(ungrounded.status, 'pending'); assert.equal(ungrounded.suggestedClause, '')
})
await test('首页说明即使出现员工手册字样也不生成报告', async () => {
  const runner = makeRunner()
  const report = await runHandbookDiagnosis({ ...runner.options, input: { text: '员工手册诊断\n员工手册分析助手\n您好，请直接上传需要分析的员工手册图片。\n发送消息\n由扣子提供' } })
  assert.equal(report.analysisStatus, 'blocked'); assert.equal(report.findings.length, 0)
  assert.equal(runner.events.some((event) => event.event === 'stage.start' && event.payload.stage === 'review'), false)
})
await test('模型不列法规也不能把条款合法性发布为已核实判断', () => {
  const chunk = buildHandbookStructure([{ fileId: 'a', fileName: '合成制度', text: '员工任何一次迟到均直接解除劳动合同。' }]).chunks[0]
  const finding = normalizeHandbookFindings([{ kind: 'clause', title: '解除条件', explanation: '需核实处理条件与法律适用',
    level: 'high', status: 'risk', evidence: [{ chunkId: chunk.id, quote: chunk.text }], authorities: [] }], [chunk])[0]
  assert.equal(finding.status, 'pending')
  assert.equal(finding.level, 'high')
  assert.match(finding.verificationNote, /具体法律依据尚未核实/)
})
await test('冲突归并需模型明确选择且两处来源一致，不吞掉独立条款或不同来源', () => {
  const chunks = buildHandbookStructure([{ fileId: 'a', fileName: '合成制度', text }]).chunks
  const raw = (title, kind = 'conflict', evidenceChunks = chunks.slice(1)) => ({ title, kind, explanation: title, status: 'pending',
    conditions: [title], evidence: evidenceChunks.map((chunk) => ({ chunkId: chunk.id, quote: chunk.text.trim() })) })
  const previous = normalizeHandbookFindings([raw('重复冲突一'), raw('重复冲突二'), raw('独立条款问题', 'clause')], chunks)
  const incoming = normalizeHandbookFindings([{ ...raw('合并后的冲突'), supersedesFindingIds: previous.map((item) => item.id) }], chunks)
  const merged = mergeHandbookFindings(previous, incoming, previous.map((item) => item.id))
  assert.equal(merged.length, 2); assert.ok(merged.some((item) => item.kind === 'clause'))
  assert.deepEqual(merged.find((item) => item.kind === 'conflict').conditions, ['重复冲突二', '重复冲突一', '合并后的冲突'])
  assert.equal(mergeHandbookFindings(previous, incoming, []).length, 4)
  const differentSource = normalizeHandbookFindings([{ ...raw('另一对来源', 'conflict', chunks.slice(0, 2)), supersedesFindingIds: [previous[0].id] }], chunks)
  assert.equal(mergeHandbookFindings(previous, differentSource, [previous[0].id]).length, 4)
})
await test('短条款可以诊断，章节冲突关联两处原文并完成全部关系检查', async () => {
  const runner = makeRunner()
  const report = await runHandbookDiagnosis({ ...runner.options, task: { id: 'task-a' }, input: { text } })
  assert.equal(report.analysisStatus, 'completed')
  assert.ok(report.coverage.every((item) => item.status === 'completed'))
  assert.equal(report.relationCoverage.completed, report.relationCoverage.total)
  const conflict = report.findings.find((finding) => finding.kind === 'conflict')
  assert.ok(conflict); assert.equal(conflict.evidence.length, 2)
  for (const citation of conflict.evidence) assert.equal(citation.location.status, 'found')
  const short = await runHandbookDiagnosis({ ...makeRunner().options, input: { text: '员工须按实际出勤记录申请考勤补正。' } })
  assert.equal(short.analysisStatus, 'completed'); assert.equal(short.scope.kind, 'fragment')
  assert.equal('score' in short, false)
})
await test('明确归并可用唯一原文修复同来源的错误引文，不能替换其他来源', () => {
  const chunks = buildHandbookStructure([{ fileId: 'a', fileName: '合成制度', text }]).chunks.slice(1)
  const raw = { kind: 'conflict', topic: '考勤', title: '同一矛盾的草稿', explanation: '同一事项处理不一致',
    evidence: chunks.map((chunk) => ({ chunkId: chunk.id, quote: chunk.text.trim() })) }
  const wrong = normalizeHandbookFindings([{ ...raw, evidence: raw.evidence.map((item, index) => index ? item : { ...item, quote: '不存在的草稿原文' }) }], chunks)[0]
  assert.equal(wrong.locationStatus, 'unverified')
  const corrected = normalizeHandbookFindings([{ ...raw, title: '原文修正后的同一矛盾', supersedesFindingIds: [wrong.id] }], chunks)
  const merged = mergeHandbookFindings([wrong], corrected, [wrong.id])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].locationStatus, 'found')
  assert.ok(merged[0].evidence.every((item) => item.location.status === 'found'))
})
await test('解析失败先暂停，明确选择已读部分后才继续', async () => {
  const runner = makeRunner()
  const files = [{ id: 'bad', originalname: '损坏.docx' }]
  const parseFile = async () => { throw new Error('文件损坏') }
  const blocked = await runHandbookDiagnosis({ ...runner.options, files, parseFile, input: { text } })
  assert.equal(blocked.analysisStatus, 'blocked'); assert.equal(blocked.unreadableMaterials.length, 1)
  const readable = await runHandbookDiagnosis({ ...runner.options, files, parseFile, input: { text, allowPartial: true } })
  assert.equal(readable.analysisStatus, 'completed'); assert.equal(readable.unreadableMaterials.length, 1)
})
await test('输出截断不能宣布完成，失败重试复用已完成检查点', async () => {
  const runner = makeRunner()
  let calls = 0
  let fail = true
  const generateCompletion = async (prompt, message) => {
    calls += 1
    const payload = JSON.parse(message)
    const kind = prompt.includes('本阶段只判断') ? 'scope' : prompt.includes('核对提供的两处') ? 'relations' : 'review'
    if (kind === 'relations' && fail) return { content: '{}', finishReason: 'length' }
    return { content: JSON.stringify(fakeHandbookResponse(kind, payload)), finishReason: 'stop' }
  }
  await assert.rejects(runHandbookDiagnosis({ ...runner.options, fakeLlm: false, generateCompletion, input: { text } }), (cause) => cause.code === 'handbook_output_truncated')
  const partial = runner.checkpoints.get('handbook-report').result.result
  assert.equal(partial.analysisStatus, 'streaming'); assert.ok(partial.findings.length)
  const before = calls; fail = false
  const done = await runHandbookDiagnosis({ ...runner.options, fakeLlm: false, generateCompletion, input: { text } })
  assert.equal(done.analysisStatus, 'completed'); assert.equal(calls - before, 1)
})
await test('取消停止后续模型调用，模型未完成 JSON 不成为检查点', async () => {
  const runner = makeRunner(); let calls = 0
  await assert.rejects(runHandbookDiagnosis({ ...runner.options, isCancellationRequested: () => true, input: { text },
    generateCompletion: async () => { calls += 1 } }), (cause) => cause.code === 'TASK_CANCELLED')
  assert.equal(calls, 0)
  await assert.rejects(runHandbookDiagnosis({ ...runner.options, fakeLlm: false, input: { text },
    generateCompletion: async () => ({ content: '{"complete":true', finishReason: 'stop' }) }), /完整的诊断 JSON/)
  assert.equal([...runner.checkpoints.keys()].some((key) => key.startsWith('handbook-scope:')), false)
})
await test('模型标题只辅助分块，原文不符的标题与背景不能生效', async () => {
  const runner = makeRunner()
  const source = '员工制度\n出勤管理\n员工应按时出勤。\n薪酬管理\n公司应按约定支付工资。'
  const generateCompletion = async (prompt, message) => {
    const payload = JSON.parse(message)
    const kind = prompt.includes('本阶段只判断') ? 'scope' : prompt.includes('核对提供的两处') ? 'relations' : 'review'
    const response = fakeHandbookResponse(kind, payload)
    if (kind === 'scope') {
      response.background = { region: '不存在的地区' }
      response.suggestedHeadings = ['出勤管理', '薪酬管理', '模型虚构章节'].map((title) => ({ title, quote: title }))
    }
    return { content: JSON.stringify(response), finishReason: 'stop' }
  }
  const report = await runHandbookDiagnosis({ ...runner.options, fakeLlm: false, input: { text: source }, generateCompletion })
  assert.equal(report.analysisStatus, 'completed')
  assert.ok(report.coverage.some((item) => item.sectionTitle === '出勤管理'))
  assert.ok(report.coverage.some((item) => item.sectionTitle === '薪酬管理'))
  assert.equal(report.coverage.some((item) => item.sectionTitle === '模型虚构章节'), false)
  assert.equal(report.scope.background.region, '')
})
await test('不完整问题不保存成功检查点，修复后能重新调用完成', async () => {
  const runner = makeRunner(); let invalid = true
  const generateCompletion = async (prompt, message) => {
    const payload = JSON.parse(message)
    const kind = prompt.includes('本阶段只判断') ? 'scope' : prompt.includes('核对提供的两处') ? 'relations' : 'review'
    const response = fakeHandbookResponse(kind, payload)
    if (kind === 'review' && invalid) response.findings = [{ title: '缺少说明' }]
    return { content: JSON.stringify(response), finishReason: 'stop' }
  }
  await assert.rejects(runHandbookDiagnosis({ ...runner.options, fakeLlm: false, input: { text }, generateCompletion }), /缺少标题或说明/)
  assert.equal([...runner.checkpoints.keys()].some((key) => key.startsWith('handbook-review:')), false)
  invalid = false
  assert.equal((await runHandbookDiagnosis({ ...runner.options, fakeLlm: false, input: { text }, generateCompletion })).analysisStatus, 'completed')
})
await test('参考资料按外部版本读取，不作为上传原文或法律标准', async () => {
  const manifest = join(directory, 'references.json')
  writeFileSync(join(directory, 'sample.txt'), '员工须遵守本参考制度。')
  writeFileSync(manifest, JSON.stringify({ documents: [{ id: 'old', title: '旧版临时参考', version: 'old-v1', role: 'reference', filePath: 'sample.txt' }] }))
  const references = await loadHandbookReferences({ manifestPath: manifest })
  assert.equal(references.versions[0].role, 'reference'); assert.equal('filePath' in references.versions[0], false)
  const runner = makeRunner()
  const report = await runHandbookDiagnosis({ ...runner.options, input: { text }, referenceLoader: async () => references })
  assert.equal(report.referenceVersions[0].version, 'old-v1')
  assert.equal(report.sourceDocuments.some((doc) => doc.fileId.startsWith('reference:')), false)
})
await test('进度流跨网络包的 CRLF 和中文字符能完整读取', async () => {
  const bytes = new TextEncoder().encode('id: 1\r\nevent: handbook.snapshot\r\ndata: {"label":"检查中"}\r\n\r\n')
  const events = []
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  await readHandbookEvents(new Response(stream), (event, payload, sequence) => events.push({ event, payload, sequence }))
  assert.deepEqual(events, [{ event: 'handbook.snapshot', payload: { label: '检查中' }, sequence: 1 }])
})

const database = createBusinessDatabase(':memory:')
for (const id of ['user-a', 'user-b']) {
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)').run(`invite-${id}`, `hash-${id}`, new Date().toISOString())
  database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.test`, 'hash', 'salt', `invite-${id}`, new Date().toISOString())
}
const service = createTaskService(database)
const store = createTaskFileStore({ root: join(directory, 'uploads') })
const processor = createTaskProcessor({ taskService: service, fileStore: store, fakeLlm: true,
  handbookWorkflow: (options) => runHandbookDiagnosis({ ...options, referenceLoader: noReferences, lawLoader: async () => [] }) })
const queue = createTaskQueue({ taskService: service, processTask: processor.processTask, mode: 'local', workerEnabled: true, pollIntervalMs: 15 })
const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: req.get('X-Test-User') || 'user-a' }; next() })
app.use('/api', createTaskRouter({ taskService: service, taskQueue: queue, fileStore: store, fakeLlm: true }))
const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
const url = `http://127.0.0.1:${server.address().port}`
const request = (path, options = {}) => fetch(url + path, options)
const wait = async (taskId) => {
  for (let round = 0; round < 200; round += 1) {
    const task = service.getTask(taskId, 'user-a')
    if (service.isTerminal(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('诊断任务等待超时')
}
try {
  await queue.start()
  await test('真实任务接口支持 DOCX 和粘贴文本，SSE 可回放并恢复报告', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.trim().split('\n').map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
    const body = new FormData(); body.append('files', new Blob([await zip.generateAsync({ type: 'nodebuffer' })]), '合成员工手册.docx'); body.append('mode', 'fast')
    const response = await request('/api/tasks/handbook-diagnosis', { method: 'POST', body })
    assert.equal(response.status, 202)
    const created = await response.json(); assert.equal(created.productId, 'handbook-diagnosis'); assert.equal('storagePath' in created.task.files[0], false)
    const done = await wait(created.taskId); assert.equal(done.status, 'succeeded'); assert.equal(done.result.analysisStatus, 'completed')
    const replay = await request(`/api/tasks/${created.taskId}/events?after=0`); assert.match(await replay.text(), /event: handbook\.snapshot/)
    const report = await request(`/api/tasks/handbook-diagnosis/${created.taskId}/report`); assert.equal((await report.json()).report.sourceDocuments.length, 1)
    const history = await request(`/api/tasks/handbook-diagnosis/thread/${created.threadId}`); assert.equal((await history.json()).tasks.length, 1)
    const other = await request(`/api/tasks/handbook-diagnosis/${created.taskId}/report`, { headers: { 'X-Test-User': 'user-b' } }); assert.equal(other.status, 404)
    const followup = await request('/api/tasks/handbook-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'followup', threadId: created.threadId, sourceTaskId: created.taskId, message: '解释迟到问题' }) })
    assert.equal(followup.status, 202); assert.equal((await wait((await followup.json()).taskId)).result.kind, 'followup')
    const foreign = await request('/api/tasks/handbook-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': 'user-b' }, body: JSON.stringify({ action: 'restart', sourceTaskId: created.taskId }) }); assert.equal(foreign.status, 404)
    const deleted = await request(`/api/tasks/handbook-diagnosis/thread/${created.threadId}`, { method: 'DELETE' }); assert.equal(deleted.status, 200)
    assert.equal((await request(`/api/tasks/handbook-diagnosis/${created.taskId}/report`)).status, 404)
  })
  await test('重复同会话任务有数据库门禁，不同会话和产品保持隔离', async () => {
    service.createTask({ id: 'first', userId: 'user-a', productId: 'handbook-diagnosis', threadId: 'busy', input: { text } })
    assert.throws(() => service.createTask({ userId: 'user-a', productId: 'handbook-diagnosis', threadId: 'busy' }), /UNIQUE/)
    const conflict = await request('/api/tasks/handbook-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, threadId: 'busy' }) }); assert.equal(conflict.status, 409)
    const crossProduct = service.createTask({ id: 'other-product', userId: 'user-a', productId: 'contract-review', threadId: 'other' })
    const misuse = await request('/api/tasks/handbook-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restart', sourceTaskId: crossProduct.id }) }); assert.equal(misuse.status, 404)
  })
  await test('连续停止尚未解析的文件后能恢复原件，过期会话不能恢复', async () => {
    const rootId = 'cancelled-upload-root'
    const saved = await store.saveIncomingFiles(rootId, [{ originalname: '合成制度.txt', mimetype: 'text/plain', buffer: Buffer.from(text) }])
    service.createTask({ id: rootId, userId: 'user-a', productId: 'handbook-diagnosis', threadId: rootId,
      input: { action: 'analyze' }, files: saved.map((file, index) => ({ ...file, id: `cancelled-file-${index}` })) })
    service.markCancelled(rootId)
    const firstResume = service.createTask({ id: 'cancelled-resume', userId: 'user-a', productId: 'handbook-diagnosis', threadId: rootId,
      input: { action: 'restart', sourceTaskId: rootId, materialTaskId: rootId } })
    service.markCancelled(firstResume.id)
    const resumed = await request('/api/tasks/handbook-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restart', sourceTaskId: firstResume.id }) })
    assert.equal(resumed.status, 202)
    const final = await wait((await resumed.json()).taskId)
    assert.equal(final.status, 'succeeded'); assert.equal(final.result.sourceDocuments[0].text, text)
    service.createTask({ id: 'expired-handbook', userId: 'user-a', productId: 'handbook-diagnosis', threadId: 'expired-handbook', input: { text } })
    service.markCancelled('expired-handbook')
    database.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', 'expired-handbook')
    assert.equal((await request('/api/tasks/handbook-diagnosis/expired-handbook/report')).status, 410)
    assert.equal((await request('/api/tasks/handbook-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restart', sourceTaskId: 'expired-handbook' }) })).status, 410)
  })
  await test('已确认只检查可读部分的报告仍可追问', async () => {
    const partial = await runHandbookDiagnosis({ ...makeRunner().options, input: { text, allowPartial: true }, files: [{ id: 'bad-partial', originalname: '损坏附件.docx' }],
      parseFile: async () => { throw new Error('合成损坏文件') } })
    const source = service.createTask({ id: 'partial-report', userId: 'user-a', productId: 'handbook-diagnosis', threadId: 'partial-report', input: { text, action: 'analyze', allowPartial: true } })
    service.claimTask(source.id)
    service.saveCheckpoint(source.id, 'handbook-parsing', { documents: partial.sourceDocuments, failures: partial.unreadableMaterials, warnings: [] })
    service.completeTask(source.id, partial)
    const followup = await request('/api/tasks/handbook-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'followup', sourceTaskId: source.id, message: '说明当前检查范围' }) })
    assert.equal(followup.status, 202)
    const created = await followup.json()
    assert.equal((await wait(created.taskId)).result.kind, 'followup')
    assert.equal((await (await request(`/api/tasks/handbook-diagnosis/${created.taskId}/report`)).json()).sourceTaskId, source.id)
  })
  console.log(`员工手册专项：${passed} 项通过。测试资料目录：${directory}`)
} finally {
  await queue.close(); await new Promise((resolve) => server.close(resolve)); database.close(); closeLaws()
}
