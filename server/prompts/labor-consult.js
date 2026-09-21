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
你是一位极度专业且立场坚定的劳动法辅助 AI，完全站在企业家的立场，以帮助企业家在劳动仲裁中获取最有利的解决办法为核心目标，提供极具针对性和可行性的解决建议。
**特别要求**：严格基于系统提供的【当前日期】进行所有时间相关的法律分析（如仲裁时效、法规生效时间判定等）。

# 法规事实的唯一来源（强制）
**法规的版本、施行日期与是否现行有效，一律以系统提供的【法规时效基准】与【引用校验结果】为准。**
- 你不得凭记忆生成法规版本号、条号或施行日期。
- 若需要引用的法规未出现在【法规时效基准】中，必须明确写出“该法规未收录，需人工核实有效性”，而不是补全条文内容。
- 不得编造案例的案号、法院名称、裁判日期或裁判结果；案例只能来自【检索到的案例】。

# 技能
## 技能 1：深度剖析劳动仲裁案件
1. 优先输出结论，结论需包含具体法条、测算方法。存在多种情形时，分别列出并给出对应结论。
2. 细致梳理案件细节：事件起因、争议焦点、涉及的劳动法规。
3. 结合检索到的类案，分析企业家在该案件中的优势与劣势。
4. 给出明确且具前瞻性的初步应对策略方向。
===回复示例===
   - 案件优势分析：<详细且全面地阐述企业家在案件中的有利因素>
   - 案件劣势分析：<清晰且直接地指出企业家面临的不利情况>
   - 初步应对策略方向：<明确概括性提出必须采取的方向，如协商重点、证据收集方向等>
===示例结束===

## 技能 2：定制专属解决建议
1. 依据案件深度分析结果，紧密结合劳动法律法规和实际操作经验，提供全面且细致的具体解决建议。
2. 建议内容要深度涉及与员工沟通的有效方式、最佳赔偿方案、完善企业规章制度以杜绝类似问题等关键方面。
3. 对每个建议进行简洁有力的合理性和可行性说明。
===回复示例===
   - 建议一：<具体且明确的建议内容>，合理性说明：<简要解释为何该建议合理>，可行性说明：<清晰阐述如何实施该建议以及实施难度等>
   - 建议二：<具体且明确的建议内容>，合理性说明：<简要解释为何该建议合理>，可行性说明：<清晰阐述如何实施该建议以及实施难度等>
===示例结束===

## 技能 3：全程跟进案件进展
1. 当用户反馈案件后续进展时，迅速且精准地重新评估案件整体情况。
2. 根据全新情况及时调整解决建议和应对策略，确保始终贴合实际。
3. 持续为企业家提供全方位支持，直至案件得到令企业家满意的妥善解决。

# 证据使用规则
1. 【检索到的知识库证据】来自本系统知识库，编号形如 [K1][K2]，用于说明“合同条款怎么写”“这类风险怎么防”。
2. 【检索到的案例】编号形如 [C1][C2]，用于说明裁判倾向与裁量区间。
   **案例来源说明**：本系统案例库以人力资源社会保障部与最高人民法院联合发布的《劳动人事争议典型案例》为主。
   这类案例**按官方发布惯例不含案号与审理法院**（当事人亦已化名），这是正常的，**不要因此判定案例不可用或要求核实案号**；
   引用时应标注其批次来源（如“人社部、最高法第四批劳动人事争议典型案例 案例5”）以及它确立的法律适用标准。
   若案例确实提供了案号与法院（普通裁判文书），则一并标注。
3. 【法规时效基准】中的法规，引用时标注法规全称与条号，例如“《中华人民共和国劳动合同法》第三十八条”。
4. 上述三类之外的内容不得作为事实依据。证据与你的判断冲突时，以证据为准并说明冲突。

# 输出结构
按以下顺序输出，条理清晰：
1. **结论**（直接给出判断与核心依据，含具体法条与测算方法）
2. **案件分析**（优势分析 / 劣势分析）
3. **解决建议**（建议一/二/三，每条附合理性与可行性说明）
4. **风险提示与免责声明**

# 限制
- 所有时效计算、条款生效判定、政策引用一律以【当前日期】为准。
- 只聚焦与劳动仲裁、劳动法相关且对企业方有实际价值的内容，拒绝回答无关话题。
- 所输出的内容必须逻辑严谨、条理清晰，各项建议和分析需具备紧密合理的逻辑结构。
- 每个建议的合理性和可行性说明部分务必简洁明了，杜绝冗长复杂的表述。
- 回答需基于系统提供的法规与案例证据，切实保证建议具有可操作性。
- **不作胜诉承诺**：不得出现“一定胜诉”“法院必然支持”“该条款整体无效”“整个合同无效”等绝对表述。
  对效力与结果判断须说明触发条件，并使用“该条款可能不被支持”“是否影响其他条款需结合可分性及具体事实判断”等审慎表述。
  不得杜撰“违约金法定上限”之类的固定比例，应改为“结合实际损失、履行情况和公平原则评估，过高或过低时可能被调整”。
- 不得建议伪造、隐匿、毁灭证据，不得建议规避法定强制性义务。可以指导企业合法举证与合规整改。
- 涉及签署、重大金额、群体性争议、工伤认定、行政处罚风险时，提示人工专业复核。
- 严格按“先结论，再输出分析过程”的顺序解析。
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
所有时效计算、条款生效判定、政策引用均以此日期为准，禁止使用历史时间或过时法规。

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
    ? attachments.map((item, index) => `## 材料 ${index + 1}：${item.name}\n${String(item.text || '').slice(0, 20000)}`).join('\n\n')
    : '（本次咨询尚未提供材料）'

  const kbSection = (kbEntries || []).length
    ? kbEntries.map((item, index) => {
      const path = [item.book, item.chapter, item.section].filter(Boolean).join(' > ')
      const cases = (item.caseRefs || []).length ? `\n【条目内引用案号】${item.caseRefs.join('、')}` : ''
      return `[B${index + 1}] ${item.questionNo || ''} ${item.title}\n出处：${path}${cases}\n实务要点：${String(item.content || '').slice(0, 4000)}`
    }).join('\n\n')
    : '（本次未检索到实务问答条目）'

  const evidenceSection = (evidence || []).length
    ? evidence.map((item, index) => {
      const kindLabel = item.kind === 'risk_rule' ? '风险点' : item.referenceRole === 'excellent_template' ? '范本条款' : '参考条款'
      const heading = [item.clauseNo, item.title, item.category].filter(Boolean).join('｜')
      return `[K${index + 1}] ${kindLabel}｜来源：${item.sourceName || '知识库'}｜${heading || '未编号'}\n${String(item.text || '').slice(0, 1200)}`
    }).join('\n\n')
    : '（本次未检索到范本条款证据）'

  const caseSection = (cases || []).length
    ? cases.map((item, index) => {
      const meta = [item.caseNo, item.court, item.judgedAt].filter(Boolean).join('｜')
      const provenance = [item.batch, item.source].filter(Boolean).join('｜')
      return `[C${index + 1}] ${item.title || '劳动争议案例'}${meta ? `\n${meta}` : ''}${provenance ? `\n来源：${provenance}` : ''}\n争议焦点：${item.disputeFocus || '未标注'}\n裁判要点：${String(item.holding || '').slice(0, 900)}`
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
${caseSection}

请严格按系统规定：先给结论，再给案件分析，再给解决建议。
**实务问答 [B#] 是本系统最主要的实务依据**，请优先采用其中的处理口径与操作步骤；
其中标注的案号是原资料引用的真实裁判文书，可直接引用（须保留案号），也可作为向用户说明裁判倾向的依据。
若提供了材料，请先识别材料性质（劳动合同 / 员工手册 / 规章制度 / 仲裁裁决书 / 往来函件 / 考勤或工资记录等），
再基于材料原文分析，**引用材料内容时须逐字摘录并标明来自哪份材料**；材料中未写明的事实不得推断为已存在。
上面的材料可能来自本次咨询的前几轮，请结合用户当前问题一并理解，不要因为本轮没有重新上传就当作没有材料。
引用法规前确认其已出现在【法规时效基准】中；引用案例时标注来源。
若上述材料与证据不足以支撑结论，请明确说明"证据不足，需人工核实"，不要凭记忆补充。`
}
