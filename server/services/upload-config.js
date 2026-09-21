/**
 * 文件上传的共享白名单与限制。
 *
 * 用工咨询与合同审查/起草使用同一套支持格式，避免两处定义漂移。
 * 若新增格式，只需改这里（合同侧 server/routes/contract-rewrite.js 的白名单
 * 保留为历史副本，后续可迁移到本模块）。
 */

/** 浏览器与解析器均支持的 MIME 类型 */
export const ACCEPTED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'application/json',
  'application/xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/gif'
]

/** 前端 input accept 属性（扩展名白名单） */
export const ACCEPTED_EXTENSIONS = '.pdf,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.gif'

/** 单文件体积上限（80MB，与合同侧一致） */
export const MAX_FILE_SIZE = 80 * 1024 * 1024

/** 单次最多上传文件数 */
export const MAX_FILES = 6

const EXTENSION_PATTERN = /\.(pdf|doc|docx|rtf|odt|xls|xlsx|ods|ppt|pptx|odp|txt|md|markdown|csv|tsv|json|xml|html|htm|png|jpg|jpeg|webp|bmp|tif|tiff|gif)$/i

/**
 * 校验单个上传文件是否可接受。
 * 浏览器给出的 mimetype 不可靠（尤其 .md/.csv/.doc），因此同时看扩展名。
 * @param {{ mimetype?: string, originalname?: string }} file
 * @returns {boolean}
 */
export function isAcceptableFile(file) {
  if (!file) return false
  return ACCEPTED_TYPES.includes(file.mimetype) || EXTENSION_PATTERN.test(file.originalname || '')
}
