/**
 * 中文 2-gram 分词工具。
 *
 * 背景：SQLite FTS5 的 unicode61 分词器不会切分中文——连续的汉字串会被当成
 * 一个 token，导致 `MATCH '"付款"'` 在包含"付款"的条款上命中 0 条
 * （实测现状词汇召回率仅 14.8%，详见 docs/知识库优化方案.md 问题 1）。
 *
 * 本模块只服务新建的用工咨询知识库（labor.db），不改动既有合同知识库的行为。
 * 做法：索引期把中文按相邻两字展开，查询期把检索词转成 bigram 短语；
 * 多 bigram 用短语查询保证相邻，等价于子串匹配。
 */

const CJK_ONLY = /^[\u4e00-\u9fff]+$/
const TOKEN_PATTERN = /[\u4e00-\u9fff]+|[A-Za-z0-9]+/g

/**
 * 索引期：把文本转成可被 unicode61 正确切分的 token 串。
 * 不改变入库原文，只影响写入 FTS 的副本。
 * @param {string} text
 * @returns {string}
 */
export function toIndexText(text) {
  const tokens = String(text || '').match(TOKEN_PATTERN) || []
  const out = []
  for (const token of tokens) {
    if (CJK_ONLY.test(token)) {
      if (token.length === 1) {
        out.push(token)
        continue
      }
      for (let i = 0; i < token.length - 1; i += 1) out.push(token.slice(i, i + 2))
    } else {
      out.push(token.toLowerCase())
    }
  }
  return out.join(' ')
}

/**
 * 查询期：把单个检索词转成 FTS5 查询片段。
 * 两字词 → 单个 bigram 精确匹配；多字词 → bigram 短语（保证相邻）。
 * @param {string} term
 * @returns {string} 形如 `"付款"` 或 `"违约 约金"`
 */
export function toQueryTerm(term) {
  const clean = String(term || '').trim().replace(/["*]/g, '')
  if (!clean) return ''
  const parts = toIndexText(clean).split(' ').filter(Boolean)
  if (!parts.length) return ''
  return parts.length === 1 ? `"${parts[0]}"` : `"${parts.join(' ')}"`
}

/**
 * 把一组检索词拼成 FTS5 的 OR 查询。
 * @param {string[]} terms
 * @returns {string}
 */
export function buildFtsQuery(terms = []) {
  const parts = (Array.isArray(terms) ? terms : [terms])
    .flatMap((term) => String(term || '').split(/\s*OR\s*|\s+/))
    .map(toQueryTerm)
    .filter(Boolean)
  return parts.length ? parts.join(' OR ') : ''
}

/**
 * 劳动法领域术语表。
 *
 * 用途：给 extractKeywords 提供"词典"，从而实现不依赖分词器的中文术语抽取。
 * 纯滑窗 n-gram 会把"请问公司可以因为员工怀孕降低工资吗"切成 8 字定长块，
 * 无法命中"怀孕""降低工资"这类真实术语；用词典做最长匹配才能得到可用检索词。
 *
 * 维护：新增案例或法规时，把其争议焦点/关键表述补进来即可。
 */
export const LABOR_TERMS = [
  // 主体与关系
  '劳动关系', '事实劳动关系', '用人单位', '劳动者', '主体资格', '适格主体', '劳务派遣', '劳务外包',
  '关联公司', '混同用工', '非全日制', '实习', '退休返聘', '超过法定退休年龄',
  // 订立与二倍工资
  '书面劳动合同', '二倍工资', '订立', '续签', '无固定期限', '劳动合同期限', '录用条件', '入职登记',
  // 试用期
  '试用期', '转正', '不符合录用条件', '延长试用期',
  // 报酬与加班
  '工资', '劳动报酬', '加班费', '加班', '延时加班', '休息日加班', '法定节假日加班', '绩效', '提成',
  '奖金', '拖欠工资', '克扣工资', '最低工资', '工资差额', '同工同酬', '调岗降薪', '降薪',
  '降低工资', '工资待遇', '福利待遇', '变相调岗', '调整工作岗位', '恢复原岗位',
  // 工时休假
  '工时', '标准工时', '综合计算工时', '不定时工时', '休息休假', '年休假', '带薪年休假',
  '未休年休假', '病假', '事假', '调休', '产假', '陪产假', '婚丧假',
  // 社保公积金
  '社会保险', '社保', '社会保险费', '未缴社保', '断缴', '补缴', '公积金', '住房公积金',
  '基本养老保险', '医疗保险', '失业保险', '生育保险', '抚恤金', '丧葬补助金', '工伤保险待遇',
  // 工伤
  '工伤', '工伤认定', '职业病', '停工留薪期', '劳动能力鉴定', '伤残等级', '工亡', '一次性伤残补助金',
  // 三期与特殊保护
  '女职工', '三期', '孕期', '产期', '哺乳期', '怀孕', '生育', '未成年工', '未成年',
  // 规章制度
  '规章制度', '员工手册', '民主程序', '公示告知', '违纪', '严重违纪', '严重违反', '奖惩',
  // 保密与竞业
  '竞业限制', '竞业禁止', '保密义务', '商业秘密', '保密协议', '违约金', '经济补偿', '竞业限制补偿',
  // 解除终止
  '解除', '终止', '违法解除', '解除劳动合同', '经济补偿金', '赔偿金', 'N+1', '裁员', '经济性裁员',
  '协商解除', '被迫解除', '医疗期', '不能胜任工作', '客观情况发生重大变化',
  // 时效程序
  '仲裁', '仲裁时效', '时效', '管辖', '举证', '举证责任', '一裁终局', '仲裁裁决', '诉讼', '起诉',
  // 其他
  '变更', '劳动合同变更', '工作地点', '工作岗位', '考勤', '旷工', '离职', '辞职', '自动离职',
  '用工成本', '书面通知', '送达', '解除通知',
  // 计算口径与常见搭配（补充自实际检索日志）
  '计算基数', '工资基数', '加班工资', '病假工资', '最低工资标准', '工资支付周期',
  '经济补偿金', '赔偿金标准', '代通知金', '未休年休假工资', '医疗补助费',
  '严重违纪', '严重失职', '录用条件', '服务期', '脱密期', '社保缴纳', '补缴社保',
  '被迫解除', '违法解除', '协商解除', '试用期解除', '三期女职工', '劳务派遣工'
]

/**
 * 功能字：兜底切分时不能出现在片段首尾，否则会切出「等特殊工」「条件下的」这类碎片词。
 * 这些碎片会作为 OR 条件进入 FTS 查询，稀释真正有效术语的权重。
 */
/**
 * 查询扩展词表：把用户口语映射到知识库的专业表述。
 *
 * 为什么需要：实测发现未命中的提问多数不是"库里没有"，而是**词表不匹配**——
 * 用户问「离职后去了竞争对手，公司怎么取证」，库里的标题写的是「员工违反竞业限制，如何调查取证」。
 * 靠字面匹配永远连不上，必须做同义词扩展。
 *
 * 维护：新增资料后，若发现某类提问反复检索不到，把该口语说法补进来即可。
 * 值必须是知识库中真实使用的表述（可用 --dump 验证）。
 */
export const SYNONYMS = {
  // 竞业与保密
  竞争对手: ['竞业限制'],
  同行: ['竞业限制'],
  竞业: ['竞业限制'],
  保密: ['保密协议', '商业秘密'],
  客户名单: ['商业秘密'],
  取证: ['调查取证', '证据'],
  调查: ['调查取证'],
  泄密: ['商业秘密'],
  // 不胜任与考核
  业绩: ['不胜任'],
  销售指标: ['不胜任'],
  考核: ['考核不合格', '不胜任'],
  绩效: ['不胜任'],
  能力不足: ['不胜任'],
  // 工伤
  上下班: ['上下班途中', '工伤认定'],
  通勤: ['上下班途中'],
  交通事故: ['工伤认定'],
  受伤: ['工伤'],
  // 违纪与解除
  打架: ['暴力', '违纪解除'],
  斗殴: ['暴力', '违纪解除'],
  暴力: ['违纪解除'],
  开除: ['解除劳动合同'],
  辞退: ['解除劳动合同'],
  迟到: ['违纪解除', '考勤'],
  早退: ['违纪解除', '考勤'],
  // 补偿与工资
  赔偿: ['赔偿金', '经济补偿金'],
  补偿: ['经济补偿金'],
  加班: ['加班费'],
  病假: ['病假工资', '医疗期'],
  年假: ['年休假'],
  // 合同与用工
  不签合同: ['未签订劳动合同', '二倍工资'],
  合同到期: ['劳动合同终止'],
  转正: ['试用期'],
  调岗: ['工作岗位'],
  社保: ['社会保险'],
  退休: ['退休返聘'],
  外包: ['劳务外包', '劳务派遣'],
  派遣: ['劳务派遣'],
  // 以下来自未命中问题的复盘
  搬迁: ['客观情况发生重大变化'],
  迁址: ['客观情况发生重大变化'],
  孕期: ['三期'],
  产期: ['三期'],
  哺乳期: ['三期'],
  降薪: ['降薪'],
  二倍工资: ['2倍工资'],
  双倍工资: ['2倍工资'],
  书面劳动合同: ['未签订劳动合同'],
  报警: ['治安', '违纪解除'],
  记录: ['证据']
}

const FUNCTION_CHARS = new Set('的了在和或与等是有为对从被把就都也还而及以之其这那哪怎幺么呢吗吧啊哦呀嘛个不无将要会能可需应'.split(''))
/** 常见虚词组合：兜底片段不应是这些词，它们不携带任何检索信息 */
const STOPWORD_FRAGMENTS = new Set([
  '如果', '因为', '所以', '但是', '而且', '并且', '虽然', '然而', '因此', '由于',
  '关于', '对于', '根据', '按照', '以及', '或者', '可以', '应当', '需要', '必须',
  '已经', '正在', '将会', '能够', '是否', '哪些', '什么', '怎么', '如何', '为何',
  '我们', '他们', '你们', '这个', '那个', '一个', '以上', '以下', '其中', '同时'
])
const isMeaningfulFragment = (term) =>
  term.length >= 2
  && !STOPWORD_FRAGMENTS.has(term)
  && !FUNCTION_CHARS.has(term[0])
  && !FUNCTION_CHARS.has(term[term.length - 1])

const DEFAULT_LEXICON = LABOR_TERMS

/**
 * 从一段自然语言里抽取关键词。
 *
 * 策略：用词典做**最长匹配**（长术语优先、区间不重叠），命中不足时回退到 3-4 字滑窗。
 * 不引入分词器依赖，且检索词始终落在领域术语上。
 * @param {string} text
 * @param {{ limit?: number, extraTerms?: string[] }} options
 * @returns {string[]}
 */
export function extractKeywords(text, { limit = 12, extraTerms = [] } = {}) {
  const source = String(text || '')
  if (!source.trim()) return []

  // 同义词表的**键**也必须参与匹配——否则用户说的「竞争对手」「取证」「业绩」
  // 既匹配不上词典，也就永远触发不了同义词扩展（早期实现的缺陷）。
  const vocab = [...new Set([...DEFAULT_LEXICON, ...Object.keys(SYNONYMS), ...extraTerms]
    .map((term) => String(term || '').trim())
    .filter((term) => term.length >= 2))]
    .sort((a, b) => b.length - a.length)

  const covered = new Array(source.length).fill(false)
  const hits = []
  for (const term of vocab) {
    let from = 0
    while (from <= source.length - term.length) {
      const index = source.indexOf(term, from)
      if (index < 0) break
      let overlaps = false
      for (let i = index; i < index + term.length; i += 1) {
        if (covered[i]) { overlaps = true; break }
      }
      if (!overlaps) {
        for (let i = index; i < index + term.length; i += 1) covered[i] = true
        hits.push({ term, index })
      }
      from = index + 1
    }
  }
  hits.sort((a, b) => a.index - b.index)
  const matched = hits.map((hit) => hit.term)
  // 英文缩写与编号也是有效检索词（Offer、N+1、2N 等）。
  // 早期实现只看中文，导致「offer发出后反悔要赔多少」抽不出任何检索词，检索返回空结果。
  const latinTerms = (source.match(/[A-Za-z][A-Za-z0-9+#.\-]{1,14}/g) || [])
    .map((token) => token.toLowerCase().replace(/[.\-]+$/, ''))
    .filter((term) => term.length >= 2 && !matched.includes(term))

  // 词典命中两个及以上术语时已足够检索，不再兜底。
  // 早期阈值设为 3，导致「严重违纪 + 解除劳动合同」这种优质组合仍触发兜底，
  // 反而被碎片词稀释。
  // 词典命中两个及以上术语时已足够检索，不再做中文兜底；
  // 但英文缩写仍需补入（中文词典覆盖不到它们）。
  if (matched.length >= 2) return [...new Set([...matched, ...latinTerms])].slice(0, limit)

  // 兜底：只在**未被词典覆盖的连续中文区间**各取一个有意义片段（最多 3 个）。
  // 不放任逐位滑窗——那会产出「等特殊工」「条件下的」这类碎片，
  // 作为 OR 条件进入 FTS 后稀释有效术语的排序权重。
  const fallback = [...matched]
  const seen = new Set(fallback)

  for (const term of latinTerms) {
    if (seen.has(term)) continue
    seen.add(term)
    fallback.push(term)
    if (fallback.length >= limit) break
  }
  const runs = []
  let runStart = -1
  for (let i = 0; i <= source.length; i += 1) {
    const active = i < source.length && !covered[i] && /[\u4e00-\u9fff]/.test(source[i])
    if (active && runStart < 0) runStart = i
    if (!active && runStart >= 0) { runs.push(source.slice(runStart, i)); runStart = -1 }
  }
  for (const run of runs) {
    if (fallback.length >= Math.min(limit, 4)) break
    let picked = ''
    for (let len = Math.min(4, run.length); len >= 2 && !picked; len -= 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const fragment = run.slice(i, i + len)
        if (isMeaningfulFragment(fragment) && !seen.has(fragment)) { picked = fragment; break }
      }
    }
    if (picked) { seen.add(picked); fallback.push(picked) }
  }
  return fallback.slice(0, limit)
}

/**
 * 抽取检索词，并**区分字面命中与同义词扩展**。
 *
 * 为什么需要区分：同义词能救回"口语 vs 专业表述"不匹配的提问（实测显著提升真实检索质量），
 * 但把扩展词与字面词等权参与打分，会稀释字面匹配的精度。
 * 因此对外暴露两组词，由检索层给扩展词更低权重。
 *
 * @param {string} text
 * @param {{ limit?: number, extraTerms?: string[] }} options
 * @returns {{ primary: string[], expanded: string[] }}
 */
export function extractQueryTerms(text, { limit = 12, extraTerms = [] } = {}) {
  const primary = extractKeywords(text, { limit, extraTerms })
  const expanded = []
  const seen = new Set(primary)
  for (const term of primary) {
    for (const synonym of SYNONYMS[term] || []) {
      if (seen.has(synonym)) continue
      seen.add(synonym)
      expanded.push(synonym)
    }
  }
  return { primary, expanded }
}

/**
 * 从案例库等语料里补充检索词表。
 * 案例的 disputeFocus 以空格分隔标注，是高质量的领域术语来源。
 * @param {Array<{disputeFocus?:string, title?:string}>} cases
 * @returns {string[]}
 */
export function collectTermsFromCases(cases = []) {
  const terms = new Set()
  for (const item of cases) {
    String(item?.disputeFocus || '').split(/[\s、,，;；/]+/).forEach((term) => {
      const clean = term.trim()
      if (clean.length >= 2 && clean.length <= 12) terms.add(clean)
    })
  }
  return [...terms]
}
