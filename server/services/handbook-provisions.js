import { readFile } from 'node:fs/promises'
import { fingerprint, rankHandbookChunks, handbookTopics } from './handbook-structure.js'

const plain = (value) => typeof value === 'string' ? value.trim() : ''
const lawName = (value) => plain(value).replace(/[《》\s]/g, '').replace(/^中华人民共和国/, '')
const compact = (value) => plain(value).replace(/\s/g, '')
export function articleNumber(value) {
  const match = plain(value).match(/^第?([零〇一二三四五六七八九十百\d]+)条(?:第[零〇一二三四五六七八九十百\d]+款)?(?:[（(][零〇一二三四五六七八九十百\d]+[）)])?$/)
  if (!match) return null
  if (/^\d+$/.test(match[1])) return Number(match[1])
  const digits = '零一二三四五六七八九', units = { 十: 10, 百: 100 }
  let result = 0, digit = 0
  for (const c of match[1].replace(/〇/g, '零')) {
    if (units[c]) { result += (digit || 1) * units[c]; digit = 0 }
    else digit = digits.indexOf(c)
  }
  return result + digit
}
const officialUrl = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && /(?:^|\.)gov\.cn$/.test(url.hostname) } catch { return false }
}
const isoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString().slice(0, 10) === value
const todayInChina = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export function provisionIsCurrent(entry, today = todayInChina()) {
  return entry.effectiveFrom <= today && (!entry.effectiveTo || today < entry.effectiveTo)
}

// Read-only, server-owned external file. Never accept a path from uploaded text.
export async function loadHandbookProvisions({ manifestPath = process.env.HANDBOOK_PROVISION_MANIFEST, signal } = {}) {
  if (!manifestPath) return { configured: false, provisions: [], warnings: ['尚未配置员工手册法条正文清单，具体条文依据保持待核实。'] }
  signal?.throwIfAborted()
  const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
  if (!Array.isArray(manifest.provisions)) throw new Error('员工手册法条清单缺少 provisions')
  const ids = new Set()
  const provisions = manifest.provisions.map((entry) => {
    if (!plain(entry.provisionId) || ids.has(entry.provisionId) || !lawName(entry.lawTitle) || !plain(entry.versionLabel)
      || articleNumber(entry.article) === null || !plain(entry.text) || !officialUrl(entry.sourceUrl)
      || !isoDate(entry.effectiveFrom) || (entry.effectiveTo && (!isoDate(entry.effectiveTo) || entry.effectiveTo <= entry.effectiveFrom))
      || !['pending', 'reviewed'].includes(entry.reviewStatus)) throw new Error('员工手册法条记录缺少合法标识、条号、版本、日期、官方来源或审核状态')
    if (articleNumber(entry.text.match(/^第[^条]+条/)?.[0]) !== articleNumber(entry.article)) throw new Error('员工手册法条正文标题与条号不一致')
    ids.add(entry.provisionId)
    return { ...entry, relatedProvisionIds: Array.isArray(entry.relatedProvisionIds) ? entry.relatedProvisionIds : [], contentHash: fingerprint(entry.text) }
  })
  if (provisions.some((p) => p.relatedProvisionIds.some((id) => !ids.has(id)))) throw new Error('员工手册法条关联编号不存在')
  return { configured: true, provisions, warnings: [] }
}

export function matchHandbookProvision(authority, provisions, today) {
  authority = authority || {}
  const matches = provisions.filter((p) => lawName(p.lawTitle) === lawName(authority.title) && articleNumber(p.article) === articleNumber(authority.article)
    && (!authority.provisionId || authority.provisionId === p.provisionId) && (!authority.versionLabel || authority.versionLabel === p.versionLabel))
  if (!matches.length) return { provisionStatus: provisions.length ? 'not_found' : 'unavailable', quoteStatus: 'unverified', applicabilityStatus: 'pending' }
  const current = matches.filter((p) => provisionIsCurrent(p, today))
  if (current.length !== 1) return { provisionStatus: current.length ? 'ambiguous' : 'inactive', quoteStatus: 'unverified', applicabilityStatus: 'pending' }
  const entry = current[0], quote = plain(authority.quote), quoteStatus = !quote ? 'missing' : compact(quote).length >= 8 && compact(entry.text).includes(compact(quote)) ? 'matched' : 'mismatch'
  return { provisionId: entry.provisionId, provisionStatus: 'matched', quoteStatus, applicabilityStatus: 'pending', quote,
    provisionText: entry.text, versionLabel: entry.versionLabel, sourceUrl: entry.sourceUrl, contentHash: entry.contentHash || fingerprint(entry.text), reviewStatus: entry.reviewStatus }
}

export function retrieveHandbookProvisions(text, provisions, today) {
  const current = provisions.filter((p) => provisionIsCurrent(p, today))
  const chunks = current.map((p) => ({ id: p.provisionId, sectionTitle: p.lawTitle + p.article, text: p.text, topics: handbookTopics(p.text) }))
  const selected = new Set(rankHandbookChunks(text, chunks).filter((r) => r.score > 0).slice(0, 4).map((r) => r.chunk.id))
  // A long block can mention several distinct issues. A global top-4 alone
  // lets verbose termination provisions displace short non-compete rules.
  // These anchors only add relevant statute candidates, never legal findings.
  const anchors = [
    [/竞业限制/, '劳动合同法', [23, 24]], [/违约金/, '劳动合同法', [22, 23, 25]],
    [/怀孕|孕期|产期|哺乳/, '劳动合同法', [42]], [/不胜任|调岗|培训/, '劳动合同法', [40]],
    [/民主|公示|规章|签收/, '劳动合同法', [4]], [/加班|补休|延长.*工时/, '劳动法', [44]],
    [/最低工资/, '劳动法', [48]], [/工资|薪酬|报酬|扣款/, '劳动法', [50]]
  ]
  for (const [pattern, title, numbers] of anchors) if (pattern.test(text)) {
    for (const p of current) if (lawName(p.lawTitle) === title && numbers.includes(articleNumber(p.article))) selected.add(p.provisionId)
  }
  let size
  do {
    size = selected.size
    for (const p of current.filter((p) => selected.has(p.provisionId))) for (const id of p.relatedProvisionIds) selected.add(id)
  } while (selected.size !== size)
  return current.filter((p) => selected.has(p.provisionId))
}

export function validateHandbookLegalChecks(output, checks, provisions) {
  if (!Array.isArray(output?.checks) || output.checks.length !== checks.length) throw new Error('法条支持复核未覆盖全部待核查引用')
  const seen = new Set()
  for (const item of output.checks) {
    const expected = checks.find((c) => c.key === item.key)
    const entry = provisions.find((p) => p.provisionId === item.provisionId)
    if (!expected || seen.has(item.key) || item.provisionId !== expected.provisionId || !entry || !plain(item.reason)
      || !['supported', 'unsupported', 'uncertain'].includes(item.support)) throw new Error('法条支持复核返回了无效编号或判断')
    if ((item.support !== 'uncertain' || plain(item.quote)) && (compact(item.quote).length < 8 || !compact(entry.text).includes(compact(item.quote)))) throw new Error('法条支持复核引文未匹配清单原文')
    seen.add(item.key)
  }
  return output.checks
}
