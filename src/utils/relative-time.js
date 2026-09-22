/**
 * 相对时间格式化：把时间戳渲染成「1分钟前 / 30分钟前 / 1小时前 / 2天前 / 3个月前 / 1年前」。
 *
 * 单位按**量级递进**切换，同一屏里不会同时出现"分钟"和"年"：
 *   < 1 分钟   → 刚刚
 *   < 1 小时   → N 分钟前
 *   < 1 天     → N 小时前
 *   < 1 个月   → N 天前        （按 30 天，不是自然月——相对时间不需要日历精度）
 *   < 1 年     → N 个月前      （按 365/12 天）
 *   ≥ 1 年     → N 年前
 *
 * ⚠️ 边界用**向下取整的区间**而不是 Math.round："60 分钟前"是错的，
 * 那个时刻应该是"1 小时前"。先判区间再取整，才能保证 59分59秒 → "59分钟前"、
 * 60分00秒 → "1小时前"。用 round 会让 45 分钟显示成"1小时前"，用户会觉得时间跳了。
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** 未来时间（时钟偏差、服务端与浏览器不同步）不显示负数，统一按"刚刚"。 */
const clamp = (value) => (Number.isFinite(value) && value > 0 ? value : 0)

/**
 * @param {number|Date|string} value 时间戳（毫秒）或可被 Date 解析的值
 * @param {number|Date} [nowValue] 参照时间，默认当前时刻。显式传入是为了可测试。
 * @returns {string} 形如「3天前」；无法解析时返回空串（由调用方决定不渲染）
 */
export function formatRelativeTime(value, nowValue = Date.now()) {
  const time = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(time) || time <= 0) return ''
  const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue)
  if (!Number.isFinite(now)) return ''

  const diff = clamp(now - time)

  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`
  if (diff < MONTH) return `${Math.floor(diff / DAY)}天前`
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}个月前`
  return `${Math.floor(diff / YEAR)}年前`
}

/**
 * 侧边栏刷新的推荐间隔。
 *
 * 最小可显示粒度是"分钟"，所以 30s 刷新足以让秒级误差不会累积成"显示落后一分钟"，
 * 又不至于为了一个灰字每几秒重渲染整个会话列表。
 */
export const RELATIVE_TIME_TICK_MS = 30000

export default formatRelativeTime
