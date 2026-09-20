import { Queue, Worker } from 'bullmq'

const DEFAULT_QUEUE_NAME = 'fafee-contract-review'

const parseRedisConnection = (redisUrl) => {
  const url = new URL(redisUrl)
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379)
  }
  if (url.username) connection.username = decodeURIComponent(url.username)
  if (url.password) connection.password = decodeURIComponent(url.password)
  if (url.pathname && url.pathname !== '/') connection.db = Number(url.pathname.slice(1)) || 0
  if (url.protocol === 'rediss:') connection.tls = {}
  return connection
}

const asConcurrency = (value, fallback = 1) => Math.min(Math.max(Number(value) || fallback, 1), 32)

export function createTaskQueue({
  taskService,
  processTask,
  mode = process.env.TASK_QUEUE_MODE || 'auto',
  redisUrl = process.env.REDIS_URL,
  concurrency = process.env.TASK_WORKER_CONCURRENCY,
  queueName = DEFAULT_QUEUE_NAME,
  pollIntervalMs = 300,
  workerEnabled = process.env.TASK_RUN_WORKER !== 'false'
} = {}) {
  if (!taskService || typeof processTask !== 'function') throw new Error('task queue requires taskService and processTask')
  const workerConcurrency = asConcurrency(concurrency, 1)
  const useBull = mode === 'bullmq' || (mode === 'auto' && Boolean(redisUrl))
  if (useBull && !redisUrl) throw new Error('TASK_QUEUE_MODE=bullmq 时必须配置 REDIS_URL')

  let started = false
  let timer = null
  const active = new Set()
  let queue = null
  let worker = null

  const processLocalTask = (taskId) => {
    active.add(taskId)
    // 本地轮询在取任务时已经完成原子领取；把这一事实传给处理器，
    // 避免处理器把已领取任务误判为重复 Job。
    Promise.resolve(processTask(taskId, { assumedClaimed: true }))
      .catch((error) => console.error(`[task-queue] local worker failed for ${taskId}:`, error.message))
      .finally(() => {
        active.delete(taskId)
        if (started && !useBull) void tick()
      })
  }

  const tick = async () => {
    if (!started || useBull) return
    while (active.size < workerConcurrency) {
      const task = taskService.claimNextTask()
      if (!task || active.has(task.id)) break
      processLocalTask(task.id)
    }
  }

  const enqueueBull = async (taskId, { delay = 0, jobId = taskId } = {}) => {
    await queue.add('contract-review', { taskId }, {
      jobId,
      delay: Math.max(0, Number(delay) || 0),
      attempts: 1,
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 }
    })
  }

  const enqueue = async (taskId) => {
    if (useBull) {
      if (!queue) throw new Error('任务队列尚未启动')
      await enqueueBull(taskId)
      return { mode: 'bullmq', taskId }
    }
    if (!workerEnabled) throw new Error('本地队列 Worker 已关闭；请配置 REDIS_URL 或启动 Worker')
    await tick()
    return { mode: 'local', taskId }
  }

  const start = async () => {
    if (started) return { mode: useBull ? 'bullmq' : 'local', concurrency: workerConcurrency }
    started = true
    // API-only 进程不拥有任务执行权，不能在启动时重置 Worker 正在处理的任务。
    // 只有真正启用 Worker 的进程负责恢复崩溃后遗留的 running 任务。
    if (workerEnabled) taskService.recoverInFlight()
    if (useBull) {
      const connection = parseRedisConnection(redisUrl)
      queue = new Queue(queueName, { connection })
      if (workerEnabled) {
        worker = new Worker(queueName, async (job) => {
          const result = await processTask(job.data.taskId)
          if (result?.status === 'retry_waiting') {
            const delay = Math.max(250, new Date(result.nextRunAt || Date.now()).getTime() - Date.now())
            await enqueueBull(job.data.taskId, { delay, jobId: `${job.data.taskId}:retry:${result.attemptCount}` })
          }
          return result
        }, {
          connection: { ...connection, maxRetriesPerRequest: null },
          concurrency: workerConcurrency
        })
        worker.on('failed', (job, error) => {
          console.error(`[task-queue] BullMQ job failed${job?.id ? ` (${job.id})` : ''}:`, error.message)
        })
        for (const taskId of taskService.listPendingTaskIds()) {
          try { await enqueue(taskId) } catch (error) { console.error(`[task-queue] enqueue recovered task ${taskId} failed:`, error.message) }
        }
      }
    } else {
      if (workerEnabled) {
        timer = setInterval(() => { void tick() }, Math.max(100, Number(pollIntervalMs) || 300))
        timer.unref?.()
        await tick()
      }
    }
    return { mode: useBull ? 'bullmq' : 'local', concurrency: workerConcurrency }
  }

  const close = async () => {
    started = false
    if (timer) clearInterval(timer)
    timer = null
    if (worker) await worker.close()
    if (queue) await queue.close()
    worker = null
    queue = null
    active.clear()
  }

  return {
    mode: useBull ? 'bullmq' : 'local',
    concurrency: workerConcurrency,
    workerEnabled,
    start,
    enqueue,
    close,
    get activeCount() { return active.size }
  }
}

export { DEFAULT_QUEUE_NAME }
