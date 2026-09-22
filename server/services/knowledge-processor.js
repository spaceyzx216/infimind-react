const MAX_CLAUSE_CHARS = 1600
const MIN_CLAUSE_CHARS = 80

/**
 * 将合同正文切成可引用的条款单元，而不是按固定字数盲切。
 * 结果保留条款号、标题、父级标题和原始字符位置，便于检索与审查报告回链。
 */
export function splitIntoClauses(text) {
  const normalized = normalizeText(text)
  if (!normalized) return []

  const lines = normalized.split('\n')
  const segments = []
  let current = createSegment({ title: '前言、主体与定义', clauseNo: '', parentTitle: '', startOffset: 0 })
  const hierarchy = new Map()
  let offset = 0

  for (const line of lines) {
    const trimmed = line.trim()
    const heading = parseHeading(trimmed)
    if (heading && current.content.trim()) {
      segments.push(finalizeSegment(current, offset - 1))
      const parentTitle = resolveParentTitle(heading, hierarchy)
      current = createSegment({ ...heading, parentTitle, startOffset: offset })
    } else if (heading && !current.content.trim()) {
      current = createSegment({ ...heading, parentTitle: resolveParentTitle(heading, hierarchy), startOffset: offset })
    }

    if (heading) hierarchy.set(heading.level, heading.title || heading.clauseNo)
    if (trimmed) current.content += `${current.content ? '\n' : ''}${trimmed}`
    offset += line.length + 1
  }
  if (current.content.trim()) segments.push(finalizeSegment(current, normalized.length))

  const expanded = []
  for (const segment of segments) {
    if (segment.content.length <= MAX_CLAUSE_CHARS) {
      expanded.push(segment)
      continue
    }
    const parts = splitLongClause(segment.content)
    parts.forEach((content, index) => expanded.push({
      ...segment,
      content,
      chunkIndex: index,
      title: `${segment.title}${parts.length > 1 ? `（${index + 1}/${parts.length}）` : ''}`,
      endOffset: segment.startOffset + content.length
    }))
  }

  const nonEmpty = expanded.filter((segment) => segment.content.length >= MIN_CLAUSE_CHARS)
  return (nonEmpty.length ? nonEmpty : expanded).map((segment, index) => ({
    ...segment,
    clauseKey: `clause-${index + 1}`,
    chunkIndex: segment.chunkIndex || 0,
    // 条款此前没有类别，映射证据时硬写空串，正向模板条款因此完全进不了类别覆盖统计。
    // 这里用与风险规则同一套 inferRiskCategory 推导，让正向条款也能参与维度覆盖。
    // 已知缺口：inferRiskCategory 不产出「劳动用工合规」，劳动合同条款会落到邻近类或兜底类。
    category: segment.category || inferRiskCategory(segment.content)
  }))
}

/** 将坏例中的人工批注转成可检索、可复用的风险规则。 */
/**
 * 汇总式批注拆分 —— **实测后决定不启用**，代码保留在此仅作记录。
 *
 * 背景：两类批注粒度差 10 倍。租赁/买卖等是逐条 `【风险批注N：…】`（每份抽 15~18 条）；
 * 委托/中介/保证/知产等是末尾一大段 `（风险分析：…修改建议：…）`，一段里塞了 2~3 个风险点，
 * 整段被存成 1 条 ⇒ 每份只抽出 1~3 条。猜测拆开能补回一批证据。
 *
 * 实测（41 例，heuristic 口径，拆分后规则 604→637）：
 *   拆全量：召回 +1.20pp、精度 −1.02pp
 *   只拆低密度文档：召回 +0.62pp、精度 −0.21pp
 * ⇒ 召回涨的与精度掉的是同一量级（都在 1pp 噪声区间），净收益不明，却要长期背碎片化风险
 *   ⇒ **不采用**。真要补证据，靠补素材而不是切碎现有批注。
 */
export function splitSummaryAnnotation(normalized) {
  const SUMMARY_MIN_CHARS = 150
  const SPLIT_MIN_CHARS = 24
  if (normalized.length < SUMMARY_MIN_CHARS) return null
  const matched = normalized.match(/风险分析[：:]([\s\S]*?)(?:修改建议[：:]|建议[：:]|$)/)
  if (!matched) return null
  const advice = (normalized.match(/修改建议[：:]([\s\S]*)$/) || [])[1] || ''
  const sentences = String(matched[1] || '')
    .split(/(?<=[。；])/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= SPLIT_MIN_CHARS)
  if (sentences.length < 2) return null
  const suffix = advice.trim() ? ` 修改建议：${advice.trim()}` : ''
  return sentences.map((sentence) => `风险分析：${sentence}${suffix}`)
}

export function extractRiskRules(text, clauses) {
  const source = String(text || '')
  const annotations = [
    ...findAnnotations(source, /【[^】]*(?:风险批注|风险分析|批注)[^】]*】/g),
    ...findAnnotations(source, /（(?:风险批注|风险分析)[^）]*）/g)
  ]
  const deduped = []
  const seen = new Set()
  for (const annotation of annotations) {
    const normalized = annotation.text.replace(/\s+/g, ' ').trim()
    if (normalized.length < 12 || seen.has(normalized)) continue
    seen.add(normalized)
    const clause = findNearestClause(annotation.startOffset, clauses)
    const category = inferRiskCategory(`${normalized}\n${clause?.content || ''}`)
    const severity = inferSeverity(normalized)
    const { riskText, recommendation } = parseAnnotation(normalized)
    deduped.push({
      ruleKey: `risk-${deduped.length + 1}`,
      sourceClauseKey: clause?.clauseKey || '',
      category,
      severity,
      triggerText: (clause?.content || '').slice(0, 1000),
      riskText,
      recommendation,
      sourceNote: normalized.slice(0, 1800)
    })
  }
  return deduped
}

/** 将 Word 原生批注转为可检索的人工审核证据，不将批注文字混入模板正文。 */
export function extractWordAnnotationRiskRules(annotations = [], clauses = [], revisions = {}) {
  return annotations
    .filter((annotation) => annotation?.text?.trim())
    .map((annotation, index) => {
      const anchor = String(annotation.anchor || '').trim()
      const category = inferWordAnnotationCategory(`${anchor}\n${annotation.text}`) || inferRiskCategory(`${anchor}\n${annotation.text}`)
      const revisionHint = revisions.insertions || revisions.deletions
        ? `文档修订足迹：新增 ${revisions.insertions || 0} 处，删除 ${revisions.deletions || 0} 处`
        : ''
      const sourceClause = anchor ? findClauseByText(anchor, clauses) : null
      return {
        ruleKey: `word-comment-${index + 1}`,
        sourceClauseKey: sourceClause?.clauseKey || '',
        category,
        severity: '中',
        triggerText: (anchor || sourceClause?.content || '批注关联条款未保留').slice(0, 1000),
        riskText: `人工批注：${annotation.text.trim()}`.slice(0, 1200),
        recommendation: '请结合交易事实核对该条批注，必要时调整对应合同约定。',
        sourceNote: [
          '【Word 原生批注】',
          annotation.author ? `批注人：${annotation.author}` : '',
          annotation.date ? `日期：${annotation.date}` : '',
          revisionHint
        ].filter(Boolean).join('；')
      }
    })
}

export function inferRiskCategory(text) {
  const value = String(text || '')
  const categories = [
    ['合同效力与权利救济', /效力高于法律|排除法律|永久有效|放弃.*?(?:抗辩|索赔|起诉|仲裁|解除)|单方解释|法律适用/],
    ['主体、授权与通知', /主体|统一社会信用代码|授权|法定代表人|送达|通知|账户变更/],
    ['标的、范围与附件', /标的|规格|数量|范围|图纸|样品|附件|订单|工程量清单/],
    ['价税、付款与发票', /价款|付款|预付款|尾款|税率|含税|发票|收款账户|结算/],
    ['交付、履行与验收', /交付|发货|签收|验收|隐蔽瑕疵|履行|到货/],
    ['质量、质保与售后', /质量|质保|瑕疵|维修|退货|更换|售后/],
    ['风险、所有权与保险', /风险转移|所有权|毁损|灭失|保险|货损/],
    ['变更、解除与违约', /变更|解除|违约|违约金|赔偿|延期|顺延|签证/],
    ['保密、数据与知识产权', /保密|数据|知识产权|专利|源代码|开源/],
    ['争议解决', /争议|管辖|仲裁|诉讼/],
    ['工程履约', /工程|施工|工期|进度款|竣工|安全/],
    ['运输、保管与仓储', /运输|承运|冷链|保管|仓储|仓单|提货/]
  ]
  return categories.find(([, pattern]) => pattern.test(value))?.[0] || '其他履约风险'
}

function normalizeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function createSegment({ clauseNo, title, parentTitle, startOffset, level = 0 }) {
  return { clauseNo, title, parentTitle, startOffset, endOffset: startOffset, level, content: '', chunkIndex: 0 }
}

function finalizeSegment(segment, endOffset) {
  return { ...segment, content: segment.content.trim(), endOffset }
}

function parseHeading(line) {
  const article = line.match(/^(第[一二三四五六七八九十百千万零〇]+条)\s*[、.．：:]?\s*(.*)$/)
  if (article) return { clauseNo: article[1], title: article[2] || article[1], level: 1 }

  const numbered = line.match(/^(\d+(?:\.\d+){1,3})[、.．）)]?\s+(.{2,})$/)
  if (numbered) return { clauseNo: numbered[1], title: numbered[2], level: numbered[1].split('.').length + 1 }

  const chinese = line.match(/^([一二三四五六七八九十]+)[、.．）)]\s*(.{2,})$/)
  if (chinese) return { clauseNo: chinese[1], title: chinese[2], level: 1 }
  return null
}

function resolveParentTitle(heading, hierarchy) {
  for (let level = heading.level - 1; level >= 1; level--) {
    if (hierarchy.has(level)) return hierarchy.get(level)
  }
  return ''
}

function splitLongClause(text) {
  const paragraphs = text.split(/\n+/).filter(Boolean)
  const parts = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > MAX_CLAUSE_CHARS) {
      parts.push(current)
      current = paragraph
    } else {
      current += `${current ? '\n' : ''}${paragraph}`
    }
  }
  if (current) parts.push(current)
  return parts
}

function findAnnotations(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => ({ text: match[0], startOffset: match.index || 0 }))
}

function findNearestClause(offset, clauses) {
  if (!clauses?.length) return null
  return clauses.find((clause) => offset >= clause.startOffset && offset <= clause.endOffset) ||
    [...clauses].reverse().find((clause) => clause.startOffset <= offset) || clauses[0]
}

/**
 * 严重度信号词表（修问题 9）。
 *
 * 原 `inferSeverity` **只升不降**：默认一律返回"中" ⇒ 604 条里 503"中"、101"高"、**0"低"**，
 * 分级形同虚设，审查 Agent 拿到 12 条证据分不清轻重缓急。
 *
 * 改为按三个**可解释的客观信号**判档。**不调 LLM**：判档口径属于法律判断，
 * 这里只做规则化打分，理由（reasons）一并输出，便于法务抽检与后续修订。
 *
 *   ① 法定强制 / 效力瑕疵：法律明文禁止、或影响条款效力的表述
 *   ② 金额与责任敞口：涉及钱、比例、赔偿范围的表述
 *   ③ 权利不对等：单方权利 / 单方免责的表述
 *   ④ 程序性瑕疵：通知方式、送达地址、文本份数等形式问题
 *
 * 判档：
 *   高 = ① 或 (②且③) 或批注明示高危   —— 违法条款或"又赔钱又单边"
 *   中 = ② 或 ③ 之一
 *   低 = 仅④，或批注明示低危且无 ①②③
 * 兜底"中" —— 审查场景宁严勿松，不轻易判低。
 */
const SEVERITY_SIGNALS = {
  explicitHigh: /(?:极高|特别高|高危|严重|重大)/,
  explicitLow: /(?:低危|低风险|轻微)/,
  // ⚠️ 故意不含「应当 / 必须」：那是极普通的义务表述（"甲方应当付款"），拿来判高会把 84% 的规则顶成"高"
  mandatory: /(?:无效|违法|禁止|强制性规定|法定|不得(?:主张|抗辩|解除|变更|转让|再|以任何)|排除对方主要权利|免除(?:己方|自身|本方)责任|加重对方责任|显失公平|无权|剥夺)/,
  exposure: /(?:全额|全部赔偿|原值|无限|连带|惩罚性|违约金|赔偿金|损失赔偿|赔偿(?:对方|全部|所有)|(?:金额|价款|费用|租金|报酬)[（(]?[\d¥]|百分之|\d+\s*%|\d+\s*％)/,
  imbalance: /(?:仅甲方|仅乙方|仅(?:由)?(?:买|卖|甲|乙|出租|承租|委托|受托)方|单方|不得主张|放弃(?:权利|主张|抗辩)|概不负责|不承担任何|免除责任|自行承担)/,
  procedural: /(?:通知(?:方式|渠道|地址)|送达(?:地址|方式)|联系方式|文本(?:格式|份数)|份数|盖章|签署页|宽限(?:期|日))/,
  // 抬头 / 填空式样板（甲方名称、统一社会信用代码、地址…）——零信息条目，不是风险
  boilerplate: /(?:名称[：:]\s*_|统一社会信用代码|联系(?:电话|方式)[：:]\s*_|地址[：:]\s*_{2,}|_{5,})/
}

/** 严重度三维打分：返回 { level, reasons }，reasons 供人工抽检与法务确认 */
export function scoreSeverity(text) {
  const value = String(text || '')
  const hit = (pattern) => pattern.test(value)
  const explicitHigh = hit(SEVERITY_SIGNALS.explicitHigh)
  const explicitLow = hit(SEVERITY_SIGNALS.explicitLow)
  const mandatory = hit(SEVERITY_SIGNALS.mandatory)
  const exposure = hit(SEVERITY_SIGNALS.exposure)
  const imbalance = hit(SEVERITY_SIGNALS.imbalance)
  const procedural = hit(SEVERITY_SIGNALS.procedural)
  const boilerplate = hit(SEVERITY_SIGNALS.boilerplate)
  const reasons = []

  // 零信息条目优先判低：它们是合同抬头/填空样板，不是风险
  if (boilerplate && !explicitHigh && !mandatory) return { level: '低', reasons: ['抬头/填空式样板（零信息条目）'] }

  // 「高」要求两个信号互相印证，或一个法定强制信号被批注强调 —— 避免单一宽泛词把大量规则顶成高
  if (mandatory && (exposure || imbalance)) reasons.push('法定强制 + 敞口/不对等')
  else if (exposure && imbalance) reasons.push('金额敞口 + 权利不对等')
  else if (explicitHigh && (mandatory || exposure || imbalance)) reasons.push('批注强调 + 风险信号')
  if (reasons.length) {
    if (explicitHigh) reasons.push('批注明示高危')
    return { level: '高', reasons }
  }

  if (exposure) return { level: '中', reasons: ['金额敞口'] }
  if (imbalance) return { level: '中', reasons: ['权利不对等'] }
  if (mandatory) return { level: '中', reasons: ['法定强制表述'] }
  if (explicitHigh) return { level: '中', reasons: ['仅批注强调，未见具体风险表述'] }
  if (explicitLow) return { level: '低', reasons: ['批注明示低危'] }
  if (procedural) return { level: '低', reasons: ['程序性/形式性瑕疵'] }
  return { level: '中', reasons: ['无强信号，保守取中'] }
}

function inferSeverity(text) {
  return scoreSeverity(text).level
}

function inferWordAnnotationCategory(text) {
  return /劳动合同|试用期|工时|加班|工资|社保|劳动报酬|员工手册|规章制度|派驻|劳动仲裁|无固定期限|休息休假/.test(text) ? '劳动用工合规' : ''
}

function findClauseByText(anchor, clauses) {
  const normalizedAnchor = normalizeInline(anchor)
  if (!normalizedAnchor) return null
  return clauses.find((clause) => normalizeInline(clause.content).includes(normalizedAnchor)) ||
    clauses.find((clause) => normalizedAnchor.includes(normalizeInline(clause.content).slice(0, 80))) || null
}

function normalizeInline(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function parseAnnotation(annotation) {
  const content = annotation.replace(/^[【（]|[】）]$/g, '').trim()
  const recommendationMatch = content.match(/(?:修改建议|建议)[:：]\s*([\s\S]+)$/)
  const recommendation = recommendationMatch?.[1]?.trim().slice(0, 900) || '请结合交易事实明确约定，并保留双方书面确认与救济路径。'
  const riskText = (recommendationMatch ? content.slice(0, recommendationMatch.index) : content).trim().slice(0, 1200)
  return { riskText, recommendation }
}
