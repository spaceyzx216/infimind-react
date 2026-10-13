import express from 'express'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskService } from '../services/task-service.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskQueue } from '../services/task-queue.js'
import { createTaskProcessor } from '../services/task-processor.js'
import { createTaskRouter } from '../routes/tasks.js'
import { runHandbookDiagnosis } from '../workflows/handbook-diagnosis.js'
import { initialize, close as closeLaws } from '../services/law-whitelist.js'

// Loopback-only engineering fixture: synthetic identity/model, real task routes,
// database, parsing, worker and event replay. No production DB, keys or materials.
initialize(':memory:')
const database = createBusinessDatabase(':memory:')
database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)').run('invite-ui', 'hash-ui', new Date().toISOString())
database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('handbook-ui', '合成测试用户', 'handbook-ui@example.test', 'hash', 'salt', 'invite-ui', new Date().toISOString())
const service = createTaskService(database)
const directory = mkdtempSync(join(tmpdir(), 'fafee-handbook-ui-'))
const fileStore = createTaskFileStore({ root: directory })
const processor = createTaskProcessor({ taskService: service, fileStore, fakeLlm: true,
  handbookWorkflow: (options) => runHandbookDiagnosis({ ...options,
    referenceLoader: async () => ({ documents: [], versions: [], warnings: ['本次为合成材料工程测试，不代表法律验收。'] }), lawLoader: async () => [],
    emit: async (...args) => { await new Promise((resolve) => setTimeout(resolve, args[1]?.stage === 'followup' ? 1000 : 60)); return options.emit(...args) } }) })
const queue = createTaskQueue({ taskService: service, processTask: processor.processTask, mode: 'local', workerEnabled: true, pollIntervalMs: 20 })
const app = express(); app.use(express.json())
const user = { id: 'handbook-ui', username: '合成测试用户', email: 'handbook-ui@example.test', role: 'user' }
app.post('/api/auth/refresh', (_req, res) => res.json({ accessToken: 'handbook-ui-token', accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), user }))
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.use((req, _res, next) => { req.user = user; next() })
app.use('/api', createTaskRouter({ taskService: service, taskQueue: queue, fileStore, fakeLlm: true }))
await queue.start()
const port = Number(process.env.HANDBOOK_TEST_PORT) || 18798
const server = app.listen(port, '127.0.0.1', () => console.log(`Handbook isolated test API: http://127.0.0.1:${port}; files: ${directory}`))
const stop = async () => { await queue.close(); server.close(() => { database.close(); closeLaws(); process.exit(0) }) }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
