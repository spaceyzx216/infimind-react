import { estimateTokens, CONTEXT_WINDOW_TOKENS, CONTEXT_SAFETY_TOKENS, MAX_MODEL_OUTPUT_TOKENS, selectHistoryByTokens } from '../../src/utils/context-budget.js'
import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env.local') })

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
// V4.1 Flash is shared by both product modes. The mode controls thinking,
// not the model id; legacy private .env.local values are intentionally ignored.
const DEEPSEEK_MODEL = 'deepseek-flash'
const DEEPSEEK_FLASH_MODEL = DEEPSEEK_MODEL
const REQUEST_TIMEOUT_MS = 60_000
const STREAM_IDLE_TIMEOUT_MS = 60_000

if (!DEEPSEEK_API_KEY) {
  console.warn('[llm-client] Missing DEEPSEEK_API_KEY environment variable.')
}

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${DEEPSEEK_API_KEY}`
  }
}

/**
 * 查询当前配置的 DeepSeek API Key 所属账户余额。
 * 该请求只能由服务端发起，浏览器永远不会读取 API Key。
 */
export async function getUserBalance() {
  if (!DEEPSEEK_API_KEY) throw new Error('尚未配置 DeepSeek API Key')

  const endpoint = `${DEEPSEEK_BASE_URL.replace(/\/$/, '')}/user/balance`
  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    }
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || `余额查询失败（${response.status}）`)

  return {
    isAvailable: Boolean(payload?.is_available),
    balances: Array.isArray(payload?.balance_infos) ? payload.balance_infos.map((item) => ({
      currency: item?.currency === 'USD' ? 'USD' : 'CNY',
      total: String(item?.total_balance ?? '0'),
      granted: String(item?.granted_balance ?? '0'),
      toppedUp: String(item?.topped_up_balance ?? '0')
    })) : []
  }
}

function resolveThinkingOptions(_model, thinking, reasoningEffort) {
  const type = thinking?.type === 'disabled' ? 'disabled' : 'enabled'
  return {
    thinking: { type },
    ...(type === 'enabled' ? { reasoning_effort: reasoningEffort || 'high' } : {})
  }
}

function describeError(error) {
  const name = error?.name && error.name !== 'Error' ? `${error.name}: ` : ''
  const message = error?.message || String(error)
  const causeCode = error?.cause?.code ? `, cause=${error.cause.code}` : ''
  const causeMessage = error?.cause?.message && error.cause.message !== message
    ? `, causeMessage=${error.cause.message}`
    : ''
  return `${name}${message}${causeCode}${causeMessage}`
}

function createLlmError(message, { code = 'LLM_REQUEST_FAILED', retryable = true, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.retryable = retryable
  return error
}

function abortRequest(controller) {
  if (controller && !controller.signal.aborted) controller.abort()
}

function readWithTimeout(reader, controller, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }

    timer = setTimeout(() => {
      const error = createLlmError(`流式响应 ${timeoutMs}ms 内没有新数据`, {
        code: 'LLM_STREAM_TIMEOUT',
        retryable: true
      })
      finish(reject, error)
      abortRequest(controller)
      void reader.cancel().catch(() => {})
    }, timeoutMs)

    reader.read().then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    )
  })
}

async function deepseekFetch(path, body, retries = 3, externalSignal, requestTimeoutMs) {
  const url = `${DEEPSEEK_BASE_URL}${path}`

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) {
      throw createLlmError('DeepSeek 请求已取消', { code: 'LLM_REQUEST_ABORTED', retryable: false })
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      abortRequest(controller)
    }, requestTimeoutMs || REQUEST_TIMEOUT_MS)
    const abortExternal = () => abortRequest(controller)
    const cleanupExternal = () => externalSignal?.removeEventListener('abort', abortExternal)
    externalSignal?.addEventListener('abort', abortExternal, { once: true })

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (response.status === 429) {
        clearTimeout(timeout)
        cleanupExternal()
        abortRequest(controller)
        if (attempt === retries) throw createLlmError('模型请求限流（429）', { code: 'LLM_HTTP_429', retryable: true })
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 30000)
        console.warn(`[llm-client] Rate limited. Retrying in ${waitMs}ms (attempt ${attempt}/${retries})`)
        await new Promise((r) => setTimeout(r, waitMs))
        if (externalSignal?.aborted) {
          throw createLlmError('DeepSeek 请求已取消', { code: 'LLM_REQUEST_ABORTED', retryable: false })
        }
        continue
      }

      if (response.status === 400) {
        const err = await response.json().catch(() => ({}))
        throw createLlmError(`Bad request: ${JSON.stringify(err)}`, {
          code: 'LLM_BAD_REQUEST',
          retryable: false
        })
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error')
        throw createLlmError(`API error ${response.status}: ${errText}`, {
          code: `LLM_HTTP_${response.status}`,
          retryable: response.status >= 500
        })
      }

      clearTimeout(timeout)
      return { response, controller, cleanup: cleanupExternal }
    } catch (err) {
      clearTimeout(timeout)
      cleanupExternal()
      abortRequest(controller)
      if (externalSignal?.aborted) {
        throw createLlmError('DeepSeek 请求已取消', {
          code: 'LLM_REQUEST_ABORTED',
          retryable: false,
          cause: err
        })
      }
      const detail = describeError(err)
      if (attempt === retries || err?.retryable === false) {
        throw createLlmError(`DeepSeek 请求失败（${attempt}/${retries}）：${detail}`, {
          code: err?.code || 'LLM_REQUEST_FAILED',
          retryable: err?.retryable !== false,
          cause: err
        })
      }
      const waitMs = 1000 * attempt
      console.warn(`[llm-client] Request failed: ${detail}. Retrying in ${waitMs}ms (attempt ${attempt}/${retries})`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }

  throw new Error('Unreachable')
}

/**
 * 非流式调用 DeepSeek Chat，并保留完成原因与用量供结构化任务校验。
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} options
 * @returns {Promise<{content: string, finishReason: string|null, usage: object|null, empty: boolean}>}
 */
export async function chatDetailed(systemPrompt, userMessage, options = {}) {
  const {
    model = DEEPSEEK_MODEL,
    temperature = 0.3,
    maxTokens = MAX_MODEL_OUTPUT_TOKENS,
    thinking,
    reasoningEffort,
    signal,
    responseFormat,
    maxAttempts = 3,
    requestTimeoutMs
  } = options

  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({ role: 'user', content: normalizeMessageContent(userMessage) })

  if (messages.reduce((n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + 16, 0) + maxTokens + CONTEXT_SAFETY_TOKENS > CONTEXT_WINDOW_TOKENS) throw Object.assign(new Error('本阶段材料超过模型上下文预算，已完成读取记录保留；请拆分任务。'), { code: 'material_context_overflow', retryable: false })
  const requestBody = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...resolveThinkingOptions(model, thinking, reasoningEffort)
  }
  if (responseFormat?.type === 'json_object') requestBody.response_format = responseFormat

  const requestStarted = Date.now()
  const { response, controller, cleanup } = await deepseekFetch('/chat/completions', requestBody, maxAttempts, signal, requestTimeoutMs)
  const deadline = requestTimeoutMs ? setTimeout(() => abortRequest(controller), Math.max(1, requestTimeoutMs - (Date.now() - requestStarted))) : null

  try {
    const data = await response.json()
    const choice = data?.choices?.[0]
    const rawContent = choice?.message?.content
    const content = typeof rawContent === 'string' ? rawContent : ''
    const usage = data?.usage && typeof data.usage === 'object' ? data.usage : null

    if (usage) {
      console.log(
        `[llm-client] Tokens: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}`
      )
    }

    return {
      content,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      usage,
      empty: !content.trim()
    }
  } finally {
    if (deadline) clearTimeout(deadline)
    abortRequest(controller)
    cleanup?.()
  }
}

function normalizeMessageContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return String(value ?? '')
  const parts = value.filter((part) => {
    if (part?.type === 'text') return typeof part.text === 'string'
    if (part?.type !== 'image_url') return false
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
    return typeof url === 'string' && /^(data:image\/(?:jpeg|png|gif|webp);base64,|https:\/\/)/i.test(url)
  })
  return parts.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url })
}

/**
 * 兼容既有调用方：普通聊天仍只返回文本。
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} options
 * @returns {Promise<string>}
 */
export async function chat(systemPrompt, userMessage, options = {}) {
  const response = await chatDetailed(systemPrompt, userMessage, options)
  return response.content
}

/**
 * 流式调用 DeepSeek Chat，返回 AsyncGenerator
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} options
 * @returns {AsyncGenerator<{content: string, reasoning: string, finishReason: string|null}>}
 */
export async function* streamChat(systemPrompt, userMessage, options = {}) {
  const {
    model = DEEPSEEK_MODEL,
    temperature = 0.3,
    maxTokens = MAX_MODEL_OUTPUT_TOKENS,
    history = [],
    thinking,
    reasoningEffort,
    signal,
    responseFormat,
    maxAttempts = 3,
    requestTimeoutMs,
    onTransientError
  } = options

  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  if (Array.isArray(history)) {
    const questionTokens = estimateTokens(systemPrompt) + estimateTokens(typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage)) + 64
    const selected = selectHistoryByTokens(history, CONTEXT_WINDOW_TOKENS - maxTokens - CONTEXT_SAFETY_TOKENS - questionTokens)
    selected.history.forEach((message) => messages.push(message))
  }
  messages.push({ role: 'user', content: normalizeMessageContent(userMessage) })

  const inputChars = systemPrompt.length + (typeof userMessage === 'string' ? userMessage.length : JSON.stringify(userMessage).length)
  console.log(`[llm-client] Starting stream with model: ${model}, input ~${inputChars} chars`)

  if (messages.reduce((n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + 16, 0) + maxTokens + CONTEXT_SAFETY_TOKENS > CONTEXT_WINDOW_TOKENS) throw Object.assign(new Error('本阶段材料超过模型上下文预算，已完成读取记录保留；请拆分任务。'), { code: 'material_context_overflow', retryable: false })
  const requestBody = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    ...resolveThinkingOptions(model, thinking, reasoningEffort)
  }
  if (responseFormat?.type === 'json_object') requestBody.response_format = responseFormat

  const requestStarted = Date.now()
  const { response, controller, cleanup } = await deepseekFetch('/chat/completions', requestBody, maxAttempts, signal, requestTimeoutMs)
  let deadlineReached = false
  const deadline = requestTimeoutMs ? setTimeout(() => { deadlineReached = true; abortRequest(controller) }, Math.max(1, requestTimeoutMs - (Date.now() - requestStarted))) : null

  if (!response.body) {
    if (deadline) clearTimeout(deadline)
    abortRequest(controller)
    cleanup?.()
    throw createLlmError('DeepSeek 响应没有可读取的流式内容', {
      code: 'LLM_EMPTY_RESPONSE',
      retryable: false
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let totalTokens = 0
  let receivedChunks = 0

  try {
    while (true) {
      let readResult
      try {
        readResult = await readWithTimeout(reader, controller, STREAM_IDLE_TIMEOUT_MS)
      } catch (readError) {
        if (signal?.aborted) {
          throw createLlmError('流式请求已取消', { code: 'LLM_REQUEST_ABORTED', retryable: false, cause: readError })
        }
        if (deadlineReached) throw createLlmError('模型请求达到单次时间限制', { code: 'LLM_REQUEST_TIMEOUT', retryable: true, cause: readError })
        onTransientError?.(readError)
        if (readError?.code === 'LLM_STREAM_TIMEOUT') throw readError
        if (receivedChunks === 0) {
          throw createLlmError(`流读取失败（尚未收到任何数据，可能是输入过大或 API 拒绝请求）: ${describeError(readError)}`, {
            code: 'LLM_STREAM_READ_FAILED',
            retryable: true,
            cause: readError
          })
        }
        throw createLlmError(`流连接中断（已收到 ${receivedChunks} 个数据块）: ${describeError(readError)}`, {
          code: 'LLM_STREAM_READ_FAILED',
          retryable: true,
          cause: readError
        })
      }

      const { done, value } = readResult
      if (done) break

      receivedChunks++
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('event:')) continue
        if (trimmed === 'data: [DONE]') {
          console.log(`[llm-client] Stream done. Total tokens: ${totalTokens}, chunks: ${receivedChunks}`)
          return
        }

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6)
          try {
            const parsed = JSON.parse(jsonStr)
            const choice = parsed.choices?.[0]
            if (!choice) {
              if (parsed.usage) yield { content: '', reasoning: '', finishReason: null, usage: parsed.usage }
              continue
            }

            const delta = choice.delta ?? {}
            const content = delta.content ?? ''
            const reasoning = delta.reasoning_content ?? ''

            if (parsed.usage?.total_tokens) {
              totalTokens = parsed.usage.total_tokens
            }

            yield {
              content,
              reasoning,
              finishReason: choice.finish_reason ?? null,
              usage: parsed.usage || null
            }
          } catch {
            // 跳过不完整 JSON
            continue
          }
        }
      }
    }
  } finally {
    if (deadline) clearTimeout(deadline)
    reader.releaseLock()
    abortRequest(controller)
    cleanup?.()
  }
}

/**
 * 获取 Flash 模型名称（用于简单任务）
 */
export function getFlashModel() {
  return DEEPSEEK_FLASH_MODEL
}

/**
 * 获取 Pro 模型名称（用于复杂任务）
 */
export function getProModel() {
  return DEEPSEEK_MODEL
}
