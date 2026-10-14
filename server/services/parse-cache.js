// 同一进程内按“文件内容指纹 + 解析器版本 + 目标扩展名”复用**原始解析**结果，让分类接口与
// 任务材料准备对同一份上传文件只做一次昂贵解析（ZIP / LibreOffice / OCR）。
//
// 设计约束：
// - 只缓存 extractRawText 的原始产物，命中后仍会重新执行 finalizeDocument，
//   所以块编号、fileName、fileId 与解析器版本始终按当前请求生成，不会串用旧文件名。
// - 只在显式 opt-in 的调用点生效（分类接口、任务材料准备），其它解析路径行为不变。
// - 只存内存、不落盘、不跨进程：API 与独立 Worker 分开部署时各自仍会解析一次。
// - 相同字节会得到相同文本，缓存不引入新的数据可见性；条目 5 分钟后过期并受 LRU 预算限制。
const MAX_ENTRIES = 16
const MAX_TOTAL_CHARS = 4_000_000
const MAX_ENTRY_CHARS = 2_000_000
const MAX_AGE_MS = 5 * 60 * 1000

const entries = new Map()
let totalChars = 0

const measuredChars = (raw) => raw.text.length
  + (Array.isArray(raw.metadata?.pages) ? raw.metadata.pages.reduce((sum, page) => sum + String(page?.text || '').length, 0) : 0)

const evict = (now) => {
  for (const [key, entry] of entries) {
    if (now - entry.storedAt > MAX_AGE_MS) {
      entries.delete(key)
      totalChars -= entry.chars
    }
  }
  while (entries.size > MAX_ENTRIES || totalChars > MAX_TOTAL_CHARS) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    totalChars -= entries.get(oldest).chars
    entries.delete(oldest)
  }
}

export function readCachedParse(key) {
  if (!key) return null
  const entry = entries.get(key)
  if (!entry) return null
  if (Date.now() - entry.storedAt > MAX_AGE_MS) {
    entries.delete(key)
    totalChars -= entry.chars
    return null
  }
  // 命中即刷新 LRU 位置。
  entries.delete(key)
  entries.set(key, entry)
  return entry.raw
}

export function writeCachedParse(key, raw) {
  if (!key || !raw || typeof raw.text !== 'string' || !raw.text) return false
  const chars = measuredChars(raw)
  if (chars > MAX_ENTRY_CHARS) return false
  if (entries.has(key)) totalChars -= entries.get(key).chars
  entries.set(key, { raw, chars, storedAt: Date.now() })
  totalChars += chars
  evict(Date.now())
  return true
}

export function clearParseCache() {
  entries.clear()
  totalChars = 0
}

export function parseCacheStats() {
  return { entries: entries.size, totalChars }
}
