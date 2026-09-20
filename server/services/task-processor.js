import { TaskCancelledError, runContractReview } from '../workflows/contract-review.js'
import { runContractDraft } from '../workflows/contract-draft.js'

const transientPatterns = [
  /timeout/i,
  /timed out/i,
  /temporar/i,
  /rate.?limit/i,
  /too many requests/i,
  /network/i,
  /econnreset/i,
  /eai_again/i,
  /fetch failed/i,
  /\b429\b/,
  /\b5\d{2}\b/,
  /503/,
  /502/,
  /504/
]

const isTransient = (error) => {
  const errorText = `${error?.code || ''} ${error?.message || error || ''}`
  return Boolean(error?.retryable || transientPatterns.some((pattern) => pattern.test(errorText)))
}

export function createTaskProcessor({
  taskService,
  fileStore,
  fakeLlm = String(process.env.TASK_FAKE_LLM || '').toLowerCase() === 'true',
  reviewWorkflow = runContractReview,
  draftWorkflow = runContractDraft
} = {}) {
  if (!taskService || !fileStore) throw new Error('task processor requires taskService and fileStore')

  const processTask = async (taskId, { assumedClaimed = false } = {}) => {
    let task = taskService.getTaskInternal(taskId, false)
    if (!task || taskService.isTerminal(task.status)) return task
    let claimedNow = false
    if (task.status === 'queued' || task.status === 'retry_waiting') {
      task = taskService.claimTask(taskId)
      claimedNow = Boolean(task)
    }
    // BullMQ 可能在恢复期间重新投递同一个任务。只有成功原子领取的
    // 执行流程才能继续；否则第二个 Job 只能安全结束，不能重复调用模型。
    if (task?.status === 'running' && !assumedClaimed && !claimedNow) return task
    if (!task) return taskService.getTaskInternal(taskId, false)
    if (task.status === 'cancel_requested' || task.status === 'cancelled') return taskService.markCancelled(taskId)

    const emit = (event, payload = {}) => taskService.appendEvent(taskId, event, payload, payload.stage || null)
    const checkpoint = (stage, result) => taskService.saveCheckpoint(taskId, stage, result)
    const getCheckpoint = (stage) => taskService.getCheckpoint(taskId, stage)
    const isCancellationRequested = () => taskService.isCancellationRequested(taskId)

    try {
      const files = await fileStore.readFiles(taskService.getFiles(taskId))
      const input = taskService.getTaskInput?.(taskId) || {}
      const workflow = task.productId === 'contract-draft' ? draftWorkflow : reviewWorkflow
      const result = await workflow({
        task,
        input,
        files,
        emit,
        checkpoint,
        getCheckpoint,
        isCancellationRequested,
        updateFileParseStatus: (fileId, status) => taskService.updateFileParseStatus(fileId, status),
        fakeLlm
      })
      if (isCancellationRequested()) return taskService.markCancelled(taskId)
      const completed = taskService.completeTask(taskId, result)
      if (task.productId === 'contract-draft') {
        if (completed?.status === 'cancel_requested') return taskService.markCancelled(taskId, 'user_requested')
        if (completed?.status === 'succeeded') {
          taskService.appendEvent(taskId, 'done', { status: 'succeeded', resultAvailable: true, productId: task.productId })
        }
      }
      return completed
    } catch (error) {
      if (error instanceof TaskCancelledError || error?.code === 'TASK_CANCELLED' || isCancellationRequested()) {
        return taskService.markCancelled(taskId, 'user_requested')
      }
      const current = taskService.getTaskInternal(taskId, false)
      if (isTransient(error) && current && current.attemptCount < current.maxAttempts) {
        const delay = 1000 * (2 ** Math.max(0, current.attemptCount - 1))
        return taskService.retryTask(taskId, error, delay)
      }
      return taskService.failTask(taskId, error, { code: isTransient(error) ? 'retry_exhausted' : (error.code || 'task_failed') })
    }
  }

  return { processTask }
}

export { isTransient }
