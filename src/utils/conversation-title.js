/**
 * 会话标题：本地即时启发式 + 占位符判定。
 *
 * 为什么和 src/utils/file-selection.js 一样放 `src/utils/`：
 * 前端要"提问瞬间立刻有个可辨识的标题"，服务端在 LLM 提炼失败时要用**同一套**
 * 逻辑回退。两处各写一份必然漂移（项目已因"格式白名单三处副本漂移"吃过亏），
 * 所以这里只有一份定义，服务端直接 import。
 *
 * 为什么需要它：原先 `titleFromQuestion` 只是把提问硬截断到 22 字，
 * 含开场白的问题会被切成「员工入职三个月没签书面劳动合同，现在离…」这种半句，
 * 一列会话看下来仍然难以区分。
 */

/** 侧边栏标题的字符上限（视觉宽度，不是字节） */
export const MAX_TITLE_CHARS = 22
/** 服务端 LLM 提炼标题的字符上限 */
export const MAX_REFINED_TITLE_CHARS = 20
/** 新会话的占位标题 */
export const DEFAULT_TITLE = '新的用工咨询'

/**
 * 历史遗留的占位标题。
 * 早期版本用过「历史咨询」，normalizeThreads 也会兜底产出它。
 */
const PLACEHOLDER_TITLES = new Set([DEFAULT_TITLE, '历史咨询', '新咨询', ''])

/** 判定一个标题是否仍是占位符（即"可以安全被自动命名覆盖"） */
export const isPlaceholderTitle = (title) => PLACEHOLDER_TITLES.has(String(title || '').trim())

/**
 * 开头寒暄与提问前缀。
 * 这些词出现在标题里对"分辨是哪个会话"毫无贡献，反而挤掉真正有信息量的主题词。
 * 逐轮剥离（「你好，请问」这类叠加前缀一次剥不干净）。
 */
const LEADING_NOISE = /^(麻烦|劳驾|请教|请问|想问下|想问一下|想问|我想问|我想咨询|我想了解|想咨询|想了解|咨询一下|咨询下|咨询|你好|您好|您好请问|各位律师|律师你好|帮我看下|帮我看一下|帮我分析下|帮我分析|看看|问一下|问下)\s*[，,、。：:；;\s]*/

/**
 * 句尾语气与疑问标记：整句最后一个标点通常无信息量。
 * 只剥**结尾**的符号，不改动中间的（中间的问号往往是并列表述，保留更利于辨认）。
 */
const TRAILING_NOISE = /[，,。、；;：:！!？?…~～\s]+$/

/**
 * 无信息量的尾部收尾语。
 * 「…公司该怎么应对？」→「…公司应对」比原句更适合当标签。
 */
const TRAILING_FILLER = /(我们|公司|企业)?(应该|应当|该|要|需要)?(怎么办|如何应对|怎么应对|怎么处理|如何处理|如何解决|怎么解决|该怎么应对|怎么做好|是什么|有哪些|吗|呢|吧)\s*$/

/** 归并空白：换行、连续空格在侧边栏单行标题里都会变成难看的空洞 */
const collapse = (text) => String(text || '').replace(/\s+/g, ' ').trim()

/**
 * 从提问文本生成即时标题。
 *
 * 这是**零延迟、零成本**的第一层命名：提问落下的同一帧标题就可辨识。
 * 服务端 LLM 提炼（title-refiner.js）成功后会覆盖为更精炼的版本，
 * 但它失败/超时也不影响可用性——本函数就是那条回退路径。
 *
 * @param {string} text 用户首轮提问，或附件名
 * @returns {string} 1~22 字的标题；无有效输入时返回占位标题
 */
export function buildConversationTitle(text) {
  let title = collapse(text)
  if (!title) return DEFAULT_TITLE

  // 逐轮剥离开场白。最多 4 轮，避免正则回溯或把正常内容吃掉。
  for (let round = 0; round < 4; round += 1) {
    const next = title.replace(LEADING_NOISE, '')
    if (next === title) break
    title = next
  }

  title = collapse(title).replace(TRAILING_NOISE, '')
  // 收尾语只剥一次：剥过头会把「公司该怎么应对」里的「公司」也带走
  title = collapse(title.replace(TRAILING_FILLER, '').replace(TRAILING_NOISE, ''))
  if (!title) return DEFAULT_TITLE

  if (title.length > MAX_TITLE_CHARS) {
    title = `${title.slice(0, MAX_TITLE_CHARS)}…`
  }
  return title
}

/**
 * 是否应该用自动命名覆盖标题。
 *
 * 两种情况可以覆盖：
 *  1. 标题仍是占位符（新会话尚未命名，或历史遗留的「新的用工咨询」）；
 *  2. 标题就是本会话首轮提问旧的启发式产物（LLM 提炼版要顶掉它）。
 *
 * 明确排除用户/其它逻辑手工设过的标题——不抢用户的东西。
 *
 * @param {string} current 当前标题
 * @param {string} firstQuestion 本会话首轮提问
 */
export function shouldAutoTitle(current, firstQuestion) {
  const title = collapse(current)
  if (isPlaceholderTitle(title)) return true
  return title === buildConversationTitle(firstQuestion)
}

/**
 * `ask()` 在"只传附件不写提问"时合成的占位文案。
 *
 * 它会被写进 `message.content`，因而与用户真实写下的文字无法靠"内容是否为空"区分。
 * 必须按文案本身识别，否则附件轮会话会全部退化成同一个无法区分的主语。
 */
const SYNTHETIC_FILE_PROMPT = /^请分析我上传的\s*\d+\s*份材料/

/** 判断一条 user 消息的内容是否为上方的合成文案（而非用户真实表述） */
export const isSyntheticFilePrompt = (text) => SYNTHETIC_FILE_PROMPT.test(collapse(text))

/**
 * 取会话的首轮用户提问文本。
 *
 * @param {{ messages?: Array }} conversation
 * @returns {string} 未做标题化处理的原文本；无内容时返回空串
 */
export function firstQuestionOf(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : []
  const firstUser = messages.find((message) => message?.type === 'user')
  if (!firstUser) return ''
  const content = collapse(firstUser.content)
  // ⚠️ 附件轮必须优先用**文件名**：用户只传材料不写提问时，ask() 会把
  // 「请分析我上传的 N 份材料…」这句**合成文案**写进 message.content，
  // 而它不是用户的表述。直接用它命名只会得到一个千篇一律、
  // 完全无法区分会话的标题（实测 LLM 也只能提炼出「劳动用工问题分析」）。
  if (firstUser.files?.length && isSyntheticFilePrompt(content)) {
    return collapse(firstUser.files[0].name)
  }
  // 用户确实写了提问时才用提问：那是他真实的表述，比文件名更能说明这个会话在问什么。
  return content || collapse(firstUser.files?.[0]?.name || '')
}
