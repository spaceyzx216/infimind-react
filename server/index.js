import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import contractRewriteRouter from './routes/contract-rewrite.js'
import laborConsultRouter, { bootstrapLaborKnowledge } from './routes/labor-consult.js'
import { initialize, loadTemplates } from './services/knowledge-base.js'
import { getLaborVectorStatus } from './services/labor-vector.js'
import { initializeLaborKb } from './services/labor-kb.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../.env.local') })

const PORT = process.env.LOCAL_SERVER_PORT || 8789

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// 路由
app.use('/api', contractRewriteRouter)
app.use('/api', laborConsultRouter)

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'contract-rewrite-local', timestamp: new Date().toISOString() })
})

// 初始化知识库
async function bootstrap() {
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

  // 向量索引状态：启动即暴露，避免"跑起来才发现语义召回一直在降级"
  try {
    // ⚠️ 顺序有依赖：getLaborVectorStatus() 要查 labor_kb_entries，
    // 而该表由 initializeLaborKb() 创建——initializeLaborVector() 只建 embeddings 表
    // （其外键指向 labor_kb_entries，SQLite 允许前向引用所以建得成功）。
    // 全新环境下不先建表会抛 "no such table: labor_kb_entries"，
    // 让这段启动诊断在最需要它的场景里静默失效。
    initializeLaborKb()
    const vector = getLaborVectorStatus()
    const pct = (vector.coverage * 100).toFixed(1)
    console.log(`[server] Labor vector index: ${vector.embedded}/${vector.entries} (${pct}%) `
      + `model=${vector.model} dim=${vector.dimension} ready=${vector.ready}`)
    if (vector.modelMismatch) {
      console.warn('[server] ⚠️ 向量索引模型不一致：库内为 '
        + `${vector.storedModels.map((item) => `${item.model}(${item.count})`).join('、')}，当前配置为 ${vector.model}`)
      console.warn('[server] ⚠️ 语义召回将降级为纯词法。修复：npm run build:labor-embeddings')
    } else if (!vector.ready) {
      console.warn('[server] ⚠️ 向量索引为空，语义召回将降级为纯词法。修复：npm run build:labor-embeddings')
    }
  } catch (error) {
    console.warn('[server] Labor vector index status unavailable:', error.message)
  }

  const server = app.listen(PORT, () => {
    console.log(`[server] Contract rewrite local engine listening on http://localhost:${PORT}`)
    console.log(`[server] API endpoint: POST http://localhost:${PORT}/api/contract-rewrite`)
    console.log(`[server] API endpoint: POST http://localhost:${PORT}/api/labor-consult`)
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
