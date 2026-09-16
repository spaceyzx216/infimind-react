import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import contractRewriteRouter from './routes/contract-rewrite.js'
import { createAuthRouter } from './routes/auth.js'
import { createRequireAuth } from './middleware/auth.js'
import { createBusinessDatabase } from './services/business-db.js'
import { createAuthService } from './services/auth-service.js'
import { initialize, loadTemplates } from './services/knowledge-base.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../.env.local') })

const PORT = process.env.LOCAL_SERVER_PORT || 8789

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'contract-rewrite-local', timestamp: new Date().toISOString() })
})

const businessDatabase = createBusinessDatabase()
const authService = createAuthService(businessDatabase)

// 认证接口公开；其余 API 在进入业务路由前统一校验 Bearer JWT。
app.use('/api/auth', createAuthRouter(authService))
app.use('/api', createRequireAuth(authService))
app.use('/api', contractRewriteRouter)

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

  const server = app.listen(PORT, () => {
    console.log(`[server] Contract rewrite local engine listening on http://localhost:${PORT}`)
    console.log(`[server] API endpoint: POST http://localhost:${PORT}/api/contract-rewrite`)
  })

  server.on('close', () => businessDatabase.close())

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
