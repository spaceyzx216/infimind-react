/**
 * 用工咨询回归测试（无需调用模型）。
 *
 * 覆盖三件事：
 *   1. 法规白名单种子与时效判定
 *   2. 引用校验：正确引用 / 不存在版本 / 已废止法规 / 未收录法规 / 无书名号引用
 *   3. 案例库 2-gram 中文检索（对比验证分词修复有效）
 *
 * 用法：npm run test:labor-consult
 */
import assert from 'node:assert/strict'
import {
  initialize,
  seedLawWhitelist,
  seedLaborCases,
  listLawsForBaseline,
  searchCases,
  getLaborStatus,
  resolveLawStatus,
  findLaw,
  close
} from '../services/law-whitelist.js'
import { extractCitations, verifyOutput, renderCitationNotice, looksLikeLegalNorm } from '../services/citation-verifier.js'
import { toIndexText, toQueryTerm, extractKeywords } from '../services/cjk-tokenizer.js'
import { parseLaborBook, detectRunningHeaders, extractCaseNumbers, normalizeContent } from '../services/labor-book-parser.js'
import { initializeLaborKb, getLaborKbStatus, searchLaborKb } from '../services/labor-kb.js'
import { initializeLaborVector, getLaborVectorStatus, searchVector, resetIndexCache } from '../services/labor-vector.js'
import { getDb } from '../services/law-whitelist.js'
import { validateRewrite, formatRewriteContext } from '../services/query-rewriter.js'
import { mergeSelectedFiles, isSupportedFile, describeRejection } from '../../src/utils/file-selection.js'

let passed = 0
let failed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ❌ ${name}`)
    console.error(`     ${error.message}`)
  }
}

/** 异步用例（混合检索会调用外部 embedding / rerank 服务） */
const atest = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ❌ ${name}`)
    console.error(`     ${error.message}`)
  }
}

console.log('\n=== 用工咨询回归测试 ===\n')

initialize()
const lawSeed = seedLawWhitelist()
const caseSeed = seedLaborCases()
console.log(`[准备] 法规白名单 +${lawSeed.inserted}（已存在 ${lawSeed.skipped}）；案例 +${caseSeed.inserted}（已存在 ${caseSeed.skipped}）\n`)

const laws = listLawsForBaseline({ today: new Date() })
const today = new Date()

// ---------------------------------------------------------------------------
console.log('1. 分词工具（2-gram）')
// ---------------------------------------------------------------------------
test('toIndexText 把中文展开为 bigram', () => {
  const out = toIndexText('付款')
  assert.equal(out, '付款')
  assert.equal(toIndexText('违约金'), '违约 约金')
})
test('toQueryTerm 两字词为单 bigram，多字词为短语', () => {
  assert.equal(toQueryTerm('付款'), '"付款"')
  assert.equal(toQueryTerm('违约金'), '"违约 约金"')
})
test('无分词修复时命中 0 条的场景，bigram 后可命中（模拟）', () => {
  // 「付款」在 unicode61 下是整段中文的一个 token 的一部分，精确匹配命中 0；
  // bigram 后变成可独立匹配的 token。
  const indexed = toIndexText('甲方应于收到发票后付款')
  assert.ok(indexed.split(' ').includes('付款'), '索引态应包含独立 token「付款」')
})
test('extractKeywords 过滤停用词', () => {
  const keys = extractKeywords('请问公司可以因为员工怀孕降低工资吗')
  assert.ok(keys.includes('怀孕'), '应保留「怀孕」')
  assert.ok(keys.includes('降低工资'), '应保留「降低工资」')
  assert.ok(!keys.includes('请问'), '应过滤「请问」')
})

// ---------------------------------------------------------------------------
console.log('\n2. 法规白名单与时效判定')
// ---------------------------------------------------------------------------
test('白名单已载入', () => {
  assert.ok(laws.length >= 15, `期望至少 15 条，实际 ${laws.length}`)
})
test('现行有效法规被列入基准', () => {
  const law = laws.find((item) => item.title.includes('劳动合同法') && !item.title.includes('实施条例'))
  assert.ok(law, '应包含劳动合同法')
  assert.equal(law.effectiveFrom, '2013-07-01')
  assert.equal(law.status, 'effective')
})
test('延迟退休决定施行日期为 2025-01-01（非 2026）', () => {
  const law = findLaw('渐进式延迟法定退休年龄的决定')
  assert.ok(law, '应找到延迟退休决定')
  assert.equal(law.effectiveFrom, '2025-01-01')
})
test('已废止法规被识别（合同法 → 民法典）', () => {
  const law = findLaw('合同法')
  assert.ok(law)
  assert.equal(law.status, 'repealed')
  assert.equal(resolveLawStatus(law, today), 'repealed')
})
test('别名匹配生效', () => {
  assert.ok(findLaw('劳动合同法'))
  assert.ok(findLaw('调解仲裁法'))
  assert.ok(findLaw('年休假条例'))
})
test('未收录法规返回 not_found', () => {
  assert.equal(resolveLawStatus(null, today), 'not_found')
})

// ---------------------------------------------------------------------------
console.log('\n3. 引用抽取')
// ---------------------------------------------------------------------------
test('抽取书名号 + 条号', () => {
  const { citations } = extractCitations('依据《中华人民共和国劳动合同法》第三十八条，劳动者可以解除。')
  assert.equal(citations.length, 1)
  assert.equal(citations[0].lawName, '中华人民共和国劳动合同法')
  assert.equal(citations[0].articleNo, '三十八')
  assert.equal(citations[0].hasBrackets, true)
})
test('抽取无书名号引用（依赖白名单别名）', () => {
  const { citations } = extractCitations('根据劳动合同法第三十八条的规定……', { laws })
  assert.equal(citations.length, 1)
  assert.equal(citations[0].lawName, '劳动合同法')
  assert.equal(citations[0].hasBrackets, false)
})
test('识别版本年份提示', () => {
  const { citations } = extractCitations('根据《中华人民共和国劳动合同法》2025年修订版第三十八条……')
  assert.equal(citations.length, 1)
  assert.ok(citations[0].versionHint.includes('2025'), `实际 versionHint=${citations[0].versionHint}`)
})
test('同一引用不重复计数', () => {
  const { citations } = extractCitations('《中华人民共和国劳动合同法》第三十八条与《中华人民共和国劳动合同法》第三十九条')
  assert.equal(citations.length, 2)
})
test('looksLikeLegalNorm 区分法规与材料标题', () => {
  assert.equal(looksLikeLegalNorm('中华人民共和国劳动合同法'), true)
  assert.equal(looksLikeLegalNorm('劳务派遣暂行规定'), true)
  assert.equal(looksLikeLegalNorm('职工带薪年休假条例'), true)
  assert.equal(looksLikeLegalNorm('最高人民法院关于审理劳动争议案件适用法律问题的解释（一）'), true)
  assert.equal(looksLikeLegalNorm('派遣员工劳动合同书'), false, '合同标题不是法规')
  assert.equal(looksLikeLegalNorm('员工手册'), false)
  assert.equal(looksLikeLegalNorm('解除劳动合同通知书'), false)
})
test('分析上传材料时，材料标题不被当成法规引用', () => {
  const text = '附件1《派遣员工劳动合同书》第七条约定……依据《中华人民共和国劳动合同法》第三十八条，公司存在风险。'
  const { citations, ignored } = extractCitations(text)
  assert.equal(citations.length, 1, '只应保留真正的法规引用')
  assert.equal(citations[0].lawName, '中华人民共和国劳动合同法')
  assert.ok(ignored.includes('派遣员工劳动合同书'), '材料标题应被记入 ignored 而不是报错')
})
test('excludeTitles 可排除指定名称', () => {
  const text = '《某公司员工手册》与《中华人民共和国劳动法》均需核对。'
  const { citations } = extractCitations(text, { excludeTitles: ['某公司员工手册'] })
  assert.equal(citations.length, 1)
  assert.equal(citations[0].lawName, '中华人民共和国劳动法')
})

// ---------------------------------------------------------------------------
console.log('\n4. 引用校验（核心防幻觉能力）')
// ---------------------------------------------------------------------------
test('正确的现行法规引用 → verified', () => {
  const { citations } = verifyOutput('依据《中华人民共和国劳动合同法》第三十八条处理。', { laws, today })
  assert.equal(citations.length, 1)
  assert.equal(citations[0].status, 'verified')
  assert.equal(citations[0].ok, true)
})
test('已废止法规引用 → repealed 且不通过', () => {
  const { citations } = verifyOutput('依据《中华人民共和国合同法》第一百零七条主张违约责任。', { laws, today })
  assert.equal(citations[0].status, 'repealed')
  assert.equal(citations[0].ok, false)
  assert.ok(citations[0].note.includes('民法典'), `note 应指出取代法规，实际：${citations[0].note}`)
})
test('不存在的版本号 → 被标记为问题（即使法规本身有效）', () => {
  const { citations, summary } = verifyOutput('根据《中华人民共和国劳动合同法》2025年修订版第三十八条。', { laws, today })
  assert.equal(citations[0].status, 'verified', '法规本身应在白名单内')
  assert.equal(citations[0].ok, false, '但版本号不存在，应判为问题')
  assert.equal(summary.hasProblems, true)
  assert.ok(citations[0].note.includes('2025'), `note 应指出异常版本，实际：${citations[0].note}`)
})
test('未收录法规 → not_found 且不通过', () => {
  const { citations } = verifyOutput('依据《中华人民共和国某某特别法》第一条。', { laws, today })
  assert.equal(citations[0].status, 'not_found')
  assert.equal(citations[0].ok, false)
  assert.ok(citations[0].note.includes('白名单'))
})
test('summary 统计正确', () => {
  const text = '依据《中华人民共和国劳动合同法》第三十八条、《中华人民共和国合同法》第一百零七条、《虚构法》第一条。'
  const { summary } = verifyOutput(text, { laws, today })
  assert.equal(summary.total, 3)
  assert.equal(summary.ok, 1)
  assert.equal(summary.problems, 2)
  assert.equal(summary.notFound, 1)
})
test('无引用时 summary 无问题', () => {
  const { summary } = verifyOutput('这是一段没有任何法条引用的回答。', { laws, today })
  assert.equal(summary.total, 0)
  assert.equal(summary.hasProblems, false)
})
test('同一法条重复引用只计一次（去重）', () => {
  const text = '《中华人民共和国劳动合同法》第三十九条……后文再次提到《中华人民共和国劳动合同法》第三十九条，以及《中华人民共和国劳动合同法》第三十九条。'
  const { citations, summary } = verifyOutput(text, { laws, today })
  assert.equal(summary.total, 1, '同一法规+条号应去重为 1 条')
  assert.equal(citations[0].articleNo, '三十九')
})
test('材料标题不计入问题数', () => {
  const text = '附件《派遣员工劳动合同书》第七条存在问题，依据《中华人民共和国劳动合同法》第三十八条处理。'
  const { summary } = verifyOutput(text, { laws, today })
  assert.equal(summary.total, 1)
  assert.equal(summary.hasProblems, false, '不应因材料标题产生告警')
  assert.equal(summary.ignoredNonLegal, 1)
})
test('校验说明渲染为 Markdown 且标注问题数', () => {
  const { citations } = verifyOutput('依据《中华人民共和国合同法》第一百零七条。', { laws, today })
  const notice = renderCitationNotice(citations)
  assert.ok(notice.includes('❌'), '应含失败标记')
  assert.ok(notice.includes('未能通过核实'), '应含汇总提示')
})

// ---------------------------------------------------------------------------
console.log('\n5. 案例库 2-gram 检索')
// ---------------------------------------------------------------------------
test('案例已导入', () => {
  const status = getLaborStatus()
  assert.ok(status.cases >= 5, `期望至少 5 条案例，实际 ${status.cases}`)
})
test('按关键词命中案例（竞业限制）', () => {
  const results = searchCases('员工离职后去了竞争对手公司，可以要求违约金吗')
  assert.ok(results.length > 0, '应命中案例')
  assert.ok(results.some((item) => item.disputeFocus.includes('竞业限制')), '应命中竞业限制案例')
})
test('按关键词命中案例（孕期降薪）', () => {
  const results = searchCases('公司能不能给怀孕的女员工调岗降薪')
  assert.ok(results.length > 0)
  assert.ok(results.some((item) => item.disputeFocus.includes('孕期') || item.title.includes('怀孕')))
})
test('按关键词命中案例（社保补缴/抚恤金）', () => {
  const results = searchCases('公司没给员工缴社保，员工自己交了，能要求公司赔吗')
  assert.ok(results.length > 0)
  assert.ok(results.some((item) => /社会保险费|抚恤金/.test(item.disputeFocus + item.title)))
})
test('典型案例优先排序', () => {
  const results = searchCases('停工留薪期 延长 工伤')
  assert.ok(results.length > 0)
  assert.equal(results[0].caseType, '典型案例', '典型案例应排在前面')
})
test('案例含来源标注（可追溯）', () => {
  const results = searchCases('竞业限制 适格主体')
  assert.ok(results.length > 0)
  assert.ok(results[0].source.includes('人力资源社会保障部'), '应标注权威来源')
  assert.ok(results[0].sourceUrl.startsWith('https://'), '应带来源链接')
})
test('无关查询不返回全部案例（排序有效）', () => {
  const results = searchCases('竞业限制 违约金 保安', { limit: 3 })
  assert.ok(results.length <= 3)
})

// ---------------------------------------------------------------------------
console.log('\n6. 提示词装配')
// ---------------------------------------------------------------------------
const { buildLaborConsultSystemPrompt, buildLaborConsultUserMessage, renderLawBaseline } = await import('../prompts/labor-consult.js')

test('法规时效基准渲染含施行日期与状态', () => {
  const text = renderLawBaseline(laws)
  assert.ok(text.includes('2013-07-01'), '应含劳动合同法施行日期')
  assert.ok(text.includes('2025-01-01'), '应含延迟退休决定施行日期')
})
test('系统提示词注入当前日期', () => {
  const prompt = buildLaborConsultSystemPrompt({ now: new Date('2026-09-18T10:00:00+08:00'), laws })
  assert.ok(prompt.includes('2026-09-18'), '应注入当前日期')
  assert.ok(prompt.includes('法规时效基准'), '应含时效基准区块')
  assert.ok(prompt.includes('不得凭记忆生成法规版本号'), '应含防幻觉约束')
  assert.ok(prompt.includes('不作胜诉承诺'), '应含绝对化表述边界')
})
test('用户消息注入证据与案例编号', () => {
  const message = buildLaborConsultUserMessage({
    message: '试用期最长多久？',
    evidence: [{ kind: 'clause', clauseNo: '第十九条', title: '试用期', text: '试用期不得超过六个月', sourceName: '劳动合同范本' }],
    cases: [{ title: '某案例', caseNo: '(2024)京01民终1号', court: '北京市第一中级人民法院', disputeFocus: '试用期', holding: '裁判要点' }]
  })
  assert.ok(message.includes('[K1]'), '应含知识库证据编号')
  assert.ok(message.includes('[C1]'), '应含案例编号')
  assert.ok(message.includes('(2024)京01民终1号'), '应含案号')
})

// ---------------------------------------------------------------------------
console.log('\n7. 实务资料解析器（用工风险五册）')
// ---------------------------------------------------------------------------
// 用合成文本测试，保证确定性且不依赖原始 .docx
const SAMPLE_BOOK = [
  '目录',
  '第一章 用工模式筹划	9',
  '一、基础问题与风险防范	10',
  '（一）劳务用工	10',
  '【问题1】什么是临时工？	10',
  '【问题2】灵活用工有哪些？	11',
  '第二章 招聘管理	15',
  '【问题3】招聘歧视的界限？	15',
  '',
  '第一章 用工模式筹划',
  '一、基础问题与风险防范',
  '（一）劳务用工',
  '【问题1】什么是临时工？',
  '临时工并非法律概念，',
  '实务中一般按劳务关系处理。',
  '参见北京市第三中级人民法院（2017）京03民终11769号。',
  '__RUNNING_HEADER__',
  '【问题2】灵活用工有哪些？',
  '包括非全日制、劳务派遣、',
  '业务外包等形式。',
  '__RUNNING_HEADER__',
  '__RUNNING_HEADER__',
  '__RUNNING_HEADER__',
  '__RUNNING_HEADER__',
  '第二章 招聘管理',
  '【问题3】招聘歧视的界限？',
  '《中华人民共和国劳动法》第十二条规定，',
  '劳动者就业不因民族、种族、性别、宗教信仰不同而受歧视。'
].join('\n')

test('识别重复页眉', () => {
  const lines = SAMPLE_BOOK.split('\n')
  const headers = detectRunningHeaders(lines, { minRepeat: 5 })
  assert.ok(headers.has('__RUNNING_HEADER__'), '重复 5 次的行应被识别为页眉')
  assert.ok(!headers.has('【问题1】什么是临时工？'), '只出现两次的行不应被当成页眉')
})
test('目录与正文正确切分，且不重复计数', () => {
  const { entries, stats } = parseLaborBook(SAMPLE_BOOK, { book: '测试册' })
  assert.equal(entries.length, 3, `期望 3 条正文条目，实际 ${entries.length}`)
  assert.equal(stats.tocRecords, 3, '目录应解析出 3 条记录')
})
test('层级取自目录而非答案正文', () => {
  const { entries } = parseLaborBook(SAMPLE_BOOK, { book: '测试册' })
  assert.equal(entries[0].chapter, '第一章 用工模式筹划')
  assert.equal(entries[0].section, '一、基础问题与防范'.replace('与防范', '与风险防范'))
  assert.equal(entries[1].chapter, '第一章 用工模式筹划', '问题2 应继承同一章')
  assert.equal(entries[2].chapter, '第二章 招聘管理', '问题3 应切换到新章')
})
test('页眉行不进入答案正文', () => {
  const { entries } = parseLaborBook(SAMPLE_BOOK, { book: '测试册' })
  assert.ok(!entries.some((e) => e.content.includes('__RUNNING_HEADER__')), '页眉不得残留于正文')
})
test('修复跨页断句（页眉打断的行被拼接）', () => {
  const { entries } = parseLaborBook(SAMPLE_BOOK, { book: '测试册' })
  assert.ok(entries[0].content.includes('临时工并非法律概念，实务中一般按劳务关系处理。'),
    `跨页断裂未修复：${entries[0].content.slice(0, 80)}`)
  assert.ok(entries[1].content.includes('包括非全日制、劳务派遣、业务外包等形式。'),
    `跨页断裂未修复：${entries[1].content.slice(0, 80)}`)
})
test('答案正文里引用的法条款号不会截断条目', () => {
  // 法条本身也用（一）（二）编号，若在正文里识别小节标题会截断答案
  const text = [
    '第一章 违纪解除',
    '【问题1】严重违纪解除的条件？',
    '《劳动合同法》第39条规定，劳动者有下列情形之一的，用人单位可以解除劳动合同：',
    '（一）在试用期间被证明不符合录用条件的；',
    '（二）严重违反用人单位的规章制度的；',
    '（三）严重失职，营私舞弊，给用人单位造成重大损害的。',
    '因此，公司需逐项核对是否符合上述情形。'
  ].join('\n')
  const { entries } = parseLaborBook(text, { book: '测试册' })
  assert.equal(entries.length, 1)
  assert.ok(entries[0].content.includes('因此，公司需逐项核对'), '答案被法条款号截断了')
  assert.ok(entries[0].content.includes('（三）严重失职'), '法条款号应保留在答案中')
})
test('提取答案中的裁判文书案号', () => {
  const refs = extractCaseNumbers('参见（2017）京03民终11769号与（2016）沪02民终8274号，另有（2019）最高法民申1234号。')
  assert.ok(refs.length >= 2, `应至少提取 2 个案号，实际 ${refs.length}`)
  assert.ok(refs.some((item) => item.includes('京03民终11769')), '应识别京03民终案号')
})
test('normalizeContent 压缩多余空行', () => {
  assert.equal(normalizeContent('  a\n\n\n\nb  '), 'a\n\nb')
})

// ---------------------------------------------------------------------------
console.log('\n8. 实务问答检索库')
// ---------------------------------------------------------------------------
test('问答库已导入', () => {
  initializeLaborKb()
  const status = getLaborKbStatus()
  assert.ok(status.entries >= 700, `期望至少 700 条，实际 ${status.entries}`)
  assert.ok(status.byBook.length >= 5, `期望覆盖 5 册，实际 ${status.byBook.length}`)
})
await atest('按主题检索命中相关问答（竞业限制）', async () => {
  const results = await searchLaborKb('竞业限制的违约金约定多少合适', { limit: 5 })
  assert.ok(results.length > 0, '应命中条目')
  assert.ok(results.some((item) => /竞业限制/.test(item.title)), '应命中竞业限制相关条目')
})
await atest('按主题检索命中相关问答（加班费基数）', async () => {
  const results = await searchLaborKb('加班费的计算基数怎么确定', { limit: 5 })
  assert.ok(results.length > 0)
  assert.ok(results.some((item) => /加班费/.test(item.title) && /基数/.test(item.title)),
    `应命中加班费基数条目，实际首位：${results[0]?.title}`)
})
await atest('按主题检索命中相关问答（工伤停工留薪期）', async () => {
  const results = await searchLaborKb('工伤停工留薪期有多久', { limit: 5 })
  assert.ok(results.length > 0)
  assert.ok(results.some((item) => /停工留薪期/.test(item.title)))
})
await atest('检索结果含章节路径与案号（可追溯）', async () => {
  const results = await searchLaborKb('严重违纪解除', { limit: 5 })
  const withMeta = results.find((item) => item.chapter && item.book)
  assert.ok(withMeta, '结果应含册名与章名')
  const withCases = (await searchLaborKb('竞业限制违约金', { limit: 5 })).find((item) => item.caseRefs.length)
  assert.ok(withCases, '部分条目应含裁判案号')
  assert.ok(/\(\d{4}\)|（\d{4}）/.test(withCases.caseRefs[0]), `案号格式异常：${withCases.caseRefs[0]}`)
})
await atest('2-gram 分词使中文可检索（对比：整词匹配会命中 0 条）', async () => {
  // 「付款」类两字词在 unicode61 下是整段中文 token 的一部分，精确匹配命中 0；
  // 这里验证索引态确实含有可独立匹配的 bigram。
  const results = await searchLaborKb('经济补偿金', { limit: 5 })
  assert.ok(results.length > 0, '两字以上中文术语应可检索')
})

// ---------------------------------------------------------------------------
// 9. 向量索引的可诊断性与缓存失效前提
//    背景：曾出现"语义召回（index_empty）已降级"长期无法自诊断——
//    改过 RAG_EMBEDDING_MODEL 却没重建索引时，状态里只表现为 embedded=0，
//    看不出真实原因；且空索引一旦被缓存，其它进程补建后本进程永远发现不了。
// ---------------------------------------------------------------------------
await atest('向量索引状态暴露库内实际模型名（诊断模型不匹配的唯一线索）', async () => {
  initializeLaborKb()
  initializeLaborVector()
  const status = getLaborVectorStatus()
  assert.ok(Array.isArray(status.storedModels), 'storedModels 必须是数组')
  assert.ok(status.storedModels.length > 0, '索引已建，storedModels 不应为空')
  assert.ok(status.storedModels.every((item) => typeof item.model === 'string' && item.count > 0),
    `storedModels 结构异常：${JSON.stringify(status.storedModels)}`)
  assert.equal(typeof status.modelMismatch, 'boolean', 'modelMismatch 必须是布尔值')
})

await atest('模型一致时 modelMismatch 为 false（避免误报）', async () => {
  const status = getLaborVectorStatus()
  const storedTotal = status.storedModels.reduce((sum, item) => sum + item.count, 0)
  if (status.embedded > 0) {
    assert.equal(status.modelMismatch, false, '库内存在当前模型的向量时不应报 modelMismatch')
    assert.equal(status.ready, true, '有向量时 ready 应为 true')
    assert.ok(status.coverage > 0 && status.coverage <= 1, `coverage 越界：${status.coverage}`)
  } else {
    // 未构建索引的环境：此时若有别的模型的向量，必须报 modelMismatch
    assert.equal(status.modelMismatch, storedTotal > 0, '库内有其它模型向量时应报 modelMismatch')
  }
})

await atest('dimension 取自当前模型的行（不得取到其它模型的维度）', async () => {
  const status = getLaborVectorStatus()
  const db = getDb()
  const expected = db.prepare('SELECT dim FROM labor_kb_embeddings WHERE model = ? LIMIT 1')
    .get(status.model)?.dim || 0
  assert.equal(status.dimension, expected, 'dimension 应按当前配置的模型过滤后再取')
})

await atest('resetIndexCache 后检索结果不变（缓存失效不得改变结果）', async () => {
  const query = new Float32Array(1024)
  for (let i = 0; i < query.length; i += 1) query[i] = Math.sin(i) * 0.03
  const before = searchVector(query, { limit: 20 }).map((hit) => `${hit.entryId}:${hit.similarity.toFixed(6)}`)
  resetIndexCache()
  const after = searchVector(query, { limit: 20 }).map((hit) => `${hit.entryId}:${hit.similarity.toFixed(6)}`)
  assert.deepEqual(after, before, '重建索引后的检索结果必须与缓存命中时完全一致')
})

await atest('PRAGMA data_version 语义符合缓存失效前提（同连接不触发）', async () => {
  // 跨连接失效依赖该语义：其它连接提交修改后 data_version 变化，同连接读写不变化。
  // 若 SQLite/better-sqlite3 升级改变此语义，缓存将永不失效（或每次都失效），这里提前发现。
  const db = getDb()
  const v1 = db.pragma('data_version', { simple: true })
  assert.equal(typeof v1, 'number', 'data_version 应返回数字')
  db.prepare('SELECT COUNT(*) AS c FROM labor_kb_embeddings').get()
  searchVector(new Float32Array(1024), { limit: 1 })
  assert.equal(db.pragma('data_version', { simple: true }), v1,
    '同连接内的读写不得改变 data_version（否则缓存会每次都失效）')
})

// ---------------------------------------------------------------------------
// 10. 追问检索词改写
//     背景：多轮追问常含指代而缺主题词（"那这种情况怎么办"），单独检索会抽出
//     「况怎么办」这类碎片词、召回与上文无关的条目。改写把追问补全为自足查询；
//     模型输出不可信，必须能识别并拒绝"写成答案/解释"的情况。
// ---------------------------------------------------------------------------
test('改写输出清洗：剥离前缀、引号、代码块', () => {
  assert.equal(validateRewrite('试用期六个月是否合法').query, '试用期六个月是否合法')
  assert.equal(validateRewrite('检索词：试用期六个月是否合法').query, '试用期六个月是否合法')
  assert.equal(validateRewrite('“试用期六个月是否合法”').query, '试用期六个月是否合法')
  assert.equal(validateRewrite('```\n试用期六个月是否合法\n```').query, '试用期六个月是否合法')
  assert.equal(validateRewrite('Query: 试用期合法性').query, '试用期合法性')
})

test('改写输出只取首个非空行（模型常附解释）', () => {
  const r = validateRewrite('试用期六个月是否合法\n\n说明：我已补全上文中的主题词')
  assert.equal(r.ok, true)
  assert.equal(r.query, '试用期六个月是否合法')
})

test('改写输出过长时判为失败（防止把答案当检索词）', () => {
  const long = '根据《劳动合同法》第十九条的规定，劳动合同期限三个月以上不满一年的，试用期不得超过一个月；'.repeat(3)
  const r = validateRewrite(long)
  assert.equal(r.ok, false, '超长输出必须被拒绝，否则垃圾会直接进入检索')
  assert.equal(r.reason, 'not_a_query')
})

test('改写输出写成多句解释时判为失败', () => {
  assert.equal(validateRewrite('首先，需要确认该条款是否有效。其次，要看主体资格。').ok, false)
  assert.equal(validateRewrite('根据《劳动合同法》，该约定无效。建议重新签订。').ok, false)
})

test('改写输出为空或过短时判为失败（调用方据此回退）', () => {
  assert.equal(validateRewrite('').ok, false)
  assert.equal(validateRewrite('   ').ok, false)
  assert.equal(validateRewrite('好').ok, false)
  assert.equal(validateRewrite('好').reason, 'empty')
})

test('改写复述提示词标记时判为失败', () => {
  assert.equal(validateRewrite('【对话上文】用户问的是试用期').ok, false)
  assert.equal(validateRewrite('**试用期合法性**').ok, false)
})

test('改写上文格式化：保留用户提问、助手回答只取摘要', () => {
  const longAnswer = '答'.repeat(2000)
  const ctx = formatRewriteContext([
    { role: 'user', content: '试用期和竞业限制条款合法吗？' },
    { role: 'assistant', content: longAnswer }
  ])
  assert.ok(ctx.includes('用户：试用期和竞业限制条款合法吗？'), '用户提问应保留')
  assert.ok(ctx.includes('助手（摘要）：'), '助手回答应标注为摘要')
  assert.ok(ctx.length < 900, `助手回答必须被截断，实际 ${ctx.length} 字`)
})

test('改写上文格式化：无有效历史时返回空（调用方据此跳过改写）', () => {
  assert.equal(formatRewriteContext([]), '')
  assert.equal(formatRewriteContext([{ role: 'user', content: '   ' }]), '')
  assert.equal(formatRewriteContext(null), '')
})

// ---------------------------------------------------------------------------
// 11. 输入框附件选择
//     背景：三个工作台都写成 setFiles(本次选择)，分几次选文件时上一次的会被整体丢掉，
//     表现出来就是"只能上传一份"。另外用字符串 includes 判断扩展名会把无扩展名文件误放行。
// ---------------------------------------------------------------------------
const mkFile = (name, size = 1000, lastModified = 111) => ({ name, size, lastModified })

test('附件选择：追加而不是替换（"只能上传一份"的根因）', () => {
  const first = mergeSelectedFiles([], [mkFile('合同.pdf')])
  assert.deepEqual(first.files.map((f) => f.name), ['合同.pdf'])
  const second = mergeSelectedFiles(first.files, [mkFile('员工手册.docx')])
  assert.deepEqual(second.files.map((f) => f.name), ['合同.pdf', '员工手册.docx'],
    '第二次选择必须保留第一次的文件')
})

test('附件选择：一次可选多份且支持多种格式', () => {
  const r = mergeSelectedFiles([], [mkFile('a.pdf'), mkFile('b.docx'), mkFile('c.xlsx'), mkFile('d.png')])
  assert.equal(r.files.length, 4)
  assert.equal(r.unsupported.length, 0)
})

test('附件选择：重复选择同一份不产生重复项', () => {
  const r = mergeSelectedFiles([mkFile('合同.pdf')], [mkFile('合同.pdf')])
  assert.equal(r.files.length, 1)
})

test('附件选择：同名但内容变化时替换，而不是新增', () => {
  const r = mergeSelectedFiles([mkFile('合同.pdf', 1000, 111)], [mkFile('合同.pdf', 2000, 222)])
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].size, 2000, '应替换为用户新选的那份')
})

test('附件选择：超出上限时拒绝并报告，不做静默截断', () => {
  const full = Array.from({ length: 6 }, (_, i) => mkFile(`${i + 1}.pdf`))
  const r = mergeSelectedFiles(full, [mkFile('7.pdf')])
  assert.equal(r.files.length, 6)
  assert.deepEqual(r.overflow, ['7.pdf'], '被丢弃的文件必须回报给用户')
})

test('附件选择：替换已有文件不占用新名额', () => {
  const full = Array.from({ length: 6 }, (_, i) => mkFile(`${i + 1}.pdf`))
  const r = mergeSelectedFiles(full, [mkFile('1.pdf', 9999, 999)])
  assert.equal(r.files.length, 6)
  assert.equal(r.overflow.length, 0, '替换不该被判为超限')
  assert.equal(r.files[0].size, 9999)
})

test('附件格式校验：无扩展名文件必须被拒绝（字符串 includes 会误放行）', () => {
  assert.equal(isSupportedFile(mkFile('README')), false, '空扩展名不得通过')
  assert.equal(isSupportedFile(mkFile('无扩展名')), false)
  assert.equal(isSupportedFile(mkFile('合同.pdf')), true)
  assert.equal(isSupportedFile(mkFile('员工手册.docx')), true)
  assert.equal(isSupportedFile(mkFile('恶意.exe')), false)
})

test('附件格式校验：超过单文件体积上限被拒绝', () => {
  assert.equal(isSupportedFile(mkFile('大文件.pdf', 81 * 1024 * 1024)), false)
  assert.equal(isSupportedFile(mkFile('正常.pdf', 79 * 1024 * 1024)), true)
})

test('附件拒绝文案：区分格式不支持与超出数量，并说明支持范围', () => {
  const message = describeRejection({ unsupported: ['a.exe'], overflow: ['b.pdf'] })
  assert.ok(message.includes('格式不支持'), '应指出格式问题')
  assert.ok(message.includes('超出上限'), '应指出数量问题')
  assert.ok(/PDF|Word/.test(message), '应说明支持哪些格式')
  assert.equal(describeRejection({ unsupported: [], overflow: [] }), '', '无拒绝时不应有提示')
})

// ---------------------------------------------------------------------------
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===\n`)
close()
process.exit(failed ? 1 : 0)
