import { calculatePensionEstimate } from './pension-calculator.js'

export const PENSION_HISTORY_LIMIT = 50
export const pensionHistoryKey = (userId, toolId) => `fafee-history-v2:${userId}:${toolId}:calculations`

export function readPensionHistory(storage, key, toolId) {
  try {
    const raw = (typeof storage === 'function' ? storage() : storage).getItem(key)
    if (!raw) return { records: [], error: '' }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('Invalid history')
    const records = []
    const ids = new Set()
    let skipped = false
    let outdated = false
    for (const record of parsed.slice(0, PENSION_HISTORY_LIMIT)) {
      try {
        if (!record || typeof record.id !== 'string' || record.id.length > 100 || ids.has(record.id)
          || typeof record.title !== 'string' || record.title.length > 100
          || !Number.isFinite(record.updatedAt) || record.updatedAt <= 0 || record.form?.toolId !== toolId) throw new Error('Invalid record')
        // Never trust stored arithmetic. Same-version snapshots must reproduce
        // their result; old-version inputs remain available for explicit re-run.
        const verified = calculatePensionEstimate(record.form)
        if (record.result?.ruleVersion !== verified.ruleVersion) outdated = true
        records.push({ ...record, result: record.result?.ruleVersion === verified.ruleVersion ? verified : null })
        ids.add(record.id)
      } catch { skipped = true }
    }
    return { records, error: [skipped && '部分历史记录无法读取，已跳过；其余记录仍可使用。', outdated && '历史记录已保留；填写口径已更新，请核对记录截止年月后重新计算。'].filter(Boolean).join('') }
  } catch {
    return { records: [], error: '当前浏览器暂时无法读取历史记录，仍可填写和计算。' }
  }
}

export function writePensionHistory(storage, key, records) {
  try {
    ;(typeof storage === 'function' ? storage() : storage).setItem(key, JSON.stringify(records.slice(0, PENSION_HISTORY_LIMIT)))
    return ''
  } catch {
    return '本次结果已算出，但历史记录未能保存到浏览器。请检查浏览器存储权限或空间。'
  }
}
