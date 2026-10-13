import { createLaborContractRedactor } from './labor-contract-redaction.js'

// Handbook prose frequently says "员工怀孕后公司" or "可通过公司系统".
// A bare 公司 suffix must not turn preceding conditions into an organization.
const FULL_SUFFIX = '(?:股份有限公司|有限责任公司|有限公司|集团公司)'
const NAME_CHARS = '[\\u4e00-\\u9fffA-Za-z0-9·（）()]'
const mapDeep = (value, transform) => {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => mapDeep(item, transform))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapDeep(item, transform)]))
  return value
}

export function createHandbookRedactor({ documents = [], extraTexts = [] } = {}) {
  const identifiers = createLaborContractRedactor({ documents, extraTexts,
    categories: ['person', 'phone', 'identity', 'email', 'business-id', 'bank-account'] })
  const source = [...documents.map((doc) => `${doc.fileName || ''}\n${doc.text || ''}`), ...extraTexts].join('\n')
  const names = new Set()
  const add = (name) => {
    if (name && !/^(?:本|该|我|同一|所在)公司$/.test(name)) names.add(name)
  }
  const labeled = new RegExp(`(?:公司名称|企业名称|用人单位|派遣单位|用工单位|甲方|乙方|主体为)[：:\\s]*(${NAME_CHARS}{2,50}(?:${FULL_SUFFIX}|公司))`, 'g')
  for (const match of source.matchAll(labeled)) add(match[1])
  // Unlabelled names need a full legal suffix. Short names ending only in 公司
  // are accepted at a standalone name line, never in the middle of a rule.
  const full = new RegExp(`${NAME_CHARS}{2,50}${FULL_SUFFIX}`, 'g')
  for (const match of source.matchAll(full)) {
    const name = match[0].replace(/^(?:主体为|公司名称|企业名称)/, '')
    add(name)
  }
  const standalone = new RegExp(`^(${NAME_CHARS}{2,30}公司)(?=[，,。；;\\r\\n]|$)`, 'gm')
  for (const match of source.matchAll(standalone)) {
    if (!/(?:员工|适用|通过|通知|应当|必须|不得|起日|起算)/.test(match[1])) add(match[1])
  }
  const aliases = [...names].sort((a, b) => b.length - a.length).map((value, index) => ({ value, token: `【单位${index + 1}】`, category: 'organization' }))
  const replace = (value, restore = false) => aliases.reduce((text, alias) => text.split(restore ? alias.token : alias.value).join(restore ? alias.value : alias.token), value)
  return {
    aliases: [...identifiers.aliases, ...aliases],
    maskDeep: (value) => mapDeep(identifiers.maskDeep(value), (text) => replace(text)),
    restoreDeep: (value) => identifiers.restoreDeep(mapDeep(value, (text) => replace(text, true)))
  }
}
