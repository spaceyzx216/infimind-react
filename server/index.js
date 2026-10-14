import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import contractRewriteRouter from './routes/contract-rewrite.js'
import laborConsultRouter, { bootstrapLaborKnowledge } from './routes/labor-consult.js'
import { createAuthRouter } from './routes/auth.js'
import { createRequireAuth } from './middleware/auth.js'
import { createAuthService } from './services/auth-service.js'
import { initialize, loadTemplates } from './services/knowledge-base.js'
import { createTaskRuntime } from './services/task-runtime.js'
import { createTaskRouter } from './routes/tasks.js'
import { getLaborVectorStatus } from './services/labor-vector.js'
import { initializeLaborKb } from './services/labor-kb.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../.env.local') })

const PORT = process.env.LOCAL_SERVER_PORT || 8789

const app = express()
app.use(cors())
app.use(express.json({ limit: '12mb' }))

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'contract-rewrite-local', timestamp: new Date().toISOString() })
})

const { businessDatabase, taskService, taskFileStore, taskQueue } = createTaskRuntime()
const authService = createAuthService(businessDatabase)

// 认证接口公开；其余 API 在进入业务路由前统一校验 Bearer JWT。
app.use('/api/auth', createAuthRouter(authService))
app.use('/api', createRequireAuth(authService))
app.use('/api', createTaskRouter({ taskService, taskQueue, fileStore: taskFileStore }))
app.use('/api', contractRewriteRouter)
app.use('/api', laborConsultRouter)

const cleanupExpiredTaskData = async () => {
  try {
    const expiredFiles = taskService.listExpiredFiles()
    if (expiredFiles.length) {
      await taskFileStore.cleanupExpiredFiles(expiredFiles)
      taskService.purgeExpiredLaborSourceCheckpoints()
      taskService.removeFileRecords(expiredFiles.map((file) => file.id))
      console.log(`[tasks] cleaned ${expiredFiles.length} expired task file(s)`)
    } else {
      taskService.purgeExpiredLaborSourceCheckpoints()
    }
    const expiredThreads = taskService.listExpiredLaborThreads()
    let deletedThreads = 0
    for (const thread of expiredThreads) {
      for (const taskId of thread.taskIds) await taskFileStore.removeTaskFiles(taskId)
      const result = taskService.deleteExpiredLaborThreadTasks(thread.userId, thread.productId, thread.threadId)
      if (result.deleted) deletedThreads += 1
    }
    if (deletedThreads) console.log(`[tasks] deleted ${deletedThreads} expired task session(s)`)
  } catch (error) {
    console.warn('[tasks] expired task data cleanup failed:', error.message)
  }
}

void cleanupExpiredTaskData()
const cleanupTimer = setInterval(() => void cleanupExpiredTaskData(), 60 * 60 * 1000)
cleanupTimer.unref?.()

// 初始化知识库
async function bootstrap() {
  try {
    const queueInfo = await taskQueue.start()
    console.log(`[tasks] queue started in ${queueInfo.mode} mode (concurrency=${queueInfo.concurrency}, worker=${taskQueue.workerEnabled ? 'on' : 'off'})`)
  } catch (error) {
    console.warn('[tasks] queue startup failed; task creation may be unavailable:', error.message)
  }
  try {
    initialize()
    const count = await loadTemplates()
    console.log(`[server] Knowledge base ready with ${count} templates`)
  } catch (error) {
    console.warn('[server] Knowledge base initialization skipped:', error.message)
    console.warn('[server] Run "npm run import:templates" to import contract templates.')
  }

  // 用工咨询：法规白名单 + 典型案例库（幂等，已存在则跳过）
  try {
    const labor = bootstrapLaborKnowledge()
    console.log(`[server] Labor knowledge ready (laws seeded: ${labor.inserted}, existing: ${labor.skipped})`)
  } catch (error) {
    console.warn('[server] Labor knowledge initialization skipped:', error.message)
  }

  // 启动时检查实务库向量索引，避免运行中才发现语义检索降级。
  try {
    // labor_kb_entries 由 initializeLaborKb 创建，必须先建表再读取向量状态。
    initializeLaborKb()
    const vector = getLaborVectorStatus()
    const pct = (vector.coverage * 100).toFixed(1)
    console.log(`[server] Labor vector index: ${vector.embedded}/${vector.entries} (${pct}%) `
      + `model=${vector.model} dim=${vector.dimension} ready=${vector.ready}`)
    if (vector.modelMismatch) {
      console.warn('[server] ⚠️ 用工向量索引模型不一致：库内为 '
        + `${vector.storedModels.map((item) => `${item.model}(${item.count})`).join('、')}，当前配置为 ${vector.model}`)
      console.warn('[server] ⚠️ 语义召回将降级为纯词法。修复：npm run build:labor-embeddings')
    } else if (!vector.ready) {
      console.warn('[server] ⚠️ 用工向量索引为空，语义召回将降级为纯词法。修复：npm run build:labor-embeddings')
    }
  } catch (error) {
    console.warn('[server] Labor vector index status unavailable:', error.message)
  }

  const server = app.listen(PORT, () => {
    console.log(`[server] Contract rewrite local engine listening on http://localhost:${PORT}`)
    console.log(`[server] API endpoint: POST http://localhost:${PORT}/api/contract-rewrite`)
    console.log(`[server] Task API endpoint: POST http://localhost:${PORT}/api/tasks/contract-review`)
    console.log(`[server] API endpoint: POST http://localhost:${PORT}/api/labor-consult`)
  })

  server.on('close', async () => {
    clearInterval(cleanupTimer)
    await taskQueue.close().catch(() => {})
    businessDatabase.close()
  })

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] Port ${PORT} is already in use.`)
      console.error(`[server] Run "lsof -nP -iTCP:${PORT} -sTCP:LISTEN" to find the process.`)
      process.exit(1)
    }
    console.error('[server] Failed to start:', error)
    process.exit(1)
  })
}

bootstrap()
