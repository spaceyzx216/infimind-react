import { inferRiskCategory } from './knowledge-processor.js'
import { getSubTypeFeatures, listSubTypeLabels, getTypeAvailability } from './knowledge-base.js'

const UNIVERSAL_TOPICS = [
  ['合同效力与权利救济', ['法律适用', '合同效力', '永久有效', '口头约定', '单方解释', '起诉', '仲裁']],
  ['主体、授权与通知', ['主体', '授权', '统一社会信用代码', '通知', '送达', '账户变更']],
  ['标的、范围与附件', ['标的', '范围', '规格', '数量', '样品', '附件', '订单']],
  // 9-22 逐例归因：27 个"库有没捞到"的聚集——买卖合同该类别的规则通篇用「货款」，
  // 但查询词只有「价款」（2-gram 下是两个不同的词，不匹配）→ 补「货款」「账单」
  ['价税、付款与发票', ['价款', '货款', '付款', '税费', '发票', '收款账户', '结算', '账单']],
  // 主题名会作为一个「短语」进入 FTS 查询，因此必须与库内 risk_rules.category 逐字一致，
  // 否则该主题的类别名永远不会命中——只能靠下面的 terms 偶然覆盖。
  // 原「履行、交付与验收」与库内「交付、履行与验收」词序相反；原「质量、风险与权利」在库内不存在。
  ['交付、履行与验收', ['履行', '交付', '交货', '签收', '验收', '隐蔽瑕疵']],
  ['质量、质保与售后', ['质量', '质保', '售后', '风险转移', '所有权', '保险', '赔偿', '风险、所有权与保险']],
  ['变更、解除与违约', ['变更', '解除', '违约', '违约金', '不可抗力', '争议解决']]
]

const TYPE_TOPICS = {
  劳动合同: [['劳动用工专项', ['劳动合同期限', '试用期', '工作内容', '工作地点', '工时', '休息休假', '劳动报酬', '社会保险', '劳动保护', '解除终止']]],
  买卖合同: [['买卖专项', ['质量标准', '交货', '验收异议', '质保', '退换货', '所有权']]],
  租赁合同: [['租赁专项', ['权属', '交付', '起租', '维修', '押金', '返还']]],
  融资租赁合同: [['融资租赁专项', ['租赁物', '购买价款', '权属', '保险', '回收', '结算']]],
  借款合同: [['借款专项', ['实际到账', '利率', '费用', '提前还款', '逾期', '担保']]],
  保证合同: [['保证专项', ['主合同', '保证方式', '保证范围', '保证期间', '变更']]],
  // 9-22 逐例归因：承揽「工程履约」类别的规则全是施工过程管理（停工/返工/整改/工期/施工），
  // 原词表完全没有这组词 → 补齐
  承揽合同: [['承揽专项', ['图纸', '样品', '变更', '交付', '验收', '缺陷', '停工', '返工', '整改', '工期', '施工']]],
  委托合同: [['委托专项', ['需求', '成果', '阶段交付', '验收', '知识产权', '数据']]],
  建设工程合同: [['工程专项', ['资质', '图纸', '工程量清单', '签证', '工期', '结算', '竣工']]],
  运输合同: [['运输专项', ['货物清单', '包装', '提送货', '运单', '温控', '货损', '索赔']]],
  保管合同: [['保管专项', ['保管物', '价值', '场所', '查验', '损毁', '提取']]],
  仓储合同: [['仓储专项', ['仓单', '入库', '出库', '仓储条件', '货损', '费用']]],
  中介合同: [['中介专项', ['服务范围', '收费触发', '居间成果', '绕开交易', '保密']]],
  物业服务合同: [['物业专项', ['服务标准', '物业费', '公共收益', '维修', '交接']]],
  知识产权合同: [['知识产权专项', ['权属', '专利状态', '许可范围', '登记', '侵权', '保密']]],
  赠与合同: [['赠与专项', ['财产权属', '交付', '条件', '撤销', '税费']]]
}

const KNOWN_TYPES = Object.keys(TYPE_TOPICS).sort((a, b) => b.length - a.length)

/** Agent 1 报告里带固定前缀的三个字段；正则容忍列表符号、加粗与全角冒号 */
const DECLARED_TYPE_PATTERN = /^[-\s*`>]*合同类型[：:]\s*(.+)$/m
const DECLARED_SUB_TYPE_PATTERN = /^[-\s*`>]*合同子类型[：:]\s*(.+)$/m
const NO_TYPE_MARKER = /[（(]\s*库内无此类型\s*[）)]/g
const EMPTY_VALUE = /^(无|none|-|—|—|\/|待确认)$/i
/** `inferContractType` 的兜底值：它不是"判出来了"，而是"没判出来"（检索侧也把它当空串） */
const UNRESOLVED_CONTRACT_TYPE = '通用商业合同'

function readDeclaredLine(text, pattern) {
  const match = String(text || '').match(pattern)
  if (!match) return ''
  const value = match[1].replace(NO_TYPE_MARKER, '').replace(/[*`]/g, '').trim()
  return EMPTY_VALUE.test(value) ? '' : value
}

/**
 * 合同类型判定的三级降级（对齐「类型主轴」三个细节的约定）：
 * ① **Agent 1 为主**：结构化报告里给出的类型，且必须在已知清单内
 * ② **正则兜底**：Agent 1 没给、或给了一个库内没有的类型名时，退回原来的字符串匹配
 * ③ **都拿不到**：类型留空（检索退化为跨类型召回），并标 `needsUserConfirm` 交给上层询问用户
 *
 * 注意 ③ 绝不允许"静默不过滤"：`needsUserConfirm` 与 `declaredType` 都会向上传递用于留痕。
 * 子类型只随 ① 一起返回，并且**不在这一层校验** —— 校验统一放在检索侧
 * （`searchEvidence` 会检查开关、清单与素材），避免两处各写一套规则。
 */
export function resolveContractType({ analysisReport = '', source = '' } = {}) {
  const declaredType = readDeclaredLine(analysisReport, DECLARED_TYPE_PATTERN)
  const declaredSubType = readDeclaredLine(analysisReport, DECLARED_SUB_TYPE_PATTERN)

  if (declaredType && KNOWN_TYPES.includes(declaredType)) {
    return { contractType: declaredType, subType: declaredSubType, resolution: 'agent-1', declaredType, needsUserConfirm: false }
  }

  const byRegex = KNOWN_TYPES.find((type) => source.includes(type)) || inferContractType(source)
  if (byRegex && byRegex !== UNRESOLVED_CONTRACT_TYPE) {
    return {
      contractType: byRegex,
      subType: '',
      resolution: declaredType ? 'fallback-regex-after-unknown-declared' : 'fallback-regex',
      declaredType,
      needsUserConfirm: false
    }
  }

  // 正则只有兜底值「通用商业合同」时，说明其实没判出来 —— 这里必须显式区分，
  // 否则它会一路伪装成"识别成功"，而检索又拿它当空串处理 ⇒ 静默不过滤。
  return { contractType: '', subType: '', resolution: 'unresolved', declaredType, needsUserConfirm: true }
}

/**
 * 特征词复核：Agent 1 判出的子类型，必须在合同正文里有词面支持。
 *
 * 这是**唯一能挡住「子类型在清单内、但 Agent 1 判错了」**的防线 ——
 * 检索侧的三道校验只能挡住"清单外的名字"和"库内没素材"，挡不住判错。
 *
 * 占优度 = 该子类型的特征词命中数 ÷ 同主类型下命中数最高的那个子类型。
 * 阈值取 0.6 是**保守选择**：宁可退回主类型（＝现状、有串味但至少有证据），
 * 也不要用一个判错的子类型把候选池切光。实测依据见计划表 §7.1：
 * 委托 3/3 正确（占优度 92~100%）、中介 5/6 正确（唯一特征词判错的那份占优度 77%，
 * 但那是"特征词判错"而非"Agent 1 判错" ⇒ 此处会保守地退回主类型）。
 */
const SUB_TYPE_FEATURE_MIN_RATIO = 0.6

/**
 * 类型没判出来时给用户的一句提示。
 *
 * **由后端注入，不让 LLM 自己写** —— 模型看不到类型判定过程，让它自己说"我不确定合同类型"
 * 既不可靠也不可控。落点是审查结果的「完整性清单」（`completeness`），前端与 Markdown
 * 报告本来就会渲染这个字段 ⇒ **零 UI 改动**。
 *
 * 这与"内部诊断不外显"不冲突：不外显的是 `typeResolved:false` 这类**技术字段**，
 * 而这条是**给用户的可操作提示**。
 */
export const TYPE_UNCONFIRMED_NOTICE = '本次未能确定合同类型，参考证据可能不够对口；请确认合同类型后重新审查。'

/** 把「类型未确认」的提示追加进结构化审查结果的完整性清单（幂等） */
export function withTypeNoticeInResult(reviewResult, reviewPlan) {
  const notices = []
  if (reviewPlan?.typeResolution?.needsUserConfirm) notices.push(TYPE_UNCONFIRMED_NOTICE)
  // 材料不足的类型也要说清楚，否则用户不知道这份结果的可信度有限
  const availability = reviewPlan?.availability
  if (availability && availability.meetsLine === false && availability.contractType) {
    notices.push(`知识库里「${availability.contractType}」的材料不足（${availability.shortfalls.join('、')}），` +
      '本次可参考的同类证据有限，结论请结合专业判断复核。')
  }
  if (!notices.length) return reviewResult
  const list = Array.isArray(reviewResult?.completeness) ? reviewResult.completeness : []
  const missing = notices.filter((notice) => !list.includes(notice))
  if (!missing.length) return reviewResult
  return { ...reviewResult, completeness: [...list, ...missing] }
}

/**
 * 字符串版兜底：确保最终报告文本里一定带上这句提示（幂等）。
 * 需要它是因为 `reviewReport` 可能来自检查点恢复、不重新渲染 —— 那种路径下
 * 只注入结构化字段是看不见的。
 */
export function withTypeNoticeInReport(reportText, reviewPlan) {
  const text = String(reportText || '')
  const notices = []
  if (reviewPlan?.typeResolution?.needsUserConfirm) notices.push(TYPE_UNCONFIRMED_NOTICE)
  const availability = reviewPlan?.availability
  if (availability && availability.meetsLine === false && availability.contractType) {
    notices.push(`知识库里「${availability.contractType}」的材料不足（${availability.shortfalls.join('、')}），` +
      '本次可参考的同类证据有限，结论请结合专业判断复核。')
  }
  const missing = notices.filter((notice) => !text.includes(notice))
  if (!missing.length) return text
  return `${text}\n\n${missing.map((notice) => `> ${notice}`).join('\n\n')}`
}

export function checkSubTypeAgainstContract(contractType, subType, contractText) {
  if (!contractType || !subType) return { subType: '', reason: 'no-sub-type' }
  // 清单外的名字交给检索侧记 unknown-sub-type，这里不重复判
  if (!listSubTypeLabels(contractType).includes(subType)) return { subType, reason: 'not-declared' }
  const text = String(contractText || '')
  if (!text) return { subType, reason: 'no-contract-text' }

  const scores = listSubTypeLabels(contractType).map((label) => {
    const words = getSubTypeFeatures(contractType, label)
    const count = words.reduce((sum, word) => sum + (text.split(word).length - 1), 0)
    return { label, count }
  })
  const mine = scores.find((item) => item.label === subType)?.count || 0
  const best = Math.max(...scores.map((item) => item.count))
  // 正文一个特征词都没命中 ⇒ 是词表没覆盖这份合同的表达，不是判错 ⇒ 放行（信任 Agent 1）
  if (best === 0) return { subType, reason: 'no-feature-hit' }

  const ratio = mine / best
  return ratio >= SUB_TYPE_FEATURE_MIN_RATIO
    ? { subType, reason: 'ok', ratio: Number(ratio.toFixed(3)) }
    : { subType: '', reason: 'feature-mismatch', ratio: Number(ratio.toFixed(3)) }
}

export function buildReviewPlan({ analysisReport = '', contractText = '', userInstruction = '' } = {}) {
  const source = `${analysisReport}\n${contractText}\n${userInstruction}`
  // 类型判定：Agent 1 的结构分析结果为主，正则兜底，拿不到就标记待用户确认（见上方注释）
  const typeResolution = resolveContractType({ analysisReport, source })
  // 对外仍用「通用商业合同」表示未判定（UI 会显示它，且检索侧本来就把它当空串处理），
  // 真正的"未判定"信号放在 typeResolution 里，别让它伪装成识别成功。
  const contractType = typeResolution.contractType || UNRESOLVED_CONTRACT_TYPE
  // 子类型还要过一道「正文特征词」复核 —— 这一步需要正文，所以只能在计划层做；
  // 开关 / 清单 / 素材三道校验在检索侧（见 knowledge-base 的 resolveActiveSubType）
  const subTypeCheck = checkSubTypeAgainstContract(typeResolution.contractType, typeResolution.subType, contractText)
  const explicitFocus = hasSpecificFocus(userInstruction) ? userInstruction.trim() : ''
  const focusText = explicitFocus || contractText.slice(0, 6000)
  const contractSignals = contractText.slice(0, 12000)
  const focusedCategory = inferRiskCategory(focusText)
  const topicDefinitions = [...UNIVERSAL_TOPICS, ...(TYPE_TOPICS[contractType] || [])]
  const topics = topicDefinitions
    .filter(([label, terms]) => !explicitFocus || label.includes(focusedCategory.split('、')[0]) || terms.some((term) => focusText.includes(term)) || terms.some((term) => contractSignals.includes(term)) || label === '变更、解除与违约')
    .slice(0, 8)
    .map(([label, terms], index) => ({
      id: `topic-${index + 1}`,
      label,
      terms,
      query: [contractType, ...terms, ...extractUsefulTerms(explicitFocus)].filter(Boolean).join(' OR '),
      priority: explicitFocus && label.includes(focusedCategory.split('、')[0]) ? 'high' : 'normal'
    }))

  // 该类型的材料够不够（最低可用线）——不够就要在产品侧显式提示，而不是闷头给结果
  const availability = typeResolution.contractType ? getTypeAvailability(typeResolution.contractType) : null

  return {
    contractType,
    // 子类型（可选）：只作检索过滤键；为空时检索自动退化为按 contractType 过滤
    subType: subTypeCheck.subType,
    // 材料可用性：meetsLine=false 时调用方应给用户一句提示（见 withTypeNoticeInResult）
    availability,
    // 类型判定过程的可观测信息：来源、Agent 1 声明过但库内没有的类型名、是否需要问用户、
    // 以及子类型的正文复核结果（reason/ratio 用于排查"为什么这次没过子类型过滤"）
    typeResolution: {
      source: typeResolution.resolution,
      declaredType: typeResolution.declaredType,
      declaredSubType: typeResolution.subType,
      needsUserConfirm: typeResolution.needsUserConfirm,
      subTypeCheck: { reason: subTypeCheck.reason, ratio: subTypeCheck.ratio ?? null }
    },
    userFocus: userInstruction.trim(),
    topics: topics.length ? topics : [{
      id: 'topic-1', label: '通用合同审查', terms: ['合同主体', '付款', '交付', '验收', '违约'],
      query: [contractType, '合同主体', '付款', '交付', '验收', '违约'].filter(Boolean).join(' OR '), priority: 'normal'
    }]
  }
}

function hasSpecificFocus(instruction) {
  const text = String(instruction || '').trim()
  if (!text) return false
  return !/^(?:请|帮我)?(?:识别|审查|审核|检查)(?:合同|合同中|合同里的)?(?:需要)?(?:修改)?(?:的)?(?:风险|风险条款|条款)?[。！？!？]*$/u.test(text)
}

function inferContractType(text) {
  const entries = [
    ['劳动合同', /劳动合同|劳动关系|劳务派遣|派遣员工/],
    ['融资租赁合同', /融资租赁|售后回租/], ['建设工程合同', /建设工程|施工|工程承包/],
    ['知识产权合同', /专利|知识产权|许可使用|技术转让/], ['物业服务合同', /物业服务|物业管理/],
    ['仓储合同', /仓储/], ['保管合同', /保管/], ['运输合同', /运输|冷链|物流|货运/],
    ['承揽合同', /承揽|定作|加工/], ['保证合同', /保证|担保/], ['借款合同', /借款|贷款/],
    ['委托合同', /委托|软件开发/], ['中介合同', /中介|居间|推广服务/], ['赠与合同', /赠与/],
    ['租赁合同', /租赁|出租|承租/], ['买卖合同', /买卖|采购|销售|购销/]
  ]
  return entries.find(([, pattern]) => pattern.test(text))?.[0] || '通用商业合同'
}

function extractUsefulTerms(text) {
  return [...new Set(String(text || '').match(/[\u4e00-\u9fa5]{2,8}/g) || [])]
    .filter((term) => !/^(请|帮我|合同|审查|重点|风险|条款)$/.test(term))
    .slice(0, 6)
}
