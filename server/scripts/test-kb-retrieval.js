import assert from 'assert'
import { toIndexText, toQueryTerm } from '../services/chinese-tokenizer.js'
import { diversifyEvidence, resolveSubType, isSubTypeFilterEnabled } from '../services/knowledge-base.js'
import { resolveContractType } from '../services/review-plan.js'

// ---- Task 1：中文 2-gram ----
assert.equal(toIndexText('付款'), '付款', '两字词应产出单个 bigram')
assert.equal(toIndexText('违约金'), '违约 约金', '三字词应产出两个相邻 bigram')
assert.equal(toIndexText('甲方：付款'), '甲方 方付 付款', '标点被丢弃，连续汉字整体展开')
assert.equal(toIndexText('Party A pays'), 'Party A pays', '非中文原样保留')
assert.equal(toQueryTerm('违约金'), '违约 约金', '查询词同样展开为 bigram 序列')
assert.equal(toQueryTerm('人'), '人', '单字中文无法组 bigram，退化为单字本身')
console.log('tokenizer assertions passed')

// ---- Task 2：按审查主题分名额 ----
const pool = [
  { evidenceId: 'risk:1', kind: 'risk_rule', templateId: 1, referenceRole: 'annotated_case', category: 'A', topicLabels: ['主题甲'], text: 't1' },
  { evidenceId: 'risk:2', kind: 'risk_rule', templateId: 2, referenceRole: 'annotated_case', category: 'B', topicLabels: ['主题乙'], text: 't2' },
  { evidenceId: 'risk:3', kind: 'risk_rule', templateId: 3, referenceRole: 'annotated_case', category: 'C', topicLabels: ['主题丙'], text: 't3' },
  ...Array.from({ length: 5 }, (_, i) => ({ evidenceId: `risk:1${i}`, kind: 'risk_rule', templateId: 1, referenceRole: 'annotated_case', category: 'A', topicLabels: ['主题甲'], text: `same-${i}` })),
  { evidenceId: 'clause:9', kind: 'clause', templateId: 4, referenceRole: 'excellent_template', category: '', topicLabels: [], text: 'c9' }
]

const selected = diversifyEvidence(pool, { limit: 10, perDocumentCap: 3, topicLabels: ['主题甲', '主题乙', '主题丙'] })
const pickedTopics = new Set(selected.map((i) => i.topicLabels[0]))
assert.ok(pickedTopics.has('主题甲') && pickedTopics.has('主题乙') && pickedTopics.has('主题丙'), '每个计划主题至少 1 条')
const perDoc = selected.filter((i) => i.templateId === 1).length
assert.ok(perDoc <= 3, `同文档上限 3，实际 ${perDoc}`)
assert.ok(selected.some((i) => i.referenceRole === 'excellent_template'), '正向条款保底')

// 同一触发条款的重复规则只留一条
const dupPool = [
  { evidenceId: 'risk:a', kind: 'risk_rule', templateId: 1, referenceRole: 'annotated_case', category: 'A', topicLabels: ['主题甲'], text: '触发条款：同一段话\n风险说明：x' },
  { evidenceId: 'risk:b', kind: 'risk_rule', templateId: 2, referenceRole: 'annotated_case', category: 'B', topicLabels: ['主题甲'], text: '触发条款：同一段话\n风险说明：y' }
]
assert.equal(diversifyEvidence(dupPool, { limit: 10, perDocumentCap: 3, topicLabels: ['主题甲'] }).length, 1, '同触发条款只留一条')
console.log('selection assertions passed')

// ---- 子类型目录：只查表，不碰数据库 ----
assert.equal(resolveSubType('10、（法务审核）委托合同/10.1委托合同（坏1）.docx'), '一般委托', '按素材路径查到子类型')
assert.equal(resolveSubType('10、（法务审核）委托合同/10.2软件委托开发合同（坏）.docx'), '软件委托开发')
assert.equal(resolveSubType('不存在的路径.docx'), '', '查不到时返回空串（退化为按主类型过滤）')
assert.equal(isSubTypeFilterEnabled('委托合同'), true, 'A 级类型启用子类型过滤')
assert.equal(isSubTypeFilterEnabled('保管合同'), false, '未配置子类型的类型不启用过滤')
assert.equal(isSubTypeFilterEnabled('仓储合同'), false, 'C 级只打标签、不启用过滤')
console.log('sub-type catalog assertions passed')

// ---- 合同类型判定：Agent 1 为主 → 正则兜底 → 拿不到就标记待确认 ----
const agentReport = '# 合同基础识别\n- 合同类型：委托合同\n- 合同子类型：软件委托开发\n- 类型判定依据：正文出现「软件委托开发合同」'
const fromAgent = resolveContractType({ analysisReport: agentReport, source: agentReport })
assert.equal(fromAgent.contractType, '委托合同', 'Agent 1 给出的类型优先采用')
assert.equal(fromAgent.subType, '软件委托开发', '同一主类型下的子类型一并透传')
assert.equal(fromAgent.resolution, 'agent-1')

const unknownDeclared = '# 合同基础识别\n- 合同类型：加盟合同（库内无此类型）'
const unknownResolved = resolveContractType({ analysisReport: unknownDeclared, source: `${unknownDeclared}\n本合同为买卖合同` })
assert.equal(unknownResolved.resolution, 'fallback-regex-after-unknown-declared', '库外类型退回正则兜底')
assert.equal(unknownResolved.declaredType, '加盟合同', '保留 Agent 1 声明的类型名用于留痕')

const byRegex = resolveContractType({ analysisReport: '无类型字段', source: '本合同为运输合同' })
assert.equal(byRegex.contractType, '运输合同', 'Agent 1 没给类型时走正则')
assert.equal(byRegex.resolution, 'fallback-regex')

const unresolved = resolveContractType({ analysisReport: '本合同内容略', source: '本合同内容略' })
assert.equal(unresolved.contractType, '', '判不出类型时留空（正则的兜底值不算判定结果）')
assert.equal(unresolved.resolution, 'unresolved')
assert.equal(unresolved.needsUserConfirm, true, '判不出类型必须标记待用户确认，绝不静默不过滤')

const pending = resolveContractType({ analysisReport: '- 合同类型：待确认', source: '- 合同类型：待确认' })
assert.equal(pending.contractType, '', '「待确认」视为未给出，继续走兜底')
assert.equal(pending.needsUserConfirm, true)
console.log('contract type resolution assertions passed')
