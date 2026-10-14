import { Router } from 'express'
import { renderOcrRegion } from '../services/ocr-region-image.js'

export function createMaterialRouter({ taskService, fileStore }) {
  const router = Router()
  function resolve(req, res) {
    if (!req.user?.id) { res.status(401).json({ error: '请先登录' }); return null }
    const task = taskService.getTask(req.params.taskId, req.user.id, false)
    if (!task) { res.status(404).json({ error: '材料不存在或无权访问' }); return null }
    if (new Date(task.resultExpiresAt).getTime() <= Date.now()) { res.status(410).json({ error: '材料正文已到保存期限' }); return null }
    const document = taskService.getCheckpoint(task.id, 'material-source')?.result?.documents?.find((d) => d.fileId === req.params.fileId)
    if (!document) { res.status(404).json({ error: '此任务没有可核对的材料记录' }); return null }
    res.set('Cache-Control', 'private, no-store')
    return { task, document }
  }
  router.get('/tasks/:taskId/materials', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: '请先登录' })
    const task = taskService.getTask(req.params.taskId, req.user.id, false)
    if (!task) return res.status(404).json({ error: '材料不存在或无权访问' })
    if (new Date(task.resultExpiresAt).getTime() <= Date.now()) return res.status(410).json({ error: '材料正文已到保存期限' })
    const source = taskService.getCheckpoint(task.id, 'material-source')?.result
    const coverage = taskService.getCheckpoint(task.id, 'material-coverage')?.result || null
    res.set('Cache-Control', 'private, no-store')
    return res.json({ documents: (source?.documents || []).map((d) => ({ fileId: d.fileId, fileName: d.fileName,
      parserVersion: d.parseMetadata?.parserVersion, completeness: d.parseMetadata?.completeness, warnings: d.parseMetadata?.warnings || [],
      ocrRegionCount: d.parseMetadata?.ocrRegions?.length || 0 })), failures: source?.failures || [], coverage })
  })
  router.get('/tasks/:taskId/materials/:fileId', (req, res) => {
    const value = resolve(req, res)
    if (!value) return
    const { fileId, fileName, text, parseMetadata } = value.document
    // No storage paths, ZIP paths or image relationship descriptors leave the server.
    const regions = (parseMetadata?.ocrRegions || []).map((r) => ({ id: r.id, text: r.text, reason: r.reason, confidence: r.confidence, bbox: r.bbox, candidates: r.candidates, location: r.origin?.label || (r.origin?.page ? `第${r.origin.page}页` : '') }))
    return res.json({ fileId, fileName, text, warnings: parseMetadata?.warnings || [], regions })
  })
  router.get('/tasks/:taskId/materials/:fileId/regions/:regionId', async (req, res) => {
    const value = resolve(req, res)
    if (!value) return
    const region = value.document.parseMetadata?.ocrRegions?.find((r) => r.id === req.params.regionId)
    const sourceTaskId = value.document.sourceTaskId || value.task.id
    const sourceTask = sourceTaskId === value.task.id ? value.task : taskService.getTask(sourceTaskId, req.user.id, false)
    if (!sourceTask || sourceTask.productId !== value.task.productId || (sourceTask.threadId || sourceTask.id) !== (value.task.threadId || value.task.id)) return res.status(404).json({ error: '原图不存在或无权访问' })
    const file = taskService.getFiles(sourceTaskId).find((f) => f.id === req.params.fileId)
    if (!region || !file) return res.status(404).json({ error: '核对区域不存在' })
    if (new Date(file.cleanupAt).getTime() <= Date.now()) return res.status(410).json({ error: '原件已到保存期限，无法查看原图' })
    try {
      const [original] = await fileStore.readFiles([file])
      const buffer = await renderOcrRegion(original, region)
      return res.type('png').send(buffer)
    } catch { return res.status(410).json({ error: '原图不可读取，请核对本地原件或重新上传' }) }
  })
  return router
}
