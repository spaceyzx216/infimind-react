// DeepSeek Flash 当前上下文容量；发送前只能估算，响应后使用 API usage 校正。
export const CONTEXT_WINDOW_TOKENS = 1_048_576
export const MAX_MODEL_OUTPUT_TOKENS = 393_216
export const OUTPUT_RESERVE_TOKENS = MAX_MODEL_OUTPUT_TOKENS
export const CONTEXT_SAFETY_TOKENS = 8_192

export function estimateTokens(value) {
  const text = String(value || '')
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length
  return Math.ceil(ascii / 4 + [...text].length - ascii)
}

// 保留最近的完整用户轮次，不按轮数或字符数截断，也不截断一条消息。
export function selectHistoryByTokens(value, budget) {
  const available = Number.isFinite(budget) ? Math.max(0, budget) : 0
  const messages = (Array.isArray(value) ? value : []).filter((item) =>
    item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && item.content.trim())
    .map(({ role, content }) => ({ role, content }))
  const turns = []
  for (const message of messages) {
    if (message.role === 'user' || !turns.length) turns.push([])
    turns[turns.length - 1].push(message)
  }
  let tokens = 0
  let first = turns.length
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const cost = turns[index].reduce((sum, item) => sum + estimateTokens(item.content) + 16, 0)
    if (tokens + cost > available) break
    tokens += cost
    first = index
  }
  const history = turns.slice(first).flat()
  return { history, tokens, droppedMessages: messages.length - history.length }
}

export function selectConversationHistory(value, { question = '', mandatoryText = '' } = {}) {
  // Leave room for the tool's system prompt, evidence and pending materials;
  // the server repeats the check with the actual assembled input.
  return selectHistoryByTokens(value, CONTEXT_WINDOW_TOKENS - OUTPUT_RESERVE_TOKENS - CONTEXT_SAFETY_TOKENS
    - 100000 - estimateTokens(question) - estimateTokens(mandatoryText))
}
