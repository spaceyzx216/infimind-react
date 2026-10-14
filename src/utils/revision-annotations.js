// 批注稿的展示与人工编辑（商业合同审查 / 劳动合同分析共用）。
//
// 约定：
// 1. 批注定位（lineStart / quoteSpans / insertAfterLine）只信服务端校验结果；人工编辑只覆盖
//    展示字段，不改写定位数据，所以编辑后的批注仍然钉在原来的句子上。
// 2. 页面展示、复制、下载 Word 全部走同一个 buildDisplayRevisions(revisions, annotationEdits)，
//    导出的必然是最后确定的意见，不会回退成模型初稿。
// 3. 批注 id 使用服务端下发的 findingId / editId（局部批注用 editId），人工编辑按 id 覆盖，
//    不按数组下标覆盖，归并组增删或重跑分析都不会把意见串到别的条款上。

export const ANNOTATION_EDIT_FIELDS = ['title', 'operation', 'rewrittenText', 'noticeText', 'riskNote', 'fullRewrittenText']
export const ANNOTATION_OPERATIONS = ['replace', 'delete', 'insert-after', 'notice']
export const ANNOTATION_OPERATION_LABELS = { replace: '改为', delete: '删除此处', 'insert-after': '在此后补充', notice: '提示' }
// 单字段上限只用于挡住异常数据撑爆 localStorage；正常条款建议远低于该长度。
const MAX_ANNOTATION_FIELD_LENGTH = 200000

const EDIT_FIELD_SET = new Set(ANNOTATION_EDIT_FIELDS)
const OPERATION_SET = new Set(ANNOTATION_OPERATIONS)

export const EMPTY_ANNOTATION_EDITS = Object.freeze({})

export const isFileMarker = (line = '') => /^===\s*文件\s*[：:]/.test(String(line).trim())

const asPatchValue = (field, value) => {
  if (typeof value !== 'string') return undefined
  if (field === 'operation') return OPERATION_SET.has(value) ? value : undefined
  return value.slice(0, MAX_ANNOTATION_FIELD_LENGTH)
}

// 只保留白名单字段的字符串值；空串是有效编辑（用于删除建议文字），不在这里过滤。
export const normalizeAnnotationEdit = (patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const next = {}
  Object.entries(patch).forEach(([field, value]) => {
    if (!EDIT_FIELD_SET.has(field)) return
    const clean = asPatchValue(field, value)
    if (clean === undefined) return
    next[field] = clean
  })
  return next
}

// 读取本地/消息里持久化的编辑表，过滤掉损坏数据，保证渲染层永远拿到可用对象。
// 记录里允许带一个 target 锚点指纹（见 annotationTargetOf），它不是意见字段，不参与渲染。
export const normalizeAnnotationEditRecord = (record) => {
  const fields = normalizeAnnotationEdit(record)
  if (!Object.keys(fields).length) return {}
  const target = typeof record?.target === 'string' ? record.target.slice(0, 4000) : ''
  return target ? { ...fields, target } : fields
}

export const normalizeAnnotationEdits = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next = {}
  Object.entries(value).forEach(([key, patch]) => {
    if (typeof key !== 'string' || !key) return
    const clean = normalizeAnnotationEditRecord(patch)
    if (Object.keys(clean).length) next[key] = clean
  })
  return next
}

export const countAnnotationEdits = (edits) => Object.keys(normalizeAnnotationEdits(edits)).length

// 当前这批修订里真正生效的人工编辑条数：锚点对不上的旧记录不算，
// 否则标题栏会显示「已人工修改 N 条」而正文一条都看不到。
export const countAppliedAnnotationEdits = (revisions, edits) => buildDisplayRevisions(revisions, edits).filter((revision) => revision.edited).length

// 多会话（按任务/报告 id 分桶）的编辑表：劳动合同分析把编辑存在本浏览器，键是任务 id。
export const normalizeAnnotationEditStore = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next = {}
  Object.entries(value).forEach(([scope, edits]) => {
    if (typeof scope !== 'string' || !scope) return
    const clean = normalizeAnnotationEdits(edits)
    if (Object.keys(clean).length) next[scope] = clean
  })
  return next
}

export const setAnnotationEdit = (edits, key, patch, target = '') => {
  const current = edits && typeof edits === 'object' ? edits : {}
  if (!key) return current
  const clean = normalizeAnnotationEdit(patch)
  if (!Object.keys(clean).length) return current
  const record = { ...(current[key] || {}), ...clean }
  if (typeof target === 'string' && target) record.target = target
  return { ...current, [key]: record }
}

export const clearAnnotationEdit = (edits, key) => {
  const current = edits && typeof edits === 'object' ? edits : {}
  if (!key || !current[key]) return current
  const next = { ...current }
  delete next[key]
  return next
}

// 批注 id：服务端 findingId / editId 优先；缺失时退回展示序号，保证每条批注都能被编辑，
// 也避免旧代码里 `${undefined}-local-1` 这种两份批注撞同一个 key 的情况。
export const annotationKeyOf = (revision, index = 0) => {
  const id = revision?.findingId || revision?.editId
  return typeof id === 'string' && id ? id : `annotation-${index}`
}

// 批注锚点指纹：服务端批注 ID 是位置序号（revision-group-N-local-M / finding-N-local-M），
// 同一个任务/消息重跑后会换内容。编辑记录带上写入时的锚点，渲染时锚点不一致就丢弃该补丁，
// 避免把上一版的人工意见套到重新分析后位置相同的另一条条款上。
export const annotationTargetOf = (revision) => JSON.stringify([
  revision?.action || '',
  Number.isInteger(revision?.lineStart) ? revision.lineStart : null,
  Number.isInteger(revision?.lineEnd) ? revision.lineEnd : null,
  Number.isInteger(revision?.insertAfterLine) ? revision.insertAfterLine : null,
  revision?.originalText || revision?.quoteText || revision?.anchorText || ''
])

const withAnnotationEdit = (revision, edits) => {
  const record = edits && typeof edits === 'object' ? edits[revision.findingId] : null
  if (!record || typeof record !== 'object') return revision
  const fields = normalizeAnnotationEdit(record)
  if (!Object.keys(fields).length) return revision
  // 没有 target 的是本机制上线前的旧记录，按原样生效；带 target 的必须锚点一致。
  if (typeof record.target === 'string' && record.target && record.target !== annotationTargetOf(revision)) return revision
  return { ...revision, ...fields, edited: true }
}

// 修订块 → 可渲染的编号批注（原 ContractRewritePage 内部实现，抽到纯函数便于复制/下载共用与回归）。
export const buildDisplayRevisions = (revisions = [], annotationEdits = null) => {
  let markerNumber = 0
  let displayIndex = 0
  const source = Array.isArray(revisions) ? revisions : []
  return source.filter((revision) => revision && typeof revision === 'object' && !Array.isArray(revision)).flatMap((revision) => {
    const localizedEdits = Array.isArray(revision.localizedEdits)
      ? revision.localizedEdits.filter((edit) => edit && typeof edit === 'object' && !Array.isArray(edit))
      : []
    if (revision.action === 'add' || !localizedEdits.length) {
      const display = {
        ...revision,
        findingId: annotationKeyOf(revision, displayIndex++),
        isLocalized: false,
        markerNumber: null
      }
      return [withAnnotationEdit(display, annotationEdits)]
    }
    return localizedEdits.map((edit, index) => {
      markerNumber += 1
      const parentId = typeof revision.findingId === 'string' && revision.findingId ? revision.findingId : ''
      const editId = typeof edit.editId === 'string' && edit.editId ? edit.editId : ''
      const display = {
        ...revision,
        findingId: annotationKeyOf({ findingId: editId || (parentId ? `${parentId}-local-${index + 1}` : '') }, displayIndex++),
        parentFindingId: parentId || revision.findingId,
        memberFindingIds: Array.isArray(edit.memberFindingIds) ? edit.memberFindingIds : revision.memberFindingIds,
        isLocalized: true,
        markerNumber: Number.isInteger(edit.markerNumber) && edit.markerNumber > 0 ? edit.markerNumber : markerNumber,
        operation: (edit.operation || 'replace') === 'replace' && !edit.replacementText ? 'notice' : edit.operation || 'replace',
        lineStart: Number.isInteger(edit.lineStart) ? edit.lineStart : revision.lineStart,
        lineEnd: Number.isInteger(edit.lineEnd) ? edit.lineEnd : revision.lineEnd,
        originalText: edit.targetQuote || revision.quoteText || revision.originalText,
        quoteText: edit.targetQuote || revision.quoteText,
        quoteSpans: Array.isArray(edit.quoteSpans) ? edit.quoteSpans.filter((span) => span && typeof span === 'object') : [],
        quoteStatus: Array.isArray(edit.quoteSpans) && edit.quoteSpans.length ? 'exact' : 'none',
        rewrittenText: edit.replacementText || '',
        riskNote: edit.riskNote || revision.riskNote,
        noticeText: edit.noticeText || '',
        fullRewrittenText: revision.rewrittenText || '',
        localizationStatus: edit.localizationStatus || ''
      }
      return withAnnotationEdit(display, annotationEdits)
    })
  })
}

// 按物理行号把批注挂到原文行：add 挂在 insertAfterLine 之后；高亮片段只保留服务端校验过的偏移。
export const attachRevisionsToLines = (lines = [], revisions = []) => {
  const byLine = new Map()
  const quoteMarks = new Map()
  revisions.forEach((rev) => {
    const start = Number.isInteger(rev.lineStart) ? rev.lineStart : -1
    const end = Number.isInteger(rev.lineEnd) ? rev.lineEnd : start
    const isAdd = rev.action === 'add'
    const attachLine = isAdd && Number.isInteger(rev.insertAfterLine) && rev.insertAfterLine >= 0 && rev.insertAfterLine < lines.length
      ? rev.insertAfterLine
      : end
    if (attachLine < 0 || attachLine >= lines.length) return
    if (!byLine.has(attachLine)) byLine.set(attachLine, [])
    byLine.get(attachLine).push(rev)
    if (isAdd || !Array.isArray(rev.quoteSpans) || !rev.quoteSpans.length) return
    rev.quoteSpans.forEach((span) => {
      if (!span || !Number.isInteger(span.line) || span.line < 0 || span.line >= lines.length) return
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) return
      if (!quoteMarks.has(span.line)) quoteMarks.set(span.line, [])
      quoteMarks.get(span.line).push({ start: span.start, end: span.end, markerNumber: rev.markerNumber })
    })
  })
  return { byLine, quoteMarks }
}

// 合并重叠高亮，保持与 RevisionDocument 完全一致的展示口径。
export const mergeQuoteMarks = (raw, spans = []) => {
  const trimOffset = raw.length - raw.trimStart().length
  const text = raw.trim()
  const merged = []
  spans.slice().sort((a, b) => a.start - b.start).forEach((span) => {
    const start = Math.max(0, span.start - trimOffset)
    const end = Math.max(start, Math.min(span.end - trimOffset, text.length))
    if (end <= start) return
    const last = merged[merged.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      if (span.markerNumber && !last.markerNumbers.includes(span.markerNumber)) last.markerNumbers.push(span.markerNumber)
    } else {
      merged.push({ start, end, markerNumbers: span.markerNumber ? [span.markerNumber] : [] })
    }
  })
  return { text, merged }
}

const suggestionOf = (rev) => rev.operation === 'delete'
  ? '删除该问题片段'
  : rev.operation === 'notice'
    ? (rev.noticeText || rev.riskNote || '请结合实际业务确认并补全该项')
    : (rev.rewrittenText || '请结合批注对该片段作局部调整')

const compactBodyOf = (rev) => rev.action === 'delete'
  ? '建议删除该条款'
  : (rev.rewrittenText || '请参考批注手动修订')

const indent = (value) => String(value ?? '').replace(/\n/g, '\n  ')

// 一条批注的纯文本块：与文档卡片、Word 导出同源，编号口径一致。
const annotationTextLines = (rev) => {
  if (rev.isLocalized) {
    const label = ANNOTATION_OPERATION_LABELS[rev.operation] || ANNOTATION_OPERATION_LABELS.replace
    const lines = [`【${rev.markerNumber}】${label}：${indent(suggestionOf(rev))}`]
    if (rev.originalText) lines.push(`  原片段：${indent(rev.originalText)}`)
    if (rev.riskNote) lines.push(`  批注：${indent(rev.riskNote)}`)
    if (rev.fullRewrittenText && rev.fullRewrittenText !== rev.rewrittenText) lines.push(`  完整条款建议：${indent(rev.fullRewrittenText)}`)
    return lines
  }
  const label = rev.action === 'add' ? '新增' : rev.action === 'delete' ? '删除' : '修订'
  const lines = [`【${label}】${rev.title || '条款调整建议'}`]
  if (rev.action === 'add' && rev.anchorText) lines.push(`  插入于“${indent(rev.anchorText)}”之后`)
  lines.push(`  ${indent(compactBodyOf(rev))}`)
  if (rev.riskNote) lines.push(`  批注：${indent(rev.riskNote)}`)
  return lines
}

// 复制用纯文本批注稿：正文按物理行输出，编号与高亮片段一一对应，批注内容取最终确认版本。
export const buildRevisionPlainText = ({ title = '批注稿', text = '', revisions = [], annotationEdits = null, preserveFileMarkers = false } = {}) => {
  const contractText = String(text || '')
  const displayRevisions = buildDisplayRevisions(revisions, annotationEdits)
  if (!displayRevisions.length) return contractText
  const lines = contractText.split('\n')
  const { byLine, quoteMarks } = attachRevisionsToLines(lines, displayRevisions)
  const blocks = []
  lines.forEach((raw, index) => {
    const line = raw.trim()
    const revs = byLine.get(index) || []
    if (!preserveFileMarkers && isFileMarker(raw)) {
      revs.forEach((rev) => blocks.push(...annotationTextLines(rev)))
      return
    }
    if (line) {
      const spans = quoteMarks.get(index)
      if (spans?.length) {
        const { text: body, merged } = mergeQuoteMarks(raw, spans)
        let rendered = ''
        let cursor = 0
        merged.forEach((mark) => {
          rendered += body.slice(cursor, mark.start)
          rendered += body.slice(mark.start, mark.end)
          if (mark.markerNumbers.length) rendered += `【${mark.markerNumbers.slice().sort((a, b) => a - b).join('·')}】`
          cursor = mark.end
        })
        blocks.push(rendered + body.slice(cursor))
      } else {
        blocks.push(line)
      }
    }
    revs.forEach((rev) => blocks.push(...annotationTextLines(rev)))
  })
  const editedCount = displayRevisions.filter((rev) => rev.edited).length
  const header = [
    `${title}（最终确认意见）`,
    `共 ${displayRevisions.length} 条批注${editedCount ? `，其中 ${editedCount} 条已人工修改` : ''}。`,
    ''
  ].join('\n')
  return `${header}\n${blocks.join('\n')}\n`
}
