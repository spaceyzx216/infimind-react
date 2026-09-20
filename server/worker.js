import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskRuntime } from './services/task-runtime.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../.env.local') })

const runtime = createTaskRuntime({ workerEnabled: true })
let stopping = false

const shutdown = async (signal, exitCode = 0) => {
  if (stopping) return
  stopping = true
  console.log(`[tasks] ${signal} received; stopping worker`)
  await runtime.taskQueue.close().catch((error) => console.warn('[tasks] worker close failed:', error.message))
  runtime.businessDatabase.close()
  process.exit(exitCode)
}
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })

try {
  const info = await runtime.taskQueue.start()
  console.log(`[tasks] standalone worker started in ${info.mode} mode (concurrency=${info.concurrency})`)
} catch (error) {
  console.error('[tasks] standalone worker failed to start:', error.message)
  await shutdown('startup_error', 1)
}
