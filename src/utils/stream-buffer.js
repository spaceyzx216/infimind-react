/**
 * 流式渲染节流：把"每个 SSE 事件一次 React 渲染"降到"每帧最多一次"。
 *
 * 问题（实测数据）：一次快速档咨询下发 **2713 个 `consult.delta` + 2762 个 `consult.reasoning`**，
 * 旧实现对每个事件都调一次 `setConversations`，于是产生 **5475 次完整 React 渲染**。
 * 更糟的是正文每来一小块就重新解析**整篇** Markdown（O(n²)），
 * 思考面板每次都重写一个不断变长的文本节点并强制重排。
 *
 * 后果：Chrome/Edge 靠更强的 JIT 与合成器扛住了；2018 款 MacBook Air 的 Safari
 * 与 360 浏览器（多为老 Chromium 内核）直接卡死或崩溃。
 *
 * 解法分两层，本模块负责第一层：
 *   1. **按帧合并**（本模块）：事件累积进缓冲，每帧至多 flush 一次，渲染次数从 5475 降到约 60/秒上限。
 *   2. **正文节流成 Markdown**（调用方配合）：合并后的文本再按时间间隔节流解析。
 *
 * 为什么用 rAF 而不是固定定时器：rAF 与浏览器绘制节奏对齐，后台标签页会自动暂停，
 * 不会在用户看不见的时候空转。
 */

/** 正文 Markdown 的最小重解析间隔（ms）。
 *
 * 选 200ms 的依据：人能感知的"流式"流畅度约 5~10 次/秒，200ms 对应 5 次/秒已足够顺滑；
 * 而解析次数从"每 delta 一次"（2713 次）降到约 30 次/轮，是 O(n²) 到 O(n) 的关键一步。
 */
export const MARKDOWN_THROTTLE_MS = 200

/**
 * 流式提交的最小间隔（ms）。
 *
 * ⚠️ 为什么"每帧一次"还不够：深度思考档实测下发 **11,100 个 reasoning + 2,520 个 delta**
 * （740KB），整轮 168 秒 → 约 66 个事件/秒，几乎每个显示帧都有新事件。
 * 于是 rAF 合并后仍有约 10,000 次渲染，只比旧实现少 26%。
 * 真正决定老浏览器能否扛住的是**渲染绝对次数**，所以必须给提交频率设上限。
 *
 * 100ms（=10 次/秒）的取舍：
 *  - 打字机效果在 10 次/秒下仍然连贯（人眼对 >10fps 的文本追加已难以分辨差异）；
 *  - 深度档渲染次数从 ~10,000 降到约 1,680，**无论上游事件多密集都不再劣化**。
 */
export const STREAM_COMMIT_INTERVAL_MS = 100

/**
 * 把分散的流式增量合并成"每帧一次"的提交。
 *
 * 设计要点：
 *  - **顺序不可变**：reasoning 与 content 各自独立累积，两路顺序都影响可读性。
 *  - **不丢尾部**：`flush()` 必须能同步取出未提交的剩余量，否则最后半句话会永久丢失。
 *  - **可空转**：没有增量时 `flush()` 返回 null，调用方据此跳过渲染而不是写入相同的字符串
 *    （写入相同字符串仍会让 React 重渲染，因为对象引用变了）。
 *  - **自身驱动**：`add*()` 会自行安排一帧后提交，调用方无需（也不应）在事件回调里 setState。
 *
 * @param {(patch: {reasoning?: string, content?: string}) => void} commit 提交函数（每帧至多一次）
 * @param {{ requestFrame?: Function, cancelFrame?: Function, now?: Function, minIntervalMs?: number }} [options]
 *   可注入以便测试；`minIntervalMs` 为两次提交的最小间隔（默认 STREAM_COMMIT_INTERVAL_MS）
 */
export function createStreamBuffer(commit, options = {}) {
  const requestFrame = options.requestFrame || ((callback) => requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame || ((handle) => cancelAnimationFrame(handle))
  const now = options.now || (() => Date.now())
  const minIntervalMs = options.minIntervalMs ?? STREAM_COMMIT_INTERVAL_MS
  let reasoning = ''
  let content = ''
  let frameHandle = null
  let lastCommit = -Infinity

  const cancelScheduled = () => {
    if (frameHandle !== null) {
      cancelFrame(frameHandle)
      frameHandle = null
    }
  }

  /**
   * 每帧至多提交一次，且两次提交至少间隔 `minIntervalMs`。
   *
   * 双重约束缺一不可：只有 rAF 时，事件率高于刷新率就无法合并（实测深度档 66 事件/秒）；
   * 只有时间间隔时，又可能在一次绘制里提交多次。两者一起才把渲染次数钉死在
   * 「≤ min(刷新率, 1000/minIntervalMs)」。
   */
  const commitFrame = () => {
    frameHandle = null
    const elapsed = now() - lastCommit
    if (elapsed < minIntervalMs) {
      // 还没到最小间隔：再等一帧，增量继续累积（不丢内容，只是晚一点显示）
      schedule()
      return
    }
    flush()
  }

  const schedule = () => {
    // 已有排程时不重复排程——这正是"每帧至多一次"的保证
    if (frameHandle === null) frameHandle = requestFrame(commitFrame)
  }

  const flush = () => {
    // 提交前先撤掉排程，避免同一批增量被提交两次
    cancelScheduled()
    if (!reasoning && !content) return null
    const patch = {}
    if (reasoning) patch.reasoning = reasoning
    if (content) patch.content = content
    reasoning = ''
    content = ''
    lastCommit = now()
    commit(patch)
    return patch
  }

  return {
    /** 累积一块思考内容。思考可能长达数万字，但这里只做字符串拼接，不触发渲染。 */
    addReasoning(chunk) {
      if (!chunk) return
      reasoning += chunk
      schedule()
    },
    /** 累积一块正文增量。 */
    addContent(chunk) {
      if (!chunk) return
      content += chunk
      schedule()
    },
    /** 取出并清空累积的增量并立即提交；无增量时返回 null（调用方应跳过渲染）。 */
    flush,
    /**
     * 丢弃尚未提交的增量与排程。
     * 仅用于"这一轮的结果已无意义"的场景（如组件卸载）；
     * 正常收尾必须用 `flush()`，否则会丢内容。
     */
    discard() {
      cancelScheduled()
      reasoning = ''
      content = ''
      lastCommit = -Infinity
    },
    /** 是否存在尚未提交的增量 */
    get pending() {
      return Boolean(reasoning || content)
    },
    /** 是否存在尚未提交的增量 */
    get pending() {
      return Boolean(reasoning || content)
    },
    /**
     * 直接读取缓冲中的完整内容（不清空）。
     *
     * 存在的意义是消除 setState 异步带来的竞态：流结束时需要"把尾部正文写进 message"
     * 与"把同一份正文写进 Markdown 快照"**同步**完成。若先 flush 再回读 state，
     * 此刻刚补写的内容还读不到，结尾就会丢。
     */
    get reasoningText() {
      return reasoning
    },
    get contentText() {
      return content
    }
  }
}

/**
 * 按时间间隔节流一个函数，并保证**尾调用一定会执行**。
 *
 * 为什么尾部必须执行：流式结束后如果最后一次解析被节流丢掉，
 * 用户看到的正文会停在倒数第二个片段——"回答少了一截"比"卡顿"严重得多。
 *
 * 与常见 debounce 的区别：debounce 会把连续调用一直推后，流式下可能永远不触发；
 * 这里第一次立即执行，之后按间隔放行，保证有稳定的更新节奏。
 *
 * @param {Function} fn 被节流的函数
 * @param {number} intervalMs 最小间隔
 * @param {{ schedule?: Function, cancel?: Function, now?: Function }} [timers] 可注入以便测试
 */
export function throttleWithTrailing(fn, intervalMs, timers = {}) {
  const schedule = timers.schedule || ((callback, delay) => setTimeout(callback, delay))
  const cancel = timers.cancel || ((handle) => clearTimeout(handle))
  const now = timers.now || (() => Date.now())

  let lastRun = -Infinity
  let handle = null
  let pendingArgs = null

  const invoke = () => {
    handle = null
    lastRun = now()
    const args = pendingArgs
    pendingArgs = null
    if (args) fn(...args)
  }

  const throttled = (...args) => {
    // ⚠️ 首次调用必须**立即执行**，不能依赖 `now() - lastRun >= interval`：
    // 把 lastRun 初始化为 0 时，只要时钟恰好从 0 附近起算（测试、或页面刚加载），
    // `0 - 0 >= interval` 为 false，第一块内容就会被推迟一整个间隔——
    // 流式场景下这表现为"点了发送后正文迟迟不出来"。
    const elapsed = now() - lastRun
    if (elapsed >= intervalMs) {
      // 立即执行前先撤掉可能存在的排程，避免同一批内容被提交两次
      if (handle !== null) {
        cancel(handle)
        handle = null
      }
      pendingArgs = null
      lastRun = now()
      fn(...args)
      return
    }
    // 已有排程时不重复排程，只更新参数——保证同一时间只有一个定时器
    pendingArgs = args
    if (handle === null) handle = schedule(invoke, Math.max(0, intervalMs - elapsed))
  }

  /** 立即执行挂起的尾调用（流结束时必须调用，否则末尾内容不落地） */
  throttled.flush = () => {
    if (handle) {
      cancel(handle)
      handle = null
    }
    if (pendingArgs) invoke()
  }
  /** 丢弃挂起的调用（组件卸载/切换会话时用） */
  throttled.cancel = () => {
    if (handle) {
      cancel(handle)
      handle = null
    }
    pendingArgs = null
  }
  return throttled
}
