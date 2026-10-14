// Synthetic checkpoints and an injected workflow only. No model, network, project DB
// or uploaded material is used.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLaborRecovery } from '../services/labor-recovery.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskService } from '../services/task-service.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskProcessor } from '../services/task-processor.js'

const document = { fileId: 'file-1', fileName: '虚构劳动合同.docx', role: 'direct_labor_contract', text: '第一条 月工资8000元，每月15日支付。' }
const finding = (index, title) => ({ topic: '薪酬', level: '中', title, quote: `虚构条款${index}`, risk: `虚构风险${index}`, advice: '补充明确支付安排' })

// 与线上那次失败任务同形：只有 material-source / review-pages / material-coverage，没有最终 result。
const aborted = buildLaborRecovery([
  { stage: 'material-source', result: { documents: [document], failures: [] } },
  { stage: 'material-coverage', result: { parsed: 2, selected: ['block-0'], entered: ['block-0'], checked: [], partial: true } },
  { stage: 'review-pages', result: { version: 1, round: 1, page: 10, payload: { findings: [finding(1, '工资支付日期待确认'), finding(1, '工资支付日期待确认')] } } }
], new Error('覆盖核对仍无法完整结束，已保存完成结果。'))

assert.equal(aborted.productId, 'labor-contract-analysis')
assert.equal(aborted.schemaVersion, 3, '必须满足前端批注稿分支的 schemaVersion 条件')
assert.deepEqual(aborted.revisions, [], '没有 rewrite 检查点时不得编造批注')
assert.equal(aborted.sourceDocuments.length, 1, '恢复稿必须带原文，否则右侧批注栏无法渲染')
assert.equal(aborted.sourceDocuments[0].text, document.text)
assert.equal(aborted.analysisStatus, 'partial', '恢复稿不是完成证书')
assert.equal(aborted.reviewComplete, false)
assert.equal(aborted.recoveredFromFailure, true)
assert.equal(aborted.findings.length, 1, '同一问题的重复记录应去重')
assert.ok(aborted.warnings.some((warning) => warning.includes('覆盖核对')), '未核对范围必须如实提示')
assert.ok(aborted.missingItems.some((item) => item.topic === '覆盖核对'))
assert.equal(aborted.materialCoverage.partial, true)

// 有跨轮 combinedFindings 与 rewrite-batches 时，恢复稿要保留两边成果。
const repeated = finding(1, '工资支付日期待确认')
const withRevisions = buildLaborRecovery([
  { stage: 'material-source', result: { documents: [document] } },
  { stage: 'analysis-overview', result: { text: '# 合同基础识别\n- 合同类型：劳动合同' } },
  { stage: 'review', result: { combinedFindings: [repeated], firstRoundReport: '## 重点风险与处理建议\n工资支付日期待确认。', roundSnapshots: [{ round: 1, newCount: 1 }, { round: 2, newCount: 0 }] } },
  { stage: 'review-pages', result: { payload: { findings: [repeated, finding(3, '第二轮问题')] } } },
  { stage: 'rewrite-batches', result: { revisions: [{ findingId: 'group-1', level: '中', action: 'modify', title: '工资支付日期待确认', rewrittenText: '每月15日支付。' }] } }
], new Error('条款冲突修复后仍未通过核对，已保留批注成果。'))
assert.equal(withRevisions.analysisOverview, '# 合同基础识别\n- 合同类型：劳动合同', '失败恢复稿必须带回结构分析概览')
assert.equal(withRevisions.findings.length, 2, '跨轮成果与轮内成果都要保留且去重')
assert.equal(withRevisions.revisions.length, 1, '已生成的批注必须保留给前端展示')
assert.equal(withRevisions.reviewRounds.length, 2)
assert.equal(withRevisions.reviewReport, '## 重点风险与处理建议\n工资支付日期待确认。')
assert.ok(withRevisions.warnings.some((warning) => warning.includes('条款冲突修复后仍未通过核对')))

// 没有原文时无法渲染批注稿，明确返回 null，不产出空壳结果。
assert.equal(buildLaborRecovery([{ stage: 'review-pages', result: { payload: { findings: [finding(1, '无原文')] } } }], new Error('合成失败')), null)

// 端到端：越过失败的劳动合同任务仍然要交付可读结果，任务本身保持 failed。
const database = createBusinessDatabase(':memory:')
try {
  const service = createTaskService(database)
  database.prepare('INSERT INTO invite_codes (id,code_hash,created_at) VALUES (?,?,?)').run('invite', 'fake', new Date().toISOString())
  database.prepare('INSERT INTO users (id,username,email,password_hash,password_salt,invite_code_id,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('owner', 'synthetic', 'test@example.invalid', 'fake', 'fake', 'invite', new Date().toISOString())
  const store = createTaskFileStore({ root: mkdtempSync(join(tmpdir(), 'labor-recovery-')) })
  const files = await store.saveIncomingFiles('labor-recovery-task',
    [{ originalname: '虚构劳动合同.txt', mimetype: 'text/plain', buffer: Buffer.from(document.text) }])
  const task = service.createTask({ id: 'labor-recovery-task', userId: 'owner', productId: 'labor-contract-analysis',
    threadId: 'labor-recovery-thread', mode: 'fast', files })
  const processor = createTaskProcessor({ taskService: service, fileStore: store, fakeLlm: false,
    laborContractAnalysisWorkflow: async ({ checkpoint }) => {
      await checkpoint('material-source', { documents: [{ ...document, fileId: files[0]?.id || 'file-1' }], failures: [] })
      await checkpoint('review-pages', { version: 1, round: 1, page: 3, payload: { findings: [finding(1, '工资支付日期待确认')] } })
      await checkpoint('material-coverage', { parsed: 1, selected: ['block-0'], entered: ['block-0'], checked: [], partial: true })
      throw Object.assign(new Error('条款冲突修复后仍未通过核对，已保留批注成果。'), { code: 'labor_revision_conflict', unitRetryExhausted: true })
    } })
  const failed = await processor.processTask(task.id)
  assert.equal(failed.status, 'failed', '任务仍必须如实标记失败')
  assert.equal(failed.errorCode, 'labor_revision_conflict')
  assert.ok(failed.result, '恢复结果必须写进失败任务的 result，前端才能展示批注稿')
  assert.equal(failed.result.analysisStatus, 'partial')
  assert.equal(failed.result.reviewComplete, false)
  assert.equal(failed.result.sourceDocuments[0].text, document.text)
  assert.equal(failed.result.findings.length, 1)
  assert.ok(failed.result.warnings.some((warning) => warning.includes('已保留批注成果')))
  // analysis 检查点会在失败时被清理，恢复结果不能依赖它。
  assert.ok(!service.getCheckpoint(task.id, 'analysis'), 'analysis 检查点会在失败时被清理，恢复结果不能依赖它')
  assert.ok(service.getCheckpoint(task.id, 'material-source'), '恢复所依赖的检查点必须保留')

  // 追问失败：回答只存在于 followup.delta 事件里（failTask 会清理这些事件），
  // 必须在失败落库前把已生成的部分取回来，否则刷新后回答消失。
  const followup = service.createTask({ id: 'labor-recovery-followup', userId: 'owner', productId: 'labor-contract-analysis',
    threadId: 'labor-recovery-thread', mode: 'fast', input: { action: 'followup', sourceTaskId: 'labor-recovery-task' } })
  const streamed = '根据现有材料，工资差额请求应先核对付款凭证；在取得凭证前不宜承认欠付金额。'
  service.appendEvent(followup.id, 'followup.delta', { content: streamed.slice(0, 18) }, 'consult')
  service.appendEvent(followup.id, 'followup.delta', { content: streamed.slice(18) }, 'consult')
  const streamedEvents = service.getEvents(followup.id, 'owner', 0, 1000)
  service.failTask(followup.id, Object.assign(new Error('连接中断'), { code: 'task_failed' }),
    { code: 'task_failed', result: buildLaborRecovery(service.listCheckpoints(followup.id), new Error('连接中断'),
      { task: service.getTaskInternal(followup.id, false), events: streamedEvents }) })
  const recoveredFollowup = service.getTask(followup.id, 'owner', true)
  assert.equal(recoveredFollowup.status, 'failed', '追问失败仍然是失败状态')
  assert.equal(recoveredFollowup.result.kind, 'followup')
  assert.equal(recoveredFollowup.result.answer, streamed, '必须保留已流出的部分回答')
  assert.equal(recoveredFollowup.result.recoveredFromFailure, true)
  assert.ok(recoveredFollowup.result.warnings.some((warning) => warning.includes('本次追问未完成')))
} finally {
  database.close()
}

console.log('PASS labor recovery: checkpoint-only readable result, dedupe, preserved revisions, honest partial marking, failure still failed and source documents retained (synthetic only)')
