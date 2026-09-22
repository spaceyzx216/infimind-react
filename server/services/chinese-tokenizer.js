/**
 * FTS5 默认的 unicode61 会把「标点之间的连续汉字」当成一个 token，导致中文词检索大面积失效：
 * 实测「付款」在 100 条含它的条款里 MATCH 命中 0 条、「违约」319 条命中 0 条。
 * 这里用「中文 2-gram」绕开：索引期把连续汉字串展开为相邻两字的组合，查询期用同一套规则
 * 展开后交给 FTS5 做短语查询（空格分隔 = 相邻词序匹配），两端同源即可命中。
 * 选 2-gram 而非 trigram：trigram 要求 ≥3 字符，而两字中文词占比很高（约 19.4%）。
 */
const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff'
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, 'g')
const CJK_ONE = new RegExp(`[${CJK_CLASS}]`)
// 「汉字 + 标点 + 汉字」：标点不携带词序信息，去掉后两段汉字连成一个串再展开，
// 这样「甲方：付款」与「甲方付款」能互相命中。非中文环境（Party A pays）不受影响。
const CJK_INNER_PUNCT = new RegExp(`([${CJK_CLASS}])[^\\p{L}\\p{N}\\s](?=[${CJK_CLASS}])`, 'gu')

/** 索引期：把连续汉字串展开为相邻两字的序列，非中文片段原样保留 */
export function toIndexText(text) {
  return expand(String(text || ''))
}

/** 查询期：把单个检索词展开为 bigram 序列（用空格连接后作为 FTS5 短语查询） */
export function toQueryTerm(term) {
  const value = String(term || '').trim()
  if (!value) return ''
  if (!CJK_ONE.test(value)) return value
  return expand(value)
}

function expand(text) {
  return text
    .replace(CJK_INNER_PUNCT, '$1')
    .replace(CJK_RUN, (run) => bigrams(run))
    .replace(/\s+/g, ' ')
    .trim()
}

function bigrams(run) {
  if (run.length <= 1) return run
  const parts = []
  for (let i = 0; i < run.length - 1; i++) parts.push(run.slice(i, i + 2))
  return parts.join(' ')
}
