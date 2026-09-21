/**
 * 追问检索词改写（conversational query rewriting）。
 *
 * 解决的问题：多轮追问常含指代而缺主题词。此前的启发式（按长度决定是否并入上一轮提问）
 * 有明确失效边界——「那按照您刚才说的这个思路我们接下来具体应该怎么操作呢」这类
 * **长句纯指代**追问不会被识别，检索仍会跑偏到无关主题。
 *
 * 本模块用一次短 LLM 调用把追问改写成**自足**的检索查询：补全被指代/省略的主题词，
 * 去掉寒暄与语气词。
 *
 * 设计约束：
 *  - **失败可回退**：任何异常都返回 `ok:false`，由调用方回退到启发式。降级必须可见（见 routes/labor-consult.js 的 warnings）。
 *  - **零思考**：显式关闭 thinking。改写是文本变换任务，开启推理只会白白增加延迟。
 *  - **严格校验输出**：模型可能返回解释、答案或整段文字，必须能识别并拒绝，否则会把垃圾喂给检索。
 */
import { chat, getFlashModel } from './llm-client.js'

/** 改写结果的字符上限：检索查询应当简短，超长说明模型在写答案而不是查询 */
const MAX_QUERY_CHARS = 120
/** 低于此长度视为无有效内容 */
const MIN_QUERY_CHARS = 4
/** 上文里保留的助手回答摘要长度：足以判断"这种情况"指什么，又不会喧宾夺主 */
const ANSWER_EXCERPT_CHARS = 500
/** 保留的上文轮数（用户提问） */
const MAX_CONTEXT_TURNS = 3

const REWRITE_SYSTEM_PROMPT = `你是检索查询改写器。根据对话上文，把用户的最新提问改写成一条**自足**的中文检索查询。

规则：
1. 只输出改写后的查询本身。不要解释、不要加引号、不要编号、不要回答问题、不要输出任何前缀。
2. 补全被指代或省略的主题词（例如「这种情况」「那这样」「他」具体指什么）。
3. 删除寒暄、语气词、客套与与主题无关的修饰。
4. 保留专业术语、法律名称、数字等关键检索信息。
5. 长度不超过 60 字。
6. 若最新提问本身已经自足（不依赖上文即可理解），原样输出该提问。`

/** 把上文压成简短文本：用户提问全保留，助手回答只取开头摘要 */
export function formatRewriteContext(history = []) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((item) => item && typeof item.content === 'string' && item.content.trim())
  if (!turns.length) return ''

  const lines = []
  const userTurns = turns.filter((item) => item.role === 'user').slice(-MAX_CONTEXT_TURNS)
  const lastAssistant = [...turns].reverse().find((item) => item.role === 'assistant')
  for (const item of userTurns) lines.push(`用户：${item.content.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
  if (lastAssistant) {
    lines.push(`助手（摘要）：${lastAssistant.content.replace(/\s+/g, ' ').trim().slice(0, ANSWER_EXCERPT_CHARS)}`)
  }
  return lines.join('\n')
}

/**
 * 清洗模型输出。
 *
 * 模型经常不守规矩：加「检索词：」前缀、包引号、用代码块、或干脆写成一段解释。
 * 这里逐项剥掉；剥不干净的（过长、含标题结构）由调用方判为失败并回退。
 */
export function sanitizeRewrite(raw) {
  let text = String(raw || '').trim()
  text = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '')
  text = text.split('\n').map((line) => line.trim()).filter(Boolean)[0] || ''
  text = text.replace(/^(检索查询|检索词|查询词|查询|改写后|query)\s*[:：]\s*/i, '')
  text = text.replace(/^["'“”『」《]+|["'“”『」》]+$/g, '')
  return text.trim()
}

/**
 * 判断输出是否像"答案"而不是"查询"。
 * 命中任一项即拒绝，避免把解释性长文当成检索词。
 */
const looksLikeAnswer = (text) => (
  text.length > MAX_QUERY_CHARS
  || /^(根据|依据|综上|首先|建议|回答|答案)[，,：:]/.test(text)
  || /[。；;]{1}.*[。；;]{1}/.test(text)          // 多个句末标点 = 多句成段
  || /【|】|^#|\*\*/.test(text)                    // 复述了提示词的标记
)

/**
 * 清洗并校验模型输出。
 *
 * 独立导出是为了可回归测试——这段"拒绝垃圾输出"的逻辑决定了会不会把
 * 一段解释性长文当成检索词喂给检索，值得单独守住，而不必为它调用一次模型。
 *
 * @returns {{ ok: boolean, query: string, reason?: string }}
 */
export function validateRewrite(raw) {
  const query = sanitizeRewrite(raw)
  if (query.length < MIN_QUERY_CHARS) return { ok: false, query: '', reason: 'empty' }
  if (looksLikeAnswer(query)) return { ok: false, query: '', reason: 'not_a_query' }
  return { ok: true, query }
}

/** 把请求异常归类为短码。
 *
 * ⚠️ 为什么不直接返回原始错误信息：`reason` 会随 SSE 的 retrieval 元信息下发到浏览器
 * （并可能被前端持久化），而模型服务的错误文本里**可能包含 API Key 片段**
 * （实测 DeepSeek 会回 "Your api key: ****test is invalid"）。完整错误只应留在服务端日志。
 */
function classifyFailure(message = '') {
  if (/401|403|Authentication|invalid/i.test(message)) return 'auth_failed'
  if (/429|rate limit/i.test(message)) return 'rate_limit'
  if (/超时|timeout|aborted/i.test(message)) return 'timeout'
  return 'request_failed'
}

/**
 * 把追问改写为自足的检索查询。
 *
 * @param {{ message: string, history?: Array<{role:string,content:string}> }} params
 * @returns {Promise<{ ok: boolean, query?: string, reason?: string, error?: string, elapsedMs: number }>}
 *   `ok:false` 时调用方必须回退到启发式检索词——不要使用 `query`。
 *   `reason` 是可安全外发的短码；`error` 是原始错误，**仅供服务端日志**。
 */
export async function rewriteFollowUpQuery({ message, history = [] }) {
  const started = Date.now()
  const context = formatRewriteContext(history)
  if (!context) return { ok: false, reason: 'no_context', elapsedMs: Date.now() - started }

  let raw = ''
  try {
    raw = await chat(REWRITE_SYSTEM_PROMPT, `${context}\n\n最新提问：${message}`, {
      model: getFlashModel(),
      temperature: 0,
      maxTokens: 256,
      // 文本变换任务，不需要推理；开启只会平白增加延迟
      thinking: { type: 'disabled' }
    })
  } catch (error) {
    return { ok: false, reason: classifyFailure(error.message), error: error.message, elapsedMs: Date.now() - started }
  }

  const validated = validateRewrite(raw)
  const elapsedMs = Date.now() - started
  if (!validated.ok) return { ok: false, reason: validated.reason, elapsedMs }
  return { ok: true, query: validated.query, elapsedMs }
}
