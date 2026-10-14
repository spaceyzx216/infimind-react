import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskRouter } from '../routes/tasks.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskService } from '../services/task-service.js'
import { createTaskFileStore } from '../services/task-file-store.js'

// Exercise the real multipart route with the fields sent by the browser.
// No worker or model runs; business data stays in memory and files in tmpdir.
const database = createBusinessDatabase(':memory:')
const service = createTaskService(database)
const directory = mkdtempSync(join(tmpdir(), 'fafee-arbitration-upload-'))
const store = createTaskFileStore({ root: directory })
const now = new Date().toISOString()
database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)').run('upload-invite', 'synthetic-hash', now)
database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('upload-user', 'synthetic', 'upload@example.invalid', 'synthetic', 'synthetic', 'upload-invite', now)

const enqueued = []
const app = express()
app.use((req, res, next) => { req.user = { id: 'upload-user' }; next() })
app.use('/api', createTaskRouter({ taskService: service, fileStore: store,
  taskQueue: { enqueue: async (id) => { enqueued.push(id) } }, fakeLlm: true }))
const server = await new Promise((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
})
const endpoint = `http://127.0.0.1:${server.address().port}/api/tasks/labor-arbitration`
const browserForm = (threadId, temporary) => {
  const form = new FormData()
  form.append('threadId', threadId)
  form.append('action', 'analyze')
  form.append('message', '请核对虚构案件材料。')
  form.append('mode', 'fast')
  form.append('temporary', String(temporary))
  form.append('history', '[]')
  form.append('historyDroppedMessages', '0')
  form.append('title', '虚构案件')
  form.append('files', new Blob(['虚构申请书：申请人主张工资差额800元。'], { type: 'text/plain' }), 'synthetic.txt')
  return form
}

try {
  for (const temporary of [false, true]) {
    const threadId = `browser-upload-${temporary}`
    const response = await fetch(endpoint, { method: 'POST', body: browserForm(threadId, temporary) })
    const payload = await response.json()
    assert.equal(response.status, 202, JSON.stringify(payload))
    const task = service.getTaskInternal(payload.taskId)
    assert.equal(task.threadId, threadId)
    assert.equal(service.getTaskInput(task.id).temporary, temporary)
    assert.equal(task.files.length, 1)
    assert.ok(enqueued.includes(task.id))
  }

  const excessive = browserForm('excessive-fields', false)
  excessive.append('unexpectedExtra', 'synthetic')
  const rejected = await fetch(endpoint, { method: 'POST', body: excessive })
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).code, 'LIMIT_FIELD_COUNT')
  assert.equal(service.listThreadTasks('upload-user', 'labor-arbitration', 'excessive-fields').length, 0)
  assert.equal(enqueued.length, 2)
  console.log('PASS arbitration upload: all eight browser fields accepted for ordinary/temporary chats; excessive fields rejected before task creation (synthetic only)')
} finally {
  await new Promise((resolve) => server.close(resolve))
  database.close()
}
