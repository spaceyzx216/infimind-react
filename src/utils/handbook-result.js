import { canShowHandbookClause } from './handbook-annotations.js'

export const HANDBOOK_PRODUCT = 'handbook-diagnosis'
export const HANDBOOK_TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
export const HANDBOOK_STATUS = { queued: '等待处理', running: '正在检查', retry_waiting: '正在重试', cancel_requested: '正在停止', cancelled: '已停止', failed: '检查未完成', succeeded: '处理结束' }

export function formatHandbookAuthorityStatus(item) {
  const provision = { matched: '条号已匹配', not_found: '条号未找到', unavailable: '未提供条文', ambiguous: '条文版本存在歧义', inactive: '条文版本不在有效期' }
  const quote = { matched: '引文已匹配', missing: '未提供法条引文', mismatch: '引文未匹配' }
  const support = { model_supported: '模型认为有支持', model_unsupported: '模型认为缺乏支持', uncertain: '模型尚不能判断' }
  return [provision[item.provisionStatus] || '条文未核验', quote[item.quoteStatus] || '引文待核验', support[item.supportStatus] || '支持关系未复核', '法律适用待复核'].join(' · ')
}

export function formatHandbookReport(report) {
  if (!report) return ''
  if (report.kind === 'followup') return report.answer || ''
  const lines = ['员工手册诊断', '', `检查范围：${report.scope?.description || '范围待核实'}`,
    `检查状态：${report.analysisStatus === 'completed' ? '本次可读正文检查完成' : report.analysisStatus === 'blocked' ? '材料待处理，未完成诊断' : '检查尚未完成'}`]
  for (const [index, finding] of (report.findings || []).entries()) {
    lines.push('', '────────', `${index + 1}. ${finding.title}`, `${finding.status === 'pending' ? '待核实' : '风险提示'} · ${finding.topic}`, '', '问题说明', finding.explanation)
    if (finding.verificationNote) lines.push(`核对状态：${finding.verificationNote}`)
    for (const [position, citation] of (finding.evidence || []).entries()) lines.push('', `原文 ${position + 1}`, citation.quote, `定位：${citation.location?.status === 'found' ? citation.location.matches[0].fileName + ' · ' + citation.location.matches[0].sectionTitle : '引用待核实'}`)
    if (finding.conditions?.length) lines.push('', '适用条件', ...finding.conditions.map((item) => `- ${item}`))
    if (finding.authorities?.length) lines.push('', '待核实依据')
    for (const authority of finding.authorities || []) lines.push(`${authority.title} ${authority.article}；${authority.note}`, formatHandbookAuthorityStatus(authority),
      ...(authority.versionLabel ? [`版本：${authority.versionLabel}`] : []), ...(authority.quote ? [`法条引文：${authority.quote}`] : []),
      ...(authority.supportReason ? [`模型复核意见：${authority.supportReason}`] : []), ...(authority.sourceUrl ? [`来源：${authority.sourceUrl}`] : []))
    lines.push('', '修改建议', finding.recommendation || '请结合缺失背景进一步核实。')
    if (canShowHandbookClause(finding, report.sourceDocuments)) lines.push('', '示例条款', finding.suggestedClause)
    if (finding.relatedChanges?.length) lines.push('', '关联修改', ...finding.relatedChanges.map((item) => `- ${item}`))
  }
  for (const item of report.unreadableMaterials || []) lines.push(`未检查材料：${item.fileName}；${item.reason}`)
  if (report.pendingQuestions?.length) lines.push('', '待核实事项', ...report.pendingQuestions)
  if (report.procedureChecklist?.length) lines.push('', '程序核对清单（未审核证据）', ...report.procedureChecklist.map((item) => `${item.title}：${item.description}；${item.materials.join('、')}；${item.note}`))
  if (report.referenceVersions?.length) lines.push('', '参考资料', ...report.referenceVersions.map((item) => `${item.title} · ${item.version}（仅参考）`))
  if (report.warnings?.length) lines.push('', '检查限制', ...report.warnings)
  return lines.filter((value) => typeof value === 'string').join('\n')
}

export async function readHandbookEvents(response, receive, signal) {
  if (!response.body) throw new Error('检查进度暂不可读取')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const consume = (block) => {
    let event = 'message'
    let sequence = 0
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('id:')) sequence = Number(line.slice(3).trim()) || 0
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length) {
      let payload
      try { payload = JSON.parse(data.join('\n')) } catch { throw new Error('检查进度读取不完整，请重新连接') }
      receive(event, payload, sequence)
    }
  }
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (signal?.aborted) break
      buffer = (buffer + decoder.decode(value || new Uint8Array(), { stream: !done })).replace(/\r\n/g, '\n')
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      for (const block of blocks) consume(block)
      if (done) { if (buffer.trim()) consume(buffer); break }
    }
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock() }
}
