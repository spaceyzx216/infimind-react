import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { extractText } from './file-parser.js'
import { buildHandbookStructure, fingerprint, rankHandbookChunks } from './handbook-structure.js'

// Server-owned, external manifest. Never import private handbooks into the repo or
// use a client-supplied path. All versions remain comparison references.
export async function loadHandbookReferences({ manifestPath = process.env.HANDBOOK_REFERENCE_MANIFEST, signal } = {}) {
  if (!manifestPath) return { documents: [], versions: [], warnings: ['尚未配置员工手册参考资料，本轮不使用旧手册或模板进行比较。'] }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.documents)) throw new Error('员工手册参考清单缺少 documents')
  const documents = []
  const versions = []
  for (const entry of manifest.documents) {
    signal?.throwIfAborted()
    if (!entry.id || !entry.title || !entry.version || !entry.filePath || entry.role !== 'reference') throw new Error('员工手册参考资料必须标明标识、名称、版本、路径和 reference 用途')
    const path = resolve(dirname(resolve(manifestPath)), entry.filePath)
    const buffer = await readFile(path)
    const parsed = await extractText({ buffer, originalname: path, mimetype: '' }, { signal })
    if (!parsed.text?.trim()) throw new Error('员工手册参考资料未读取到正文')
    if (parsed.metadata?.pages?.some((page) => page.error || !page.text?.trim())) throw new Error('员工手册参考资料存在未读取页面')
    const version = { id: entry.id, title: entry.title, version: entry.version, role: 'reference', contentHash: fingerprint(buffer.toString('base64')) }
    versions.push(version)
    documents.push({ fileId: `reference:${entry.id}`, fileName: entry.title, text: parsed.text, referenceVersion: version })
  }
  return { documents, versions, warnings: [] }
}

export function retrieveHandbookReferences(chunk, referenceDocuments = []) {
  const candidates = buildHandbookStructure(referenceDocuments).chunks
  return rankHandbookChunks(chunk.text, candidates).filter(({ score }) => score > 0).slice(0, 2)
    .map(({ chunk: item }) => ({ title: item.fileName, role: 'reference', version: referenceDocuments.find((doc) => doc.fileId === item.fileId)?.referenceVersion?.version || '', text: item.text }))
}
