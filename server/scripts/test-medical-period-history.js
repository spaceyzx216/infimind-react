import assert from 'node:assert/strict'
import { calculateMedicalPeriod, prepareMedicalPeriodInput } from '../../src/utils/medical-period-calculator.js'
import { deleteMedicalRecord, medicalHistoryKey, readMedicalHistory, saveMedicalRecord } from '../../src/utils/medical-period-history.js'

let checks = 0
const test = (name, run) => { run(); checks++; console.log(`PASS ${name}`) }
const mockStorage = () => {
  const data = new Map()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}
const makeRecord = (id = 'medical-1') => {
  const input = { region: 'national', hireDate: '2022-05-07', totalWorkYears: '8',
    asOf: '', recordMode: 'intervals', leaveType: 'continuous', historyComplete: true,
    segments: [{ startDate: '2026-01-01', endDate: '2026-03-31', workDays: '' }] }
  return { id, createdAt: 1791504000000, input,
    result: calculateMedicalPeriod(prepareMedicalPeriodInput(input), { today: '2026-10-09' }) }
}

test('delete exactly one saved record, preserving another tab, account and unreadable entries', () => {
  const storage = mockStorage()
  saveMedicalRecord('a', makeRecord('one'), { storage })
  saveMedicalRecord('a', makeRecord('two'), { storage })
  saveMedicalRecord('b', makeRecord('other-account'), { storage })
  const key = medicalHistoryKey('a')
  const envelope = JSON.parse(storage.getItem(key))
  envelope.records.push({ id: 'unreadable', note: 'preserve' })
  storage.setItem(key, JSON.stringify(envelope))
  assert.equal(deleteMedicalRecord('a', 'one', { storage }).ok, true)
  assert.deepEqual(JSON.parse(storage.getItem(key)).records.map(item => item.id), ['two', 'unreadable'])
  assert.equal(readMedicalHistory('b', { storage }).records.length, 1)
})

test('failed deletion and corrupt history never report success or replace contents', () => {
  const storage = mockStorage()
  const key = medicalHistoryKey('a')
  storage.setItem(key, 'broken-json')
  assert.equal(deleteMedicalRecord('a', 'one', { storage }).ok, false)
  assert.equal(storage.getItem(key), 'broken-json')
  assert.equal(deleteMedicalRecord('a', 'one', { storage: { getItem: () => null, setItem: () => { throw Error('blocked') } } }).ok, false)
  assert.equal(deleteMedicalRecord('', 'one', { storage }).ok, false)
})

test('empty history and account separation', () => {
  const storage = mockStorage()
  assert.deepEqual(readMedicalHistory('a', { storage }), { records: [], error: '' })
  assert.equal(saveMedicalRecord('a', makeRecord(), { storage }).ok, true)
  assert.equal(readMedicalHistory('a', { storage }).records.length, 1)
  assert.equal(readMedicalHistory('b', { storage }).records.length, 0)
})
test('reload preserves original inputs, cutoff, result, process and sources', () => {
  const storage = mockStorage()
  const record = makeRecord()
  saveMedicalRecord('a', record, { storage })
  const saved = readMedicalHistory('a', { storage }).records[0]
  assert.equal(saved.compatible, true)
  assert.equal(saved.input.asOf, '')
  assert.equal(saved.result.input.asOf, '2026-03-31')
  assert.equal(saved.result.records.naturalDays, 90)
  assert.deepEqual(saved.result, record.result)
  assert.equal(saved.result.steps.length, 4)
  assert.equal(saved.result.rule.sources.length, 2)
})
test('append preserves another tab and puts new records first', () => {
  const storage = mockStorage()
  saveMedicalRecord('a', makeRecord('tab-a'), { storage })
  saveMedicalRecord('a', makeRecord('tab-b'), { storage })
  assert.deepEqual(readMedicalHistory('a', { storage }).records.map((item) => item.id), ['tab-b', 'tab-a'])
})
test('same id does not duplicate history', () => {
  const storage = mockStorage()
  saveMedicalRecord('a', makeRecord(), { storage })
  saveMedicalRecord('a', makeRecord(), { storage })
  assert.equal(readMedicalHistory('a', { storage }).records.length, 1)
})
test('corrupt JSON and unknown envelopes are never overwritten', () => {
  const storage = mockStorage()
  for (const text of ['broken-json', '[]', '{"version":999,"records":[]}']) {
    storage.setItem(medicalHistoryKey('a'), text)
    assert(readMedicalHistory('a', { storage }).error)
    assert.equal(saveMedicalRecord('a', makeRecord(), { storage }).ok, false)
    assert.equal(storage.getItem(medicalHistoryKey('a')), text)
  }
})
test('unreadable individual entries stay stored when appending', () => {
  const storage = mockStorage()
  storage.setItem(medicalHistoryKey('a'), JSON.stringify({ version: 1, records: [null, { id: 'broken' }] }))
  assert(readMedicalHistory('a', { storage }).error)
  assert.equal(saveMedicalRecord('a', makeRecord(), { storage }).ok, true)
  assert.equal(JSON.parse(storage.getItem(medicalHistoryKey('a'))).records.length, 3)
  assert.equal(readMedicalHistory('a', { storage }).records.length, 1)
})
test('old versions restore only conditions until recalculated', () => {
  const storage = mockStorage()
  const record = makeRecord()
  record.result.algorithmVersion = 'historical-version'
  saveMedicalRecord('a', record, { storage })
  const saved = readMedicalHistory('a', { storage }).records[0]
  assert.equal(saved.compatible, false)
  assert.equal(saved.result.algorithmVersion, 'historical-version')
})
test('altered result is not trusted', () => {
  const storage = mockStorage()
  const record = makeRecord()
  record.result.quota.months = 999
  saveMedicalRecord('a', record, { storage })
  const saved = readMedicalHistory('a', { storage }).records[0]
  assert.equal(saved.compatible, false)
  assert.equal(saved.displayResult.quota.months, 3)
})
test('save leaves other tools and users untouched', () => {
  const storage = mockStorage()
  storage.setItem('fafee-history-v2:a:pension-calc1:threads', 'original')
  saveMedicalRecord('b', makeRecord(), { storage })
  assert.equal(storage.getItem('fafee-history-v2:a:pension-calc1:threads'), 'original')
  assert.equal(storage.getItem(medicalHistoryKey('a')), null)
})
test('read and write failures are reported', () => {
  const blocked = { getItem: () => { throw new Error('SecurityError') } }
  assert(readMedicalHistory('a', { storage: blocked }).error)
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
  assert.equal(saveMedicalRecord('a', makeRecord(), { storage: full }).ok, false)
})
test('unauthenticated access never uses a shared guest key', () => {
  const storage = mockStorage()
  assert(readMedicalHistory('', { storage }).error)
  assert.equal(saveMedicalRecord('', makeRecord(), { storage }).ok, false)
  assert.equal(storage.getItem(medicalHistoryKey('')), null)
})
test('mutation after save cannot change a persisted input', () => {
  const storage = mockStorage()
  const record = makeRecord()
  saveMedicalRecord('a', record, { storage })
  record.input.totalWorkYears = '20'
  assert.equal(readMedicalHistory('a', { storage }).records[0].input.totalWorkYears, '8')
})
test('a later successful save includes earlier unsaved in-memory records', () => {
  const storage = mockStorage()
  const pending = makeRecord('pending')
  const saved = saveMedicalRecord('a', makeRecord('new'), { storage, pendingRecords: [pending] })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.records.map((item) => item.id), ['new', 'pending'])
  assert(saved.records.every((item) => item.persisted))
})

test('segmented cycle balances persist and old pre-segmentation snapshots require recalculation', () => {
  const storage = mockStorage()
  const record = makeRecord()
  record.input.leaveType = 'segmented'
  record.input.segments = [{ startDate: '2026-01-05', endDate: '2026-01-14' }, { startDate: '2026-02-02', endDate: '2026-02-09' }]
  record.result = calculateMedicalPeriod(prepareMedicalPeriodInput(record.input), { today: '2026-10-09' })
  assert.equal(saveMedicalRecord('a', record, { storage }).ok, true)
  const restored = readMedicalHistory('a', { storage }).records[0]
  assert.equal(restored.compatible, true)
  assert.deepEqual(restored.result.segmentResults.map(row => row.estimate.remainingDays), [80, 72])
  const key = medicalHistoryKey('a')
  const old = JSON.parse(storage.getItem(key))
  delete old.records[0].result.segmentResults
  old.records[0].result.algorithmVersion = 'medical-period-2026-10-09.4'
  storage.setItem(key, JSON.stringify(old))
  assert.equal(readMedicalHistory('a', { storage }).records[0].compatible, false)
  assert.equal(JSON.parse(storage.getItem(key)).records[0].input.segments.length, 2)
})

console.log(`Medical history: ${checks} cases passed.`)
