/**
 * 用工咨询的「会话材料」存储。
 *
 * 解决的问题：附件正文此前只存在于**上传的那一轮**。用户传了劳动合同、第二轮追问
 * 「那这种情况怎么办」时，模型已经看不到那份合同了——对法律咨询工具是硬伤。
 *
 * 为什么存服务端而不是塞进对话历史：
 *   - 正文可达数万字，放进 history 会随每轮请求重复上传；
 *   - 前端会话是整体写入 localStorage 的，塞进去会迅速吃满配额，
 *     而 writeStorage 的 catch 是静默的——一旦超限整个历史都会停止保存。
 *
 * 生命周期策略与 review-session-store.js 保持一致（TTL + 总量 + 单会话上限）。
 * 注意：整套 API 无鉴权（本地引擎），这里按客户端生成的会话 id 归档，
 * 仅做格式校验以防异常键值，不构成访问控制。
 */
const TTL_MS = 2 * 60 * 60 * 1000
const MAX_CONVERSATIONS = 200
/** 单会话材料正文总量上限。与注入上限一致——存超过注入量的部分是纯浪费 */
export const MAX_TOTAL_TEXT = 40000

/** 客户端生成的会话 id：labor-<时间戳>-<随机串>，限制字符集与长度以防异常键 */
const normalizeConversationId = (value) => {
  const id = typeof value === 'string' ? value.trim() : ''
  return /^[a-zA-Z0-9_-]{8,64}$/.test(id) ? id : ''
}

/** conversationId -> { materials: [{name, text}], updatedAt } */
const conversations = new Map()

function prune() {
  const expiresBefore = Date.now() - TTL_MS
  for (const [id, item] of conversations) if (item.updatedAt < expiresBefore) conversations.delete(id)
  // Map 保持插入顺序，最早插入的即最久未更新
  while (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value)
}

/**
 * 把本轮解析出的材料并入会话材料集，返回**合并后**的完整材料（已按总量上限裁剪）。
 *
 * 同名材料视为更新（用户重新上传了同一份文件的修订版），而不是追加重复项。
 * 返回合并结果而非仅本轮，是为了让追问轮也能拿到前几轮上传的材料。
 *
 * @param {string} conversationId 客户端生成的会话 id
 * @param {Array<{name:string, text:string}>} materials 本轮解析出的材料
 * @returns {{ materials: Array<{name:string, text:string}>, truncated: boolean }}
 */
export function mergeMaterials(conversationId, materials = []) {
  const id = normalizeConversationId(conversationId)
  const incoming = (Array.isArray(materials) ? materials : [])
    .filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .map((item) => ({ name: String(item.name || '未命名材料'), text: item.text }))

  // 无有效会话 id 时退化为"仅本轮"，不落存储——避免把材料挂到一个无法再取回的键上
  if (!id) return { materials: capTotal(incoming), truncated: totalOf(incoming) > MAX_TOTAL_TEXT }

  prune()
  const existing = conversations.get(id)?.materials || []
  const merged = existing.slice()
  for (const item of incoming) {
    const at = merged.findIndex((prev) => prev.name === item.name)
    if (at >= 0) merged[at] = item
    else merged.push(item)
  }

  const capped = capTotal(merged)
  const truncated = totalOf(merged) > MAX_TOTAL_TEXT
  conversations.set(id, { materials: capped, updatedAt: Date.now() })
  return { materials: capped, truncated }
}

/** 只读：取某会话已归档的材料（用于不带附件的追问轮）。 */
export function getMaterials(conversationId) {
  const id = normalizeConversationId(conversationId)
  if (!id) return []
  prune()
  const item = conversations.get(id)
  if (!item) return []
  // 读到即算活跃，延长该会话材料的存活时间
  item.updatedAt = Date.now()
  return item.materials
}

/** 用户删除会话时调用，避免材料在 TTL 内继续占用内存。 */
export function clearMaterials(conversationId) {
  const id = normalizeConversationId(conversationId)
  if (id) conversations.delete(id)
}

const totalOf = (materials) => materials.reduce((sum, item) => sum + item.text.length, 0)

/** 超总量时按比例裁剪，保留每份材料的开头（与单轮附件截断语义一致）。 */
function capTotal(materials) {
  const total = totalOf(materials)
  if (total <= MAX_TOTAL_TEXT) return materials
  const ratio = MAX_TOTAL_TEXT / total
  return materials.map((item) => ({ ...item, text: item.text.slice(0, Math.floor(item.text.length * ratio)) }))
}

export const getMaterialStoreStatus = () => ({ conversations: conversations.size, maxTotalText: MAX_TOTAL_TEXT })
