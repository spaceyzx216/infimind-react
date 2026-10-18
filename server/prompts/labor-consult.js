/**
 * 用工咨询 Agent 的系统提示词与消息构造。
 *
 * 设计要点（与项目既有原则一致）：
 * 1. 法规的"存在性与时效性"由服务端提供的【法规时效基准】给定，不依赖模型记忆；
 * 2. 未收录进白名单的法规，模型必须声明"未能核实"，而不是凭记忆补条文；
 * 3. 输出后由 citation-verifier 做服务端引用校验，不信任模型自述的来源。
 *
 * 注意：本文件中的法规事实来自公开渠道核实（详见 docs/用工咨询功能方案.md）。
 * 若法规发生修订，应更新 law-whitelist 数据而非改写提示词。
 */

export const LABOR_CONSULT_AGENT_NAME = '法飞飞用工咨询助手'

export const LABOR_PROMPT_LIMITS = Object.freeze({
  kbEntryChars: 6500,
  evidenceChars: 1600,
  caseHoldingChars: 900
})

/**
 * 已知关键时点。这些是历史上最容易出错的时效事实，由服务端硬编码注入，
 * 避免模型自行推断版本与施行日期。
 */
export const LAW_TIME_ANCHORS = Object.freeze([
  {
    title: '中华人民共和国劳动合同法',
    version: '2012年修正',
    effectiveFrom: '2013-07-01',
    note: '现行有效；不存在“2025年修订版”'
  },
  {
    title: '中华人民共和国劳动合同法实施条例',
    version: '2008年公布',
    effectiveFrom: '2008-09-18',
    note: '现行有效'
  },
  {
    title: '中华人民共和国劳动法',
    version: '2018年修正',
    effectiveFrom: '1995-01-01',
    note: '现行有效'
  },
  {
    title: '中华人民共和国劳动争议调解仲裁法',
    version: '2007年公布',
    effectiveFrom: '2008-05-01',
    note: '现行有效'
  },
  {
    title: '中华人民共和国社会保险法',
    version: '2018年修正',
    effectiveFrom: '2011-07-01',
    note: '现行有效'
  },
  {
    title: '工伤保险条例',
    version: '2010年修订',
    effectiveFrom: '2011-01-01',
    note: '现行有效'
  },
  {
    title: '职工带薪年休假条例',
    version: '国务院令第514号',
    effectiveFrom: '2008-01-01',
    note: '现行有效；从未废止，不存在“2019年版”'
  },
  {
    title: '全国人民代表大会常务委员会关于实施渐进式延迟法定退休年龄的决定',
    version: '2024年9月13日通过',
    effectiveFrom: '2025-01-01',
    note: '现行有效；男职工与原55周岁女职工每4个月延迟1个月，原50周岁女职工每2个月延迟1个月；最低缴费年限自2030-01-01起由15年逐步提高至20年；弹性提前/延迟退休最长各3年'
  }
])

export const LABOR_CONSULT_SYSTEM_PROMPT = `# 角色
你是面向企业经营者、HR和法务的劳动法辅助AI，站在企业合法权益立场，帮助企业处理劳动用工与仲裁问题。说明适用条件、覆盖关键风险、提供可执行建议。

# 依据与引用
仅依据本次实际收到的用户陈述、上传材料、实务问答、知识库证据、案例和法规基准分析；区分已知事实、当事人主张与待核实事项。资料与判断冲突时，说明冲突及其影响。
1. 【法规时效基准】用于确定法规版本、施行日期和有效状态。引用法规时标明全称；条号和条文内容须有实际收到的资料支持。需要使用未收录法规时，注明“该法规未收录，需人工核实有效性”，不补全其条文。
2. 【检索到的实务问答】编号为[B#]，是本系统主要实务依据，优先结合适用条件采用其处理口径与操作步骤。条目中已记载的案号可以保留引用，注明来自对应[B#]；只能使用条目实际记载的案情、法院与裁判结论，不能由案号补出其余内容。
3. 【检索到的合同范本条款与风险点】编号为[K#]，用于说明条款写法与风险防范，不作为用户已经签署或实际履行的事实。
4. 【检索到的典型案例】编号为[C#]，用于说明相关裁判倾向与裁量区间。人社部与最高法联合发布的劳动人事争议典型案例通常按官方惯例不含案号和审理法院，不因此判定不可用或要求补查案号；引用其批次、案例编号及适用标准。普通裁判文书如已提供案号和法院，一并标注。
5. 上传材料先识别性质（劳动合同、员工手册、规章制度、仲裁裁决书、往来函件、考勤或工资记录等），按原文分析；引用材料须逐字摘录并注明材料名。材料可能来自本会话前几轮，应结合当前问题使用，不因本轮未重新上传而忽略。
6. 不得编造事实、法规、版本、条号、施行日期、案例案号、法院、裁判日期或裁判结果，也不得凭记忆补出资料未记载的内容；案例来源包括上述[B#]条目和[C#]案例。材料未写明的事实不推定为已经存在；依据不足时说明“证据不足，需人工核实”。

# 分析与跟进
梳理影响判断的事实、争议焦点和适用规则，结合相关实务与类案说明企业有利、不利因素及初步应对策略。对会改变结论的不同情形，分别说明条件和判断；有依据且需要计算时给出法条依据和测算方法。
解决建议覆盖与当前问题相关的员工沟通、赔偿方案和制度改进，逐项说明实施办法、理由和可行性。用户补充进展或材料后，重新评估受影响的判断并调整策略，持续支持案件处理。

# 输出结构
1. **结论**：先回答用户问题，给出核心依据、适用条件及必要的法条和测算方法。
2. **案件分析**：企业优势、劣势与关键风险，初步应对策略方向。
3. **解决建议**：具体行动，以及各项建议的合理性和可行性。
4. **风险提示与免责声明**。
各部分说明简洁、逻辑连贯，保留关键事实、依据、条件和行动信息。

# 业务边界
- 聚焦劳动法、劳动仲裁及对企业有实际价值的用工问题，拒绝无关话题。
- 不作胜诉承诺，不使用“一定胜诉”“法院必然支持”“该条款整体无效”“整个合同无效”等绝对表述。效力与结果判断应说明触发条件，并保留条款可分性、具体事实与裁审不确定性。
- 不设定无依据的违约金固定上限比例；结合实际损失、履行情况和公平原则评估调整风险。
- 不建议伪造、隐匿、毁灭证据或规避法定强制义务；可以指导合法举证与合规整改。
- 涉及签署、重大金额、群体性争议、工伤认定或行政处罚风险时，提示人工专业复核。
- 回答结尾固定标注：本回复为辅助分析，不构成正式法律意见。`

const formatDate = (date) => {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value)
  const pick = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

const formatWeekday = (date) => {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(value)
}

/**
 * 生成【法规时效基准】区块。
 * 优先使用白名单表（服务端维护、可审计）；白名单不可用时回退到硬编码锚点。
 * @param {Array<{title:string, versionLabel?:string, effectiveFrom:string, effectiveTo?:string|null, status?:string, note?:string}>} laws
 */
export function renderLawBaseline(laws = []) {
  const rows = Array.isArray(laws) && laws.length ? laws : LAW_TIME_ANCHORS.map((item) => ({
    title: item.title,
    versionLabel: item.version,
    effectiveFrom: item.effectiveFrom,
    effectiveTo: null,
    status: 'effective',
    note: item.note
  }))
  const statusLabel = { effective: '现行有效', superseded: '已被修改', repealed: '已废止', pending: '尚未生效' }
  return rows.map((law) => {
    const state = law.effectiveTo
      ? `已于 ${law.effectiveTo} 失效`
      : statusLabel[law.status] || '现行有效'
    const version = law.versionLabel ? `（${law.versionLabel}）` : ''
    const note = law.note ? `；${law.note}` : ''
    return `- 《${String(law.title).replace(/^《|》$/g, '')}》${version} 自 ${law.effectiveFrom} 起施行，${state}${note}`
  }).join('\n')
}

/**
 * 构造用工咨询的系统提示词。
 * @param {object} options
 * @param {Date}   options.now          当前时间（服务端时间，用于所有时效判定）
 * @param {Array}  options.laws         法规时效基准（来自白名单）
 * @param {string} options.kbStatus     知识库/案例库可用性说明，用于告知模型证据可能缺失
 */
export function buildLaborConsultSystemPrompt({ now = new Date(), laws = [], kbStatus = '' } = {}) {
  const today = formatDate(now)
  const weekday = formatWeekday(now)
  return `${LABOR_CONSULT_SYSTEM_PROMPT}

# 当前日期
${today}（${weekday}）
以此日期作为法规时效、条款生效与仲裁时效判断的基准；事件发生时间以用户陈述和材料为准。缺失年份或相对日期基准时注明待核实，不据当前日期补齐。

# 法规时效基准（服务端提供，以此为准）
${renderLawBaseline(laws)}
${kbStatus ? `\n# 证据可用性\n${kbStatus}` : ''}`
}

/**
 * 构造本次对话的用户消息，把用户上传的附件、检索到的实务问答、知识库证据与案例一并注入。
 * @param {object} options
 * @param {string} options.message     用户本轮提问
 * @param {Array}  options.attachments 用户在**本咨询会话内**提供的材料 [{ name, text }]。
 *                                     服务端会把历轮上传的材料一并带上，因此追问轮同样能看到
 *                                     第一轮上传的合同原文，而不是只有本轮新传的部分。
 * @param {Array}  options.kbEntries   实务问答条目（来自用工风险实务资料）
 * @param {Array}  options.evidence    合同范本条款 / 风险点
 * @param {Array}  options.cases       检索到的案例
 */
export function buildLaborConsultUserMessage({ message = '', attachments = [], kbEntries = [], evidence = [], cases = [] } = {}) {
  const attachmentSection = (attachments || []).length
    ? attachments.map((item, index) => `## 材料 ${index + 1}：${item.name}\n${String(item.text || '')}`).join('\n\n')
    : '（本次咨询尚未提供材料）'

  const kbSection = (kbEntries || []).length
    ? kbEntries.map((item, index) => {
      const path = [item.book, item.chapter, item.section].filter(Boolean).join(' > ')
      const cases = (item.caseRefs || []).length ? `\n【条目内引用案号】${item.caseRefs.join('、')}` : ''
      return `[B${index + 1}] ${item.questionNo || ''} ${item.title}\n出处：${path}${cases}\n实务要点：${String(item.content || '').slice(0, LABOR_PROMPT_LIMITS.kbEntryChars)}`
    }).join('\n\n')
    : '（本次未检索到实务问答条目）'

  const evidenceSection = (evidence || []).length
    ? evidence.map((item, index) => {
      const kindLabel = item.kind === 'risk_rule' ? '风险点' : item.referenceRole === 'excellent_template' ? '范本条款' : '参考条款'
      const heading = [item.clauseNo, item.title, item.category].filter(Boolean).join('｜')
      return `[K${index + 1}] ${kindLabel}｜来源：${item.sourceName || '知识库'}｜${heading || '未编号'}\n${String(item.text || '').slice(0, LABOR_PROMPT_LIMITS.evidenceChars)}`
    }).join('\n\n')
    : '（本次未检索到范本条款证据）'

  const caseSection = (cases || []).length
    ? cases.map((item, index) => {
      const meta = [item.caseNo, item.court, item.judgedAt].filter(Boolean).join('｜')
      const provenance = [item.batch, item.source].filter(Boolean).join('｜')
      return `[C${index + 1}] ${item.title || '劳动争议案例'}${meta ? `\n${meta}` : ''}${provenance ? `\n来源：${provenance}` : ''}\n争议焦点：${item.disputeFocus || '未标注'}\n裁判要点：${String(item.holding || '').slice(0, LABOR_PROMPT_LIMITS.caseHoldingChars)}`
    }).join('\n\n')
    : '（本次未检索到相关案例）'

  const question = message || '请分析以下附件材料涉及的劳动用工问题。'

  return `# 用户咨询
${question}

# 用户提供的材料（本咨询会话内累计，可能来自前几轮）
${attachmentSection}

# 检索到的实务问答（用工风险实务资料）
${kbSection}

# 检索到的合同范本条款与风险点
${evidenceSection}

# 检索到的典型案例
${caseSection}`
}
