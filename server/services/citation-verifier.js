/**
 * 法条引用校验器。
 *
 * 原则与 annotation-locator / revision-merger 一致：**不信任模型输出，服务端给出可信结论**。
 * 模型写"根据《劳动合同法》2025年修订版第38条"时，服务端必须能判定：
 *   - 该法规是否在白名单内；
 *   - 该版本是否存在；
 *   - 在【当前日期】是否仍然有效。
 *
 * 设计约束：**只标注、不改写**模型输出。服务端负责给出可信事实，而不是替模型重写答案。
 */
import { findLaw, resolveLawStatus } from './law-whitelist.js'

/** 中文数字与阿拉伯数字的条号 */
const ARTICLE_PATTERN = '第\\s*([一二三四五六七八九十百千零〇两\\d]{1,8})\\s*条'
/** 书名号引用：《法规名》[第X条] */
const BRACKET_PATTERN = new RegExp(`《([^》]{2,80})》(?:\\s*${ARTICLE_PATTERN})?`, 'g')

/**
 * 法律规范的名称后缀。
 *
 * 为什么需要它：模型在分析上传材料时会用书名号引用**材料本身**
 * （例如《派遣员工劳动合同书》《员工手册》），这些不是法规，
 * 若不区分就会被判成"未收录法规"，在界面上产生大量误导性告警。
 */
const LEGAL_NORM_SUFFIX = /(法|法典|条例|规定|办法|实施细则|解释|决定|规则|准则|通知|意见|批复|复函|答复|纪要|通则|章程)$/

/**
 * 判断一个书名号内的名称是否"看起来是法律规范"。
 * 先去掉尾部括号内容（如「解释（一）」）与空白，再比对后缀。
 * @param {string} name
 * @returns {boolean}
 */
export function looksLikeLegalNorm(name) {
  const cleaned = String(name || '')
    .replace(/[（(][^）)]*[）)]\s*$/, '')
    .replace(/[\s　]+/g, '')
    .trim()
  if (cleaned.length < 3) return false
  return LEGAL_NORM_SUFFIX.test(cleaned)
}

/**
 * 版本号提示：识别"2025年修订版""2012年修正"这类版本标注。
 *
 * ⚠️ 年份后的"年"必须可选：模型也常写「2023修订」「2012修正」。
 * 漏掉这种写法会让本可用于判定的版本信息变成空串，从而**跳过版本校验**（漏报）。
 */
const VERSION_HINT_PATTERN = /((?:19|20)\d{2}\s*年?[^）)]{0,8}(?:修订|修正|版))/
/**
 * 构建"无书名号"的引用模式（如"劳动合同法第三十八条"）。
 * 只使用白名单里的法规名与别名，避免误匹配。
 */
function buildAliasPattern(laws = []) {
  const names = new Set()
  for (const law of laws) {
    names.add(String(law.title || '').replace(/^《|》$/g, ''))
    for (const alias of law.aliases || []) names.add(String(alias))
  }
  const usable = [...names].filter((name) => name.length >= 3).sort((a, b) => b.length - a.length)
  if (!usable.length) return null
  const escaped = usable.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(${escaped.join('|')})\\s*${ARTICLE_PATTERN}`, 'g')
}

const normalizeArticle = (value) => String(value || '').replace(/\s+/g, '')

/**
 * 从模型输出中抽取法条引用。
 *
 * 只抽取"看起来是法律规范"的书名号引用：模型分析上传材料时会用书名号引用材料本身
 * （《派遣员工劳动合同书》等），这些不属于法规引用，必须排除，否则会产生误导性告警。
 *
 * @param {string} text
 * @param {{ laws?: Array, excludeTitles?: string[] }} options
 *   laws          白名单法规，用于识别无书名号引用
 *   excludeTitles 额外排除的名称（如上传附件的标题）
 * @returns {{ citations: Array, ignored: string[] }}
 */
export function extractCitations(text, { laws = [], excludeTitles = [] } = {}) {
  const source = String(text || '')
  const found = []
  const ignored = []
  const seen = new Set()
  const excluded = new Set((excludeTitles || []).map((item) => String(item || '').replace(/《|》/g, '').trim()).filter(Boolean))

  const push = (item) => {
    const key = `${item.lawName}::${item.articleNo}::${item.index}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(item)
  }

  for (const match of source.matchAll(BRACKET_PATTERN)) {
    const lawName = String(match[1] || '').trim()
    if (!lawName) continue
    // 排除《》内是文件名/条款标题等非法规内容
    if (/^(附件|附件\d|第[一二三四五六七八九十]+章)/.test(lawName)) continue
    // 排除上传材料的标题与不像法律规范的名称
    if (excluded.has(lawName) || !looksLikeLegalNorm(lawName)) {
      ignored.push(lawName)
      continue
    }
    push({
      raw: match[0],
      lawName,
      articleNo: normalizeArticle(match[2]),
      hasBrackets: true,
      // 版本提示可能写在书名号内，也可能紧随其后
      versionHint: (lawName.match(VERSION_HINT_PATTERN)?.[1]
        || source.slice(match.index + match[0].length, match.index + match[0].length + 12).match(VERSION_HINT_PATTERN)?.[1]
        || ''),
      index: match.index
    })
  }

  const aliasPattern = buildAliasPattern(laws)
  if (aliasPattern) {
    for (const match of source.matchAll(aliasPattern)) {
      const lawName = String(match[1] || '').trim()
      // 已被书名号模式覆盖的位置跳过
      if (found.some((item) => item.index <= match.index && match.index < item.index + item.raw.length + 4)) continue
      push({
        raw: match[0],
        lawName,
        articleNo: normalizeArticle(match[2]),
        hasBrackets: false,
        versionHint: '',
        index: match.index
      })
    }
  }

  return { citations: found.sort((a, b) => a.index - b.index), ignored }
}

const STATUS_META = {
  verified: { ok: true, level: 'ok', label: '已核实' },
  provisional: { ok: true, level: 'warn', label: '已收录（待复核）' },
  superseded: { ok: false, level: 'error', label: '该版本已被修改' },
  repealed: { ok: false, level: 'error', label: '该法规已废止' },
  expired: { ok: false, level: 'error', label: '该法规已失效' },
  pending_effect: { ok: false, level: 'warn', label: '该法规尚未生效' },
  not_found: { ok: false, level: 'error', label: '未收录，需人工核实' }
}

/**
 * 校验一组引用。
 * @param {Array} citations extractCitations 的结果
 * @param {{ laws?: Array, today?: Date }} options
 */
export function verifyCitations(citations = [], { laws = [], today = new Date() } = {}) {
  return citations.map((citation) => {
    const law = findLaw(citation.lawName) || laws.find((item) =>
      String(item.title).includes(citation.lawName) || citation.lawName.includes(String(item.title)))
    const status = resolveLawStatus(law, today)
    const meta = STATUS_META[status] || STATUS_META.not_found

    let note = ''
    if (status === 'repealed') {
      note = law?.supersededBy ? `已于 ${law.effectiveTo || '—'} 废止，由《${law.supersededBy}》取代` : '已废止，不得作为现行依据引用'
    } else if (status === 'superseded') {
      note = '该版本已被修改，请核对现行有效版本'
    } else if (status === 'expired') {
      note = `已于 ${law.effectiveTo} 失效`
    } else if (status === 'pending_effect') {
      note = `自 ${law.effectiveFrom} 起施行，当前尚未生效`
    } else if (status === 'provisional') {
      note = '已收录于白名单，但尚未完成人工复核'
    } else if (status === 'verified') {
      note = law?.versionLabel ? `${law.versionLabel}，自 ${law.effectiveFrom} 起施行` : `自 ${law.effectiveFrom} 起施行`
    } else {
      note = '该法规未收录于服务端法规白名单，其存在性与时效性未经核实'
    }

    // 版本号异常：模型引用了白名单中不存在的版本。
    //
    // ⚠️ 这里只说"记录版本"，**不能**拿年份去和"施行/失效日期"做包含判断：
    // 日期字符串里天然带有年份，于是"2024年修订版"会被 `effectiveFrom='2024-07-01'`
    // 放行——而《公司法》恰恰是 2023年修订、2024-07-01 施行，于是这个不存在的版本号
    // 一路通过校验。这正是本功能最该拦住的一类幻觉（实测已复现）。
    //
    // 判定改为：把模型标注的版本与记录版本做**归一化后的双向包含**，
    // 并且允许"2023修订"这类省略"年"的写法（把它归一为"2023年修订"再比）。
    const normalizeVersionText = (value) => String(value || '')
      .replace(/[\s　]+/g, '')
      // "2023修订" / "2012修正" → 补上"年"，与记录里的"2023年修订"对齐
      // ⚠️ 必须同时覆盖「修订」与「修正」：白名单里既有"2023年修订"也有"2012年修正"
      .replace(/((?:19|20)\d{2})(?=修订|修正)/, '$1年')
    let versionWarning = ''
    if (law && citation.versionHint) {
      const normalizedHint = normalizeVersionText(citation.versionHint)
      const normalizedLabel = normalizeVersionText(law.versionLabel)
      const describesRecordedVersion = Boolean(normalizedLabel)
        && (normalizedLabel.includes(normalizedHint) || normalizedHint.includes(normalizedLabel))
      if (!describesRecordedVersion) {
        versionWarning = `模型标注的版本「${citation.versionHint}」未见于白名单记录（记录版本：${law.versionLabel || '未标注'}）`
      }
    }

    return {
      raw: citation.raw,
      lawName: law?.title || citation.lawName,
      citedName: citation.lawName,
      articleNo: citation.articleNo,
      hasBrackets: citation.hasBrackets,
      versionHint: citation.versionHint || '',
      status,
      level: versionWarning ? 'error' : meta.level,
      ok: meta.ok && !versionWarning,
      label: meta.label,
      note: versionWarning || note,
      effectiveFrom: law?.effectiveFrom || '',
      effectiveTo: law?.effectiveTo || '',
      versionLabel: law?.versionLabel || '',
      issuingBody: law?.issuingBody || '',
      sourceUrl: law?.sourceUrl || ''
    }
  })
}

/**
 * 一步完成：抽取 + 校验 + 去重。
 *
 * 去重规则：同一「法规 + 条号」在回答中多次出现时只保留一条。
 * 法律回答里同一条文常被反复引用，逐次列出会让核实面板充满噪音。
 *
 * @param {string} text
 * @param {{ laws?: Array, today?: Date, excludeTitles?: string[] }} options
 * @returns {{ citations: Array, summary: { total, ok, problems, notFound, hasProblems, ignoredNonLegal } }}
 */
export function verifyOutput(text, { laws = [], today = new Date(), excludeTitles = [] } = {}) {
  const { citations: extracted, ignored } = extractCitations(text, { laws, excludeTitles })
  const verified = verifyCitations(extracted, { laws, today })

  const deduped = []
  const seenKeys = new Set()
  for (const item of verified) {
    const key = `${item.lawName}::${item.articleNo}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    deduped.push(item)
  }

  const ok = deduped.filter((item) => item.ok).length
  const notFound = deduped.filter((item) => item.status === 'not_found').length
  return {
    citations: deduped,
    ignored,
    summary: {
      total: deduped.length,
      ok,
      notFound,
      problems: deduped.length - ok,
      hasProblems: deduped.length > ok,
      // 被识别为"对材料而非法规的引用"而跳过核实数量，用于排查校验器误伤
      ignoredNonLegal: ignored.length
    }
  }
}

/**
 * 生成追加在回答末尾的校验说明（Markdown）。
 * 注意：不改写模型正文，只在末尾追加服务端的核实结论。
 */
export function renderCitationNotice(citations = []) {
  if (!citations.length) return ''
  const lines = ['', '---', '', '### 法规引用核实（系统自动）', '']
  citations.forEach((item, index) => {
    const icon = item.ok ? '✅' : item.level === 'warn' ? '⚠️' : '❌'
    const article = item.articleNo ? `第${item.articleNo}条` : ''
    lines.push(`${icon} **《${item.lawName}》${article}** —— ${item.label}${item.note ? `：${item.note}` : ''}`)
  })
  const summary = citations.filter((item) => !item.ok).length
  if (summary) {
    lines.push('', `> 其中 ${summary} 处引用未能通过核实，请勿直接采信；相关结论建议由律师或法务复核后再使用。`)
  }
  return lines.join('\n')
}
