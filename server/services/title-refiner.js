/**
 * 会话标题提炼（conversation auto-titling）。
 *
 * 解决的问题：侧边栏里每个会话都叫「新的用工咨询」，用户分不清哪条是哪条。
 * 本地的启发式（`buildConversationTitle`）只能裁剪原句，含开场白的长提问
 * 会被切成半句；这里用一次**极短**的 LLM 调用把它提炼成「未签合同二倍工资抗辩」
 * 这类真正的主题标签。
 *
 * 设计约束（与 query-rewriter.js 同源，因为面对的是同一类模型的同类毛病）：
 *  - **零思考**：显式关闭 thinking。起标题是文本压缩任务，开推理只是白等。
 *  - **失败必须可回退**：任何异常/校验不通过都返回 `ok:false`，
 *    由前端保留本地启发式标题——标题是锦上添花，绝不能因为它让会话变得不可用。
 *  - **严格校验输出**：模型经常不守规矩（写解释、加"标题："前缀、包引号、
 *    给出法律结论）。起标题这个场景尤其危险：**标题会被用户当成"这款 AI 对
 *    我这个案子的定性"**，一个越界的结论性标题比没有标题糟得多。
 */

const MAX_TITLE_CHARS = 20
/** 低于此长度认为没有信息量（单字标题无法区分会话） */
const MIN_TITLE_CHARS = 2
/** 提示词里注入的提问长度上限：标题只需要主题，不需要全文 */
const QUESTION_EXCERPT_CHARS = 500

const TITLE_SYSTEM_PROMPT = `你是会话标题生成器。把用户的劳动法提问压缩成一个能区分会话的中文短标题。

规则：
1. 只输出标题本身。不要解释、不要加引号、不要编号、不要写"标题："之类的任何前缀。
2. 不超过 20 个字，**只写一行**。
3. 点出核心法律争点或用工场景，用名词短语，不要写成句子。
   好例子：未签合同二倍工资抗辩 / 竞业限制违约金 / 调岗降薪仲裁 / 试用期辞退
   坏例子：员工入职三个月没签书面劳动合同现在离职要求二倍工资公司该怎么应对
4. 不要给出结论或判断，只描述问题主题。
5. 不要出现"用户""提问""咨询""分析"这类元词汇。
6. 若提问包含多条诉求，只取最主要的一条。`

/**
 * 清洗模型输出。
 *
 * 模型几乎总会带点包装：Markdown 代码块、`标题：` 前缀、中英文引号、书名号外衣。
 * 逐项剥掉；剥不干净的（过长、多行成段）由 validateTitle 判为失败并回退。
 */
export function sanitizeTitle(raw) {
  let text = String(raw || '').trim()
  // 代码块围栏（模型最爱的包装之一）
  text = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '')
  // 只取首个非空行：模型常在标题后附一行解释
  text = text.split('\n').map((line) => line.trim()).filter(Boolean)[0] || ''
  // 「标题：」「会话标题 -」等前缀
  text = text.replace(/^(会话标题|对话标题|标题|主题|title)\s*[:：\-—]\s*/i, '')
  // 成对包裹的引号 / 书名号 / 方括号（只剥成对的，避免吃掉《劳动合同法》这种真实的书名号）
  text = text.replace(/^["'“”『「]+|["'“”』」]+$/g, '')
  text = text.replace(/^[【\[]+|[】\]]+$/g, '')
  // 结尾标点：标题不需要句号
  text = text.replace(/[，,。、；;：:！!？?…~～\s]+$/, '')
  return text.trim()
}

/**
 * 判断输出是否像"回答/解释"而不是标题。
 * 命中任一项即拒绝——宁可留着本地启发式标题，也不要一个答非所问的标题。
 */
const looksLikeAnswer = (text) => (
  text.length > MAX_TITLE_CHARS
  || /[。；;]/.test(text)                                  // 标题里不该有句末标点
  || /^(根据|依据|综上|首先|其次|建议|回答|答案|分析|结论)[，,：:]?/.test(text)
  || /【|】|^#|\*\*/.test(text)                            // 复述了提示词的标记
  || /(用户|提问|咨询|请问|您好|你好)/.test(text)          // 元词汇：说明它在描述任务而不是起标题
  || /(应当|不应|可以要求|不得|违法|合法|需要承担)/.test(text) // 结论性措辞：标题不做定性
)

/**
 * 清洗并校验模型输出。
 *
 * 独立导出是为了可回归测试——这段"拒绝垃圾输出"的逻辑决定了会不会把一个
 * 法律结论当成标题展示给用户，值得单独守住，而不必为它调用一次模型。
 *
 * @returns {{ ok: boolean, title: string, reason?: string }}
 */
export function validateTitle(raw) {
  const title = sanitizeTitle(raw)
  if (title.length < MIN_TITLE_CHARS) return { ok: false, title: '', reason: 'too_short' }
  if (looksLikeAnswer(title)) return { ok: false, title: '', reason: 'not_a_title' }
  return { ok: true, title }
}

/** 把请求异常归类为短码。
 *
 * ⚠️ 不直接外发原始错误信息：`reason` 会随响应下发给浏览器，
 * 而模型服务的错误文本**可能包含 API Key 片段**（实测 DeepSeek 会回
 * "Your api key: ****test is invalid"）。完整错误只应留在服务端日志。
 */
function classifyFailure(message = '') {
  if (/401|403|Authentication|invalid/i.test(message)) return 'auth_failed'
  if (/429|rate limit/i.test(message)) return 'rate_limit'
  if (/超时|timeout|aborted/i.test(message)) return 'timeout'
  return 'request_failed'
}

/**
 * 依据首轮提问提炼会话标题。
 *
 * @param {{ question: string }} params
 * @returns {Promise<{ ok: boolean, title?: string, reason?: string, error?: string, elapsedMs: number }>}
 *   `ok:false` 时调用方**必须保留**原有标题，不要使用 `title`。
 *   `reason` 是可安全外发的短码；`error` 是原始错误，仅供服务端日志。
 */
export async function refineConversationTitle({ question }) {
  const started = Date.now()
  const text = String(question || '').replace(/\s+/g, ' ').trim()
  if (text.length < MIN_TITLE_CHARS) {
    return { ok: false, reason: 'no_question', elapsedMs: Date.now() - started }
  }

  // 延迟 import：llm-client 在模块顶层读 .env.local，而本模块会被
  // 回归测试（不调模型）直接 import。顶层静态 import 会把独立跑测试的
  // 环境也拖进 dotenv 与 API Key 检查。
  const { chat, getFlashModel } = await import('./llm-client.js')

  let raw = ''
  try {
    raw = await chat(TITLE_SYSTEM_PROMPT, text.slice(0, QUESTION_EXCERPT_CHARS), {
      model: getFlashModel(),
      temperature: 0.2,
      maxTokens: 64,
      // 文本压缩任务，不需要推理；开启只会平白增加延迟
      thinking: { type: 'disabled' }
    })
  } catch (error) {
    return { ok: false, reason: classifyFailure(error.message), error: error.message, elapsedMs: Date.now() - started }
  }

  const validated = validateTitle(raw)
  const elapsedMs = Date.now() - started
  if (!validated.ok) return { ok: false, reason: validated.reason, raw, elapsedMs }
  return { ok: true, title: validated.title, elapsedMs }
}

/**
 * 提炼结果 → **可下发到浏览器**的形状。
 *
 * ⚠️ 必须剥掉 `error` 与 `raw` 两个字段：
 *  - `error` 是上游原始报错文本。实测 DeepSeek 的 401 回包形如
 *    `Authentication Fails, Your api key: ****test is invalid` —— 这次被掩码纯属侥幸。
 *    同类问题在 rewriteFollowUpQuery 那条路径上更严重：它的结果对象被直接塞进
 *    SSE 的 `retrieval.queryRewrite`，等于把密钥片段发到浏览器并可能被前端持久化。
 *  - `raw` 是模型原始输出，属内部诊断信息，没有下发价值。
 *
 * 只留 `ok` / `reason` / `title` / `elapsedMs`：足够前端判断是否覆盖标题，也足够日志定位。
 */
export const toClientResult = ({ error, raw, ...safe }) => safe

/**
 * 是否启用标题提炼。默认开启。
 * 关闭后前端保留本地启发式标题（省下一次 API 调用与约 0.4~1.3s 后台开销）。
 */
export const isTitleRefineEnabled = () => String(process.env.LABOR_TITLE_REFINE || 'on').toLowerCase() !== 'off'
