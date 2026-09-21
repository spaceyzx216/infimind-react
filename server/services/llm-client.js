import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env.local') })

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'
const DEEPSEEK_FLASH_MODEL = process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash'

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

function resolveThinkingOptions(model, thinking, reasoningEffort) {
  const type = thinking?.type || (model === DEEPSEEK_FLASH_MODEL ? 'disabled' : 'enabled')
  return {
    thinking: { type },
    ...(type === 'enabled' ? { reasoning_effort: reasoningEffort || 'high' } : {})
  }
}

/**
 * 请求超时。
 *
 * 此前这两个调用**完全没有超时**（裸 fetch，无 AbortController）——上游挂起会永久阻塞。
 * 流式生成本身可以长达数分钟，因此两者用不同预算：
 * 非流式（检索词改写等短任务）用短超时；流式只兜住"永久挂起"，给足生成时间。
 */
const CHAT_TIMEOUT_MS = Number(process.env.DEEPSEEK_CHAT_TIMEOUT_MS || 60000)
const STREAM_TIMEOUT_MS = Number(process.env.DEEPSEEK_STREAM_TIMEOUT_MS || 1800000)

/**
 * 带重试的请求。
 *
 * 超时是**整个请求的总预算**（含全部重试与后续流式读取），而不是每次尝试各算一份——
 * 否则重试会把最坏耗时堆成 `重试次数 × 单次超时`。信号覆盖到流读取结束，
 * 由调用方在 finally 中调用 cleanup() 释放定时器。
 *
 * @returns {Promise<{ response: Response, cleanup: Function }>}
 */
async function deepseekFetch(path, body, { retries = 3, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
  const url = `${DEEPSEEK_BASE_URL}${path}`
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  const cleanup = () => { if (timer) clearTimeout(timer) }
  const signal = controller ? controller.signal : undefined

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal
      })

      if (response.status === 429) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 30000)
        console.warn(`[llm-client] Rate limited. Retrying in ${waitMs}ms (attempt ${attempt}/${retries})`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }

      if (response.status === 400) {
        const err = await response.json().catch(() => ({}))
        throw new Error(`Bad request: ${JSON.stringify(err)}`)
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error')
        throw new Error(`API error ${response.status}: ${errText}`)
      }

      return { response, cleanup }
    } catch (err) {
      // 超时/主动取消不再重试：预算已耗尽，重试只会再等到同一时刻
      if (controller?.signal.aborted) {
        cleanup()
        throw new Error(`DeepSeek 请求超时（总预算 ${timeoutMs}ms）`)
      }
      if (attempt === retries) {
        cleanup()
        throw err
      }
      const waitMs = 1000 * attempt
      console.warn(`[llm-client] Request failed. Retrying in ${waitMs}ms (attempt ${attempt}/${retries})`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }

  cleanup()
  throw new Error('Unreachable')
}

/**
 * 非流式调用 DeepSeek Chat
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} options
 * @returns {Promise<string>}
 */
export async function chat(systemPrompt, userMessage, options = {}) {
  const {
    model = DEEPSEEK_MODEL,
    temperature = 0.3,
    maxTokens = 8192,
    thinking,
    reasoningEffort,
    timeoutMs = CHAT_TIMEOUT_MS
  } = options

  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({ role: 'user', content: userMessage })

  const { response, cleanup } = await deepseekFetch('/chat/completions', {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...resolveThinkingOptions(model, thinking, reasoningEffort)
  }, { timeoutMs })

  try {
    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content || ''

    if (data?.usage) {
      console.log(
        `[llm-client] Tokens: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`
      )
    }

    return content
  } finally {
    cleanup()
  }
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
    maxTokens = 8192,
    history = [],
    thinking,
    reasoningEffort
  } = options

  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  if (Array.isArray(history)) {
    history
      .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string' && message.content.trim())
      .slice(-12)
      .forEach((message) => messages.push({ role: message.role, content: message.content.slice(0, 6000) }))
  }
  messages.push({ role: 'user', content: userMessage })

  const inputChars = systemPrompt.length + userMessage.length
  const thinkingOptions = resolveThinkingOptions(model, thinking, reasoningEffort)
  // 把实际发出的模型与思考档位打进日志：否则"设了档位却没生效"这类问题无法自证
  // （reasoning_effort 仅在 thinking.type==='enabled' 时才会附带，静默丢弃过一次）
  const effortLabel = thinkingOptions.thinking.type === 'enabled' ? (thinkingOptions.reasoning_effort || 'high(默认)') : '未发送(thinking=disabled)'
  console.log(`[llm-client] Starting stream with model: ${model}, thinking: ${thinkingOptions.thinking.type}, reasoning_effort: ${effortLabel}, input ~${inputChars} chars`)

  const { response, cleanup } = await deepseekFetch('/chat/completions', {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    ...thinkingOptions
  }, { timeoutMs: STREAM_TIMEOUT_MS })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let totalTokens = 0
  let receivedChunks = 0
  // 分别统计思考与正文：reasoning_effort 拉高后出现过"只有思考、没有正文"的空答复，
  // 只记 chunk 数无法区分是模型没答还是流断了。
  let reasoningChars = 0
  let contentChars = 0
  let finishReason = null

  try {
    while (true) {
      let readResult
      try {
        readResult = await reader.read()
      } catch (readError) {
        if (receivedChunks === 0) {
          throw new Error(`流读取失败（尚未收到任何数据，可能是输入过大或 API 拒绝请求）: ${readError.message}`)
        }
        throw new Error(`流连接中断（已收到 ${receivedChunks} 个数据块）: ${readError.message}`)
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
          console.log(`[llm-client] Stream done. tokens=${totalTokens}, chunks=${receivedChunks}, `
            + `reasoning=${reasoningChars}字, content=${contentChars}字, finish=${finishReason || 'n/a'}`
            + (contentChars === 0 ? '  ⚠️ 无正文输出（思考可能耗尽了预算）' : ''))
          return
        }

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6)
          try {
            const parsed = JSON.parse(jsonStr)
            const choice = parsed.choices?.[0]
            if (!choice) continue

            const delta = choice.delta ?? {}
            const content = delta.content ?? ''
            const reasoning = delta.reasoning_content ?? ''

            if (parsed.usage?.total_tokens) {
              totalTokens = parsed.usage.total_tokens
            }
            if (choice.finish_reason) finishReason = choice.finish_reason
            reasoningChars += reasoning.length
            contentChars += content.length

            yield {
              content,
              reasoning,
              finishReason: choice.finish_reason ?? null
            }
          } catch {
            // 跳过不完整 JSON
            continue
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
    // 定时器必须活到流读取结束（信号覆盖整段生成），此处才释放
    cleanup()
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
