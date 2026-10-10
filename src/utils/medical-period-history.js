import { calculateMedicalPeriod, normalizeMedicalDate, prepareMedicalPeriodInput } from './medical-period-calculator.js'

// Browser history only, partitioned by the authenticated account and tool.
// Each immutable record includes original inputs and the entire result snapshot.
export const medicalHistoryKey = (userId) => `fafee-history-v2:${userId}:medical-calculator:calculations`
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

function readEnvelope(storage, key) {
  const text = storage.getItem(key)
  if (text === null) return { version: 1, records: [] }
  const value = JSON.parse(text)
  if (!object(value) || value.version !== 1 || !Array.isArray(value.records)) throw new Error('invalid-history')
  return value
}

export function readMedicalHistory(userId, options = {}) {
  if (typeof userId !== 'string' || !userId) return { records: [], error: '未登录，测算记录无法保存。' }
  try {
    const storage = options.storage || window.localStorage
    const envelope = readEnvelope(storage, medicalHistoryKey(userId))
    const records = []
    let skipped = 0
    for (const record of envelope.records) {
      try {
        if (!object(record) || typeof record.id !== 'string' || !record.id || !Number.isFinite(record.createdAt)
          || !object(record.input) || !object(record.result) || record.result.ok !== true
          || !normalizeMedicalDate(record.result.assessmentDate)) throw new Error('invalid-record')
        const expected = calculateMedicalPeriod(prepareMedicalPeriodInput(record.input), { today: record.result.assessmentDate })
        if (!expected.ok) throw new Error('invalid-input')
        // Old rules or altered snapshots may restore inputs, never a trusted result.
        const compatible = JSON.stringify(expected) === JSON.stringify(record.result)
        records.push({ ...record, compatible, persisted: true, displayResult: expected })
      } catch { skipped++ }
    }
    return { records, error: skipped ? '部分历史记录无法读取，原始保存内容已保留。' : '' }
  } catch {
    return { records: [], error: '历史记录读取失败，原始内容未覆盖；当前仍可测算。' }
  }
}

export function saveMedicalRecord(userId, record, options = {}) {
  if (typeof userId !== 'string' || !userId) return { ok: false, error: '未登录，测算记录无法保存。' }
  try {
    const storage = options.storage || window.localStorage
    const key = medicalHistoryKey(userId)
    // Re-read before appending so another tab's records are not overwritten.
    // Unreadable individual entries stay in the envelope; no automatic deletion.
    const envelope = readEnvelope(storage, key)
    const pending = [record, ...(options.pendingRecords || [])].map((item) => ({ id: item.id, createdAt: item.createdAt, input: item.input, result: item.result }))
    const ids = new Set(pending.map((item) => item.id))
    const next = { version: 1, records: [...pending, ...envelope.records.filter((item) => !ids.has(item?.id))] }
    storage.setItem(key, JSON.stringify(next))
    return { ok: true, ...readMedicalHistory(userId, { storage }) }
  } catch {
    return { ok: false, error: '本次记录未保存：浏览器存储不可用、空间不足或历史内容异常。结果可先复制，当前页面仍可回看。' }
  }
}

export function deleteMedicalRecord(userId, id, options = {}) {
  if (typeof userId !== 'string' || !userId || typeof id !== 'string' || !id) return { ok: false, error: '无法确定要删除的测算记录。' }
  try {
    const storage = options.storage || window.localStorage
    const key = medicalHistoryKey(userId)
    const envelope = readEnvelope(storage, key)
    storage.setItem(key, JSON.stringify({ ...envelope, records: envelope.records.filter((item) => item?.id !== id) }))
    return { ok: true, ...readMedicalHistory(userId, { storage }) }
  } catch {
    return { ok: false, error: '历史记录未删除：浏览器存储不可用或历史内容异常。' }
  }
}
