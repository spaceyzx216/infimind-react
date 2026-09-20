import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 合同原文默认放在操作系统临时目录，避免把敏感材料写入仓库或知识库目录；
// 部署时可通过 TASK_UPLOAD_ROOT 指定受控的私有挂载点。
const DEFAULT_ROOT = resolve(tmpdir(), 'fafee-task-files')

const safeExtension = (name = '') => {
  const extension = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin'
}

const assertWithinRoot = (root, target) => {
  const relativePath = relative(root, target)
  if (relativePath.startsWith('..') || relativePath.includes(':') || relativePath.includes('\\..')) {
    throw new Error('任务文件路径越界')
  }
  return target
}

export function createTaskFileStore({ root = process.env.TASK_UPLOAD_ROOT || DEFAULT_ROOT } = {}) {
  const storageRoot = resolve(root)

  const taskDirectory = (taskId) => assertWithinRoot(storageRoot, resolve(storageRoot, String(taskId)))

  const saveIncomingFiles = async (taskId, files = []) => {
    const directory = taskDirectory(taskId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const saved = []
    try {
      for (const file of files) {
        const filename = `${cryptoRandomId()}${safeExtension(file.originalname)}`
        const target = assertWithinRoot(directory, resolve(directory, filename))
        await writeFile(target, file.buffer, { mode: 0o600 })
        saved.push({
          originalName: basename(file.originalname || '合同文件'),
          size: Number(file.size) || file.buffer?.length || 0,
          mimeType: file.mimetype || 'application/octet-stream',
          storagePath: target
        })
      }
      return saved
    } catch (error) {
      await removeTaskFiles(taskId)
      throw error
    }
  }

  const readFiles = async (files = []) => Promise.all(files.map(async (file) => ({
    ...file,
    // file-parser 使用 Multer 的字段名；这里把持久化字段恢复成同一接口。
    originalname: file.originalname || file.originalName,
    mimetype: file.mimetype || file.mimeType,
    buffer: await readFile(assertWithinRoot(storageRoot, resolve(file.storagePath)))
  })))

  const removeTaskFiles = async (taskId) => {
    const directory = taskDirectory(taskId)
    await rm(directory, { recursive: true, force: true })
  }

  const cleanupExpiredFiles = async (files = []) => {
    const grouped = new Set()
    for (const file of files) {
      const target = assertWithinRoot(storageRoot, resolve(file.storagePath))
      await rm(target, { force: true })
      grouped.add(resolve(target, '..'))
    }
    for (const directory of grouped) {
      await rm(directory, { recursive: true, force: true })
    }
    return files.length
  }

  return {
    root: storageRoot,
    saveIncomingFiles,
    readFiles,
    removeTaskFiles,
    cleanupExpiredFiles
  }
}

const cryptoRandomId = () => {
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues?.(bytes)
  if (bytes.some((value) => value !== 0)) return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export { DEFAULT_ROOT }
