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
import {
  buildConversationTitle,
  shouldAutoTitle,
  firstQuestionOf,
  isSyntheticFilePrompt,
  MAX_TITLE_CHARS,
  DEFAULT_TITLE
} from '../../src/utils/conversation-title.js'
import { formatRelativeTime } from '../../src/utils/relative-time.js'
import { sanitizeTitle, validateTitle, toClientResult } from '../services/title-refiner.js'
import { createStreamBuffer, throttleWithTrailing, MARKDOWN_THROTTLE_MS, STREAM_COMMIT_INTERVAL_MS } from '../../src/utils/stream-buffer.js'

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

// --- 公司法（2023修订）收录 + 版本判定加固 ---

test('公司法已收录且判为现行有效', () => {
  const law = findLaw('中华人民共和国公司法')
  assert.ok(law, '公司法必须已收录进白名单')
  assert.equal(law.effectiveFrom, '2024-07-01')
  assert.equal(law.versionLabel, '2023年修订')
  assert.equal(law.status, 'effective')
  assert.equal(resolveLawStatus(law, today), 'verified', '应判为已核实（不是待复核）')
  // 别名要能被识别，否则"《公司法》第X条"会落到未收录
  assert.ok(findLaw('公司法'), '简写「公司法」必须能匹配')
})

test('公司法常用引用放行（第16条 / 第236条 / 无版本标注）', () => {
  for (const text of [
    '根据《中华人民共和国公司法》第十六条，公司应当保护职工的合法权益。',
    '依据《公司法》第二百三十六条，清算财产应优先清偿职工工资、社会保险费用和法定补偿金。',
    '根据《中华人民共和国公司法》2023年修订第十六条。',
    '根据《公司法》2023修订第十六条。'
  ]) {
    const { citations } = verifyOutput(text, { laws, today })
    assert.equal(citations[0].status, 'verified', `应判为已核实：${text}`)
    assert.equal(citations[0].ok, true, `应放行：${text}`)
  }
})

test('⭐ 版本判定不得被"施行年份"放行（公司法 2023修订 / 2024施行 的错位）', () => {
  // 修复前：`effectiveFrom='2024-07-01'` 含 "2024"，于是**不存在的**
  // 「2024年修订版」被 contains 判断放行——恰是本功能最该拦住的一类幻觉。
  const cases = [
    ['根据《公司法》2024年修订版第七十六条，监事会职工代表不低于三分之一。', '2024年修订版'],
    ['根据《中华人民共和国公司法》2018年修订版第十六条。', '2018年修订版'],
    ['根据《公司法》2018年修订第十六条。', '2018年修订']   // 省略「年」也要能识别
  ]
  for (const [text, hint] of cases) {
    const { citations } = verifyOutput(text, { laws, today })
    assert.equal(citations[0].ok, false, `不存在的版本「${hint}」必须被拦截：${text}`)
    assert.ok(citations[0].note.includes(hint), `note 应点出异常版本，实际：${citations[0].note}`)
  }
})

test('版本判定加固后不得误报正确版本（既有法规回归）', () => {
  // 归一化是双向包含，正确标注必须继续放行，否则会把好引用一起拦掉
  const cases = [
    ['根据《劳动合同法》2012年修正第三十八条。', '劳动合同法'],
    ['根据《中华人民共和国劳动合同法》2012修正第三十八条。', '劳动合同法·省略年']
  ]
  for (const [text, label] of cases) {
    const { citations } = verifyOutput(text, { laws, today })
    assert.equal(citations[0].ok, true, `${label} 应放行，实际 note：${citations[0].note}`)
  }
  // 而真正不存在的版本仍要被拦
  const bad = verifyOutput('根据《劳动合同法》2025年修订版第三十八条。', { laws, today })
  assert.equal(bad.citations[0].ok, false)
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
console.log('\n14. 会话标题自动命名')

test('标题启发式：剥离开场白，保留主题词', () => {
  assert.equal(
    buildConversationTitle('请问员工入职三个月没签书面劳动合同，公司该怎么应对？'),
    '员工入职三个月没签书面劳动合同'
  )
  // 叠加前缀（「你好，请问」）要逐轮剥干净
  assert.equal(buildConversationTitle('你好，请问竞业限制协议对保安岗位有效吗？'), '竞业限制协议对保安岗位有效')
  assert.ok(!buildConversationTitle('请问试用期辞退需要赔偿吗').includes('请问'), '开场白不该进标题')
})

test('标题启发式：剥离结尾语气词与标点', () => {
  const title = buildConversationTitle('公司给员工调岗降薪，员工不同意申请仲裁，有哪些抗辩空间？')
  assert.ok(!/[？?，,。]$/.test(title), '标题不该以标点结尾')
  assert.ok(title.startsWith('公司给员工调岗降薪'), '主题词必须在最前面')
})

test('标题启发式：超长提问被截断并加省略号（侧边栏单行宽度约束）', () => {
  const title = buildConversationTitle('员工连续旷工三天'.repeat(6))
  assert.ok(title.length <= MAX_TITLE_CHARS + 1, `标题不得超过 ${MAX_TITLE_CHARS} 字，实际 ${title.length}`)
  assert.ok(title.endsWith('…'), '截断必须有省略号，否则看起来像话没说完')
})

test('标题启发式：空输入回退到占位标题，不产出空标题', () => {
  assert.equal(buildConversationTitle(''), DEFAULT_TITLE)
  assert.equal(buildConversationTitle('   \n  '), DEFAULT_TITLE)
  assert.equal(buildConversationTitle('？？？'), DEFAULT_TITLE, '只有标点时不该产出空标题')
})

test('标题覆盖判定：占位符可覆盖，用户自定义标题不可覆盖', () => {
  assert.equal(shouldAutoTitle(DEFAULT_TITLE, '竞业限制协议有效吗'), true)
  assert.equal(shouldAutoTitle('历史咨询', '竞业限制协议有效吗'), true)
  assert.equal(shouldAutoTitle('我的重要案子', '竞业限制协议有效吗'), false, '不得抢用户设过的标题')
  // LLM 提炼版落地后，第二次提炼不得把它打回启发式版本
  assert.equal(shouldAutoTitle('竞业限制违约金', '竞业限制协议有效吗'), false)
})

test('首轮提问提取：只有附件时用文件名（否则所有附件会话同名）', () => {
  const withQuestion = { messages: [{ type: 'user', content: '请分析这份合同', files: [{ name: '劳动合同.pdf' }] }] }
  assert.equal(firstQuestionOf(withQuestion), '请分析这份合同', '用户写了提问就用提问，它比文件名更能说明主题')
  const fileOnly = { messages: [{ type: 'user', content: '', files: [{ name: '员工手册.docx' }] }] }
  assert.equal(firstQuestionOf(fileOnly), '员工手册.docx')
  assert.equal(firstQuestionOf({ messages: [] }), '')
  // 追问轮不得改变首轮判定
  const multiple = {
    messages: [
      { type: 'user', content: '竞业限制有效吗' },
      { type: 'assistant', content: '……' },
      { type: 'user', content: '那这种情况怎么办' }
    ]
  }
  assert.equal(firstQuestionOf(multiple), '竞业限制有效吗')
})

test('首轮提问提取：识别并跳过"仅附件"的合成文案（实测会让标题退化成通用名）', () => {
  // ask() 在"只传附件不写提问"时会把下面这句**合成文案**写进 message.content，
  // 因此无法靠"content 是否为空"判断用户到底写没写。
  // 不识别它 → 所有附件轮会话都叫「劳动用工问题分析」，正是本次要修的问题。
  const synthetic = '请分析我上传的 1 份材料涉及的劳动用工问题。'
  assert.equal(isSyntheticFilePrompt(synthetic), true)
  assert.equal(isSyntheticFilePrompt('请分析我上传的 12 份材料涉及的劳动用工问题。'), true)
  assert.equal(isSyntheticFilePrompt('请分析这份劳动合同'), false, '用户真实表述不得被误判')

  const fileOnly = { messages: [{ type: 'user', content: synthetic, files: [{ name: '员工手册.docx' }] }] }
  assert.equal(firstQuestionOf(fileOnly), '员工手册.docx', '附件轮必须用文件名，不能用合成文案')
  assert.notEqual(buildConversationTitle(firstQuestionOf(fileOnly)), '请分析我上传的 1 份材料涉及的劳动用工问题')
})

test('标题提炼输出清洗：剥离代码块、前缀、引号与结尾标点', () => {
  assert.equal(sanitizeTitle('```\n未签合同二倍工资\n```'), '未签合同二倍工资')
  assert.equal(sanitizeTitle('标题：未签合同二倍工资'), '未签合同二倍工资')
  assert.equal(sanitizeTitle('“未签合同二倍工资”'), '未签合同二倍工资')
  assert.equal(sanitizeTitle('未签合同二倍工资。'), '未签合同二倍工资')
  // 只取首个非空行：模型常在标题后附一行解释
  assert.equal(sanitizeTitle('未签合同二倍工资\n这个标题概括了用户的问题'), '未签合同二倍工资')
})

test('标题提炼输出校验：拒绝结论性/解释性输出（标题会被当成案件定性）', () => {
  assert.equal(validateTitle('未签合同二倍工资抗辩').ok, true)
  // 结论性措辞——标题绝不能替用户定性
  assert.equal(validateTitle('公司应当支付二倍工资').ok, false, '结论性标题必须拒绝')
  // 元词汇：说明它在描述任务而不是起标题
  assert.equal(validateTitle('用户咨询竞业限制').ok, false, '元词汇必须拒绝')
  // 过长 / 多句成段 = 写了答案而不是标题
  assert.equal(validateTitle('员工入职三个月没有签订书面劳动合同现在离职要求二倍工资公司该怎么应对').ok, false)
  assert.equal(validateTitle('第一，未签合同；第二，可以主张二倍工资').ok, false)
  assert.equal(validateTitle('回答：未签合同二倍工资').ok, false)
  assert.equal(validateTitle('').ok, false)
  assert.equal(validateTitle('无').ok, false, '单字标题没有区分度')
})

test('相对时间：分钟 / 小时 / 天 / 月 / 年 逐级切换', () => {
  const now = new Date('2026-09-21T12:00:00+08:00').getTime()
  const ago = (ms) => formatRelativeTime(now - ms, now)
  const MIN = 60 * 1000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  assert.equal(ago(0), '刚刚')
  assert.equal(ago(59 * 1000), '刚刚', '不足 1 分钟显示刚刚')
  assert.equal(ago(MIN), '1分钟前')
  assert.equal(ago(30 * MIN), '30分钟前')
  assert.equal(ago(HOUR), '1小时前')
  assert.equal(ago(23 * HOUR), '23小时前')
  assert.equal(ago(DAY), '1天前')
  assert.equal(ago(2 * DAY), '2天前')
  assert.equal(ago(29 * DAY), '29天前')
  assert.equal(ago(30 * DAY), '1个月前')
  assert.equal(ago(100 * DAY), '3个月前')
  assert.equal(ago(365 * DAY), '1年前')
  assert.equal(ago(800 * DAY), '2年前')
})

test('相对时间：边界向下取整，不出现"60分钟前"这类越界单位', () => {
  const now = Date.now()
  // 60 分钟那一刻必须是"1小时前"。用 Math.round 会让 45 分钟显示成"1小时前"，时间看起来会跳。
  assert.equal(formatRelativeTime(now - 60 * 60 * 1000, now), '1小时前')
  assert.equal(formatRelativeTime(now - 59 * 60 * 1000 - 59 * 1000, now), '59分钟前')
  assert.ok(!/^60分钟前$/.test(formatRelativeTime(now - 60 * 60 * 1000, now)))
})

test('相对时间：未来时间与非法输入不产出负数或 NaN', () => {
  const now = Date.now()
  // 时钟偏差 / 服务端与浏览器不同步时会给到"未来"的时间戳
  assert.equal(formatRelativeTime(now + 5 * 60 * 1000, now), '刚刚')
  assert.equal(formatRelativeTime(NaN, now), '')
  assert.equal(formatRelativeTime(0, now), '')
  assert.equal(formatRelativeTime(undefined, now), '')
  assert.equal(formatRelativeTime(null, now), '')
})

test('标题提炼结果下发前必须剥掉 error 与 raw（密钥片段不得进浏览器）', () => {
  // 实测 DeepSeek 401 回包形如 `Authentication Fails, Your api key: ****test is invalid`。
  // 被掩码纯属侥幸——上游换个格式就会把真实密钥片段下发到浏览器并可能被前端持久化。
  const leaked = toClientResult({
    ok: false,
    reason: 'auth_failed',
    error: 'API error 401: {"error":{"message":"Authentication Fails, Your api key: sk-real-key-fragment is invalid"}}',
    raw: '模型原始输出',
    elapsedMs: 3948
  })
  assert.equal(leaked.ok, false)
  assert.equal(leaked.reason, 'auth_failed')
  assert.equal(leaked.elapsedMs, 3948)
  assert.equal('error' in leaked, false, 'error 字段必须被剥离')
  assert.equal('raw' in leaked, false, 'raw 字段必须被剥离')
  assert.ok(!JSON.stringify(leaked).includes('sk-real-key-fragment'), '序列化结果不得含密钥片段')

  // 成功路径同样只下发安全字段
  const ok = toClientResult({ ok: true, title: '未签合同二倍工资应对', raw: '未签合同二倍工资应对', elapsedMs: 1003 })
  assert.deepEqual(ok, { ok: true, title: '未签合同二倍工资应对', elapsedMs: 1003 })
})

// ---------------------------------------------------------------------------
console.log('\n15. 流式渲染节流（老浏览器崩溃修复）')

/** 注入式假 rAF：手动触发帧，让"每帧至多一次提交"可被确定性地断言 */
const fakeRaf = () => {
  const queue = new Map()
  let id = 0
  // 受控时钟：createStreamBuffer 会用 now() 判断"距上次提交是否已满最小间隔"
  let clock = 0
  return {
    requestFrame: (callback) => { id += 1; queue.set(id, callback); return id },
    cancelFrame: (handle) => { queue.delete(handle) },
    now: () => clock,
    /** 时间前进；配合 frame() 模拟"每帧检查最小间隔" */
    advance(ms) { clock += ms },
    get pending() { return queue.size },
    /** 触发一帧：执行并清空当前排队的回调 */
    frame() {
      const callbacks = [...queue.values()]
      queue.clear()
      callbacks.forEach((callback) => callback())
    }
  }
}

const fakeClock = () => {
  let now = 0
  const timers = new Map()
  let id = 0
  return {
    schedule: (callback, delay) => { id += 1; timers.set(id, { callback, at: now + delay }); return id },
    cancel: (handle) => { timers.delete(handle) },
    now: () => now,
    get pending() { return timers.size },
    advance(ms) {
      now += ms
      // 只触发到期者；同一批里后调的覆盖先调的（真实 setTimeout 也不保证顺序）
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(handle)
          timer.callback()
        }
      }
    }
  }
}

test('流式缓冲：2713 个增量只产生 1 次提交（每帧至多一次）', () => {
  const raf = fakeRaf()
  const commits = []
  const buffer = createStreamBuffer((patch) => commits.push(patch), { ...raf, minIntervalMs: 0 })
  // 模拟实测的事件量：正文 2713 块 + 思考 2762 块
  for (let i = 0; i < 2713; i += 1) buffer.addContent('字')
  for (let i = 0; i < 2762; i += 1) buffer.addReasoning('思')
  assert.equal(commits.length, 0, '未到帧边界前不得提交')
  raf.frame()
  assert.equal(commits.length, 1, `5475 个增量必须合并成 1 次提交，实际 ${commits.length}`)
  assert.equal(commits[0].content.length, 2713, '正文一块都不能丢')
  assert.equal(commits[0].reasoning.length, 2762, '思考一块都不能丢')
})

test('流式缓冲：跨帧提交时内容完整且顺序不变', () => {
  const raf = fakeRaf()
  const patches = []
  const buffer = createStreamBuffer((patch) => patches.push(patch), { ...raf, minIntervalMs: 0 })
  buffer.addContent('第一段')
  raf.frame()
  buffer.addContent('第二段')
  buffer.addReasoning('思考')
  raf.frame()
  buffer.addContent('第三段')
  raf.frame()
  assert.deepEqual(patches.map((p) => p.content).filter(Boolean), ['第一段', '第二段', '第三段'])
  // 拼接后必须与原始顺序完全一致
  assert.equal(patches.map((p) => p.content || '').join(''), '第一段第二段第三段')
})

test('流式缓冲：flush 取走尾部增量（否则回答会少一截）', () => {
  const raf = fakeRaf()
  const commits = []
  const buffer = createStreamBuffer((patch) => commits.push(patch), { ...raf, minIntervalMs: 0 })
  buffer.addContent('已提交')
  raf.frame()
  buffer.addContent('尾部')      // 流恰好在此结束，帧永远不会来
  buffer.addReasoning('尾思')
  assert.equal(commits.length, 1)
  const flushed = buffer.flush()
  assert.equal(flushed.content, '尾部', 'flush 必须取出未提交的正文')
  assert.equal(flushed.reasoning, '尾思')
  assert.equal(commits.length, 2, 'flush 必须立即提交，不能等下一帧')
  assert.equal(buffer.pending, false)
  assert.equal(buffer.flush(), null, '无增量时 flush 返回 null，调用方据此跳过渲染')
})

test('流式缓冲：flush 不得重复提交同一批增量', () => {
  const raf = fakeRaf()
  const commits = []
  const buffer = createStreamBuffer((patch) => commits.push(patch), { ...raf, minIntervalMs: 0 })
  buffer.addContent('内容')
  buffer.flush()
  raf.frame()   // 排程应已被 flush 撤销
  assert.equal(commits.length, 1, `flush 后帧回调不得再提交一次，实际提交 ${commits.length} 次`)
  assert.equal(commits.map((p) => p.content).join(''), '内容', '内容不得被写两次')
})

test('流式缓冲：空增量不触发提交（空转必须可跳过）', () => {
  const raf = fakeRaf()
  const commits = []
  const buffer = createStreamBuffer((patch) => commits.push(patch), { ...raf, minIntervalMs: 0 })
  buffer.addContent('')
  buffer.addReasoning(undefined)
  assert.equal(buffer.pending, false)
  assert.equal(raf.pending, 0, '空增量不得安排帧')
  buffer.flush()
  assert.equal(commits.length, 0, '空增量不得产生提交')
})

test('流式缓冲：contentText 可在 flush 前取到完整正文（避免异步回读丢尾部）', () => {
  const raf = fakeRaf()
  const buffer = createStreamBuffer(() => {}, { ...raf, minIntervalMs: 0 })
  buffer.addContent('已提交')
  raf.frame()
  buffer.addContent('尾部')
  // finally 里必须能拿到**完整**正文，用于同步写 Markdown 快照
  assert.equal(buffer.contentText, '尾部', '未提交部分的读取')
  buffer.flush()
  assert.equal(buffer.contentText, '', 'flush 后缓冲清空')
})

test('节流器：首次立即执行，间隔内合并为一次尾调用', () => {
  const clock = fakeClock()
  const calls = []
  const throttled = throttleWithTrailing((value) => calls.push(value), 200, clock)
  throttled('a')
  assert.deepEqual(calls, ['a'], '首次调用应立即执行，保证首屏不被推迟')
  throttled('b')
  throttled('c')
  assert.deepEqual(calls, ['a'], '间隔内的调用必须合并')
  clock.advance(200)
  assert.deepEqual(calls, ['a', 'c'], '尾调用只执行最后一次（合并掉的中间值无意义）')
})

test('节流器：flush 强制执行尾部（末段内容不得丢）', () => {
  const clock = fakeClock()
  const calls = []
  const throttled = throttleWithTrailing((value) => calls.push(value), 200, clock)
  throttled('a')
  throttled('b')          // 被节流，等 200ms
  throttled.flush()       // 流在这里结束
  assert.deepEqual(calls, ['a', 'b'], 'flush 必须补上尾部，否则正文停在倒数第二段')
  clock.advance(1000)
  assert.deepEqual(calls, ['a', 'b'], 'flush 之后不得再重复执行')
})

test('节流器：cancel 丢弃挂起调用（组件卸载后不得 setState）', () => {
  const clock = fakeClock()
  const calls = []
  const throttled = throttleWithTrailing((value) => calls.push(value), 200, clock)
  throttled('a')
  throttled('b')
  throttled.cancel()
  clock.advance(1000)
  assert.deepEqual(calls, ['a'], 'cancel 后尾调用不得执行')
})

test('节流器：Markdown 解析次数与事件量解耦（O(n²) → O(n)）', () => {
  // 实测一轮问答 2713 个正文增量。旧实现每个都解析一次整篇 Markdown。
  const clock = fakeClock()
  let parses = 0
  const throttled = throttleWithTrailing(() => { parses += 1 }, MARKDOWN_THROTTLE_MS, clock)
  for (let i = 0; i < 2713; i += 1) {
    throttled()
    clock.advance(5)   // 增量约每 5ms 到达一块
  }
  throttled.flush()
  // 总时长约 13.5s ÷ 200ms ≈ 68 次上限
  assert.ok(parses <= 80, `解析次数应降到 80 次以内，实际 ${parses}（旧实现为 2713 次）`)
  assert.ok(parses >= 2, '解析必须真的发生，否则正文不更新')
})

test('流式缓冲：最小提交间隔把渲染次数钉死（上游事件再密也不劣化）', () => {
  const raf = fakeRaf()
  const commits = []
  // 模拟深度思考档实测节奏：约 66 个事件/秒（11100 块 / 168 秒），整轮 168 秒
  const buffer = createStreamBuffer((patch) => commits.push(patch), {
    ...raf,
    minIntervalMs: STREAM_COMMIT_INTERVAL_MS
  })
  let delivered = 0
  const FRAME_MS = 1000 / 60
  const TOTAL_MS = 168000
  const EVENT_EVERY = 15   // ≈66 事件/秒
  let nextEventAt = 0
  for (let t = 0; t < TOTAL_MS; t += FRAME_MS) {
    raf.advance(FRAME_MS)
    while (nextEventAt <= t) { buffer.addReasoning('思'); delivered += 1; nextEventAt += EVENT_EVERY }
    raf.frame()
  }
  buffer.flush()

  // 168 秒 ÷ 100ms ≈ 1680 次；给一点余量
  assert.ok(commits.length <= 1800, `渲染次数应被钉在约 1680 次，实际 ${commits.length}`)
  assert.ok(commits.length >= 1500, '不能节流过度导致长时间不更新')
  assert.ok(delivered > 10000, `本用例应模拟出上万个事件，实际 ${delivered}`)
  assert.ok(commits.length < delivered / 5, '渲染次数必须远低于事件数')
  // 一次都不能丢
  assert.equal(commits.reduce((n, p) => n + (p.reasoning || '').length, 0), delivered)
})

test('流式缓冲：最小间隔内的增量继续累积，不丢内容只延后显示', () => {
  const raf = fakeRaf()
  const commits = []
  const buffer = createStreamBuffer((patch) => commits.push(patch), {
    ...raf,
    minIntervalMs: STREAM_COMMIT_INTERVAL_MS
  })
  buffer.addContent('A')
  raf.frame()                                  // 首次立即提交
  assert.deepEqual(commits.map((p) => p.content), ['A'])
  raf.advance(10)                              // 远小于最小间隔
  buffer.addContent('B')
  raf.frame()
  assert.equal(commits.length, 1, '未满最小间隔不得提交')
  raf.advance(STREAM_COMMIT_INTERVAL_MS)
  raf.frame()
  assert.deepEqual(commits.map((p) => p.content), ['A', 'B'], '间隔满足后必须补交，内容不得丢')
})

// ---------------------------------------------------------------------------
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===\n`)
close()
process.exit(failed ? 1 : 0)
