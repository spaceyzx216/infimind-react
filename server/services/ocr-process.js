import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// OCR's native/worker errors must not terminate the HTTP/queue process. The
// current OCR implementation runs unchanged in a bounded child process.
const run = promisify(execFile)
const worker = fileURLToPath(new URL('./ocr-worker.js', import.meta.url))
export const ocrCacheDirectory = join(tmpdir(), 'fafee-handbook-ocr-cache')
export async function recognizeIsolatedImage(file, { signal } = {}) {
  signal?.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'fafee-handbook-image-'))
  try {
    await mkdir(ocrCacheDirectory, { recursive: true })
    const source = join(directory, 'image'), result = join(directory, 'result.json')
    await writeFile(source, file.buffer)
    try {
      await run(process.execPath, ['--use-env-proxy', worker, source, result, file.originalname || '图片.png'], {
        cwd: ocrCacheDirectory, signal, timeout: 120000, maxBuffer: 128 * 1024, windowsHide: true })
    } catch {
      signal?.throwIfAborted()
      throw new Error('OCR读取未完成，请检查语言资源与图片，或仅检查已读取部分。')
    }
    signal?.throwIfAborted()
    return JSON.parse(await readFile(result, 'utf8'))
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
}
