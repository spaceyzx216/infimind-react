/**
 * 输入框附件选择的共享逻辑。
 *
 * 修掉的三个问题：
 *  1. **只能保留一份**：三个工作台都写成 `setFiles(本次选择)`，分几次选文件时
 *     上一次的选择会被整体丢掉——表现出来就是"只能上传一份"。
 *  2. **无扩展名文件被误放行**：原先用 `ACCEPTED.includes(ext)` 判断，而
 *     字符串的 `includes('')` 恒为 true（空串是任何字符串的子串），
 *     于是没有扩展名的文件前端放行、后端 400 拒绝，用户看到的是莫名其妙的报错。
 *  3. **格式白名单三处漂移**：用工咨询页含 `.markdown`，两个合同页不含。
 *     现在统一从 server/services/upload-config.js 取（该模块是纯常量、无服务端依赖，
 *     注释里本来就写明"若新增格式只需改这里"）。
 */
import { ACCEPTED_EXTENSIONS, MAX_FILES, MAX_FILE_SIZE } from '../../server/services/upload-config.js'

export { ACCEPTED_EXTENSIONS, MAX_FILES, MAX_FILE_SIZE }

/** 扩展名白名单的集合形式（用 Set 而不是字符串 includes，避免子串误判） */
const EXTENSIONS = new Set(
  ACCEPTED_EXTENSIONS.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
)

/** 文件说明文案，供错误提示与界面复用 */
export const SUPPORTED_FORMATS_LABEL = 'PDF、Word、Excel、PPT、RTF、文本与图片'

const extensionOf = (name) => {
  const matched = String(name || '').toLowerCase().match(/\.[^.]+$/)
  return matched ? matched[0] : ''
}

/**
 * 单个文件是否可接受。
 * 无扩展名（或扩展名不在白名单）一律拒绝；体积超限拒绝。
 */
export function isSupportedFile(file) {
  if (!file) return false
  if (!EXTENSIONS.has(extensionOf(file.name))) return false
  return file.size <= MAX_FILE_SIZE
}

/**
 * 把新选择的文件并入已有选择。
 *
 * 行为约定：
 *  - **追加**而不是替换（这是本模块存在的主要理由）；
 *  - 同名文件视为同一份：大小与修改时间都相同 → 重复选择，忽略；
 *    否则视为用户换了修订版，就地替换，且不占用新的名额；
 *  - 超出 `MAX_FILES` 的按顺序丢弃，不做静默截断——由调用方提示用户。
 *
 * @param {File[]} current 已选文件
 * @param {File[]} incoming 本次选择的文件
 * @returns {{ files: File[], unsupported: string[], overflow: string[] }}
 */
export function mergeSelectedFiles(current = [], incoming = []) {
  const files = [...(Array.isArray(current) ? current : [])]
  const unsupported = []
  const overflow = []

  for (const file of Array.isArray(incoming) ? incoming : []) {
    if (!isSupportedFile(file)) {
      unsupported.push(file?.name || '未命名文件')
      continue
    }
    const at = files.findIndex((item) => item.name === file.name)
    if (at >= 0) {
      const identical = files[at].size === file.size && files[at].lastModified === file.lastModified
      if (!identical) files[at] = file
      continue
    }
    if (files.length >= MAX_FILES) {
      overflow.push(file.name)
      continue
    }
    files.push(file)
  }

  return { files, unsupported, overflow }
}

/**
 * 生成被拒文件的提示文案。
 * 分别说明"格式不支持"与"超出数量"，避免旧实现里那句与实际白名单不符的笼统提示。
 * @returns {string} 无拒绝时返回空串
 */
export function describeRejection({ unsupported = [], overflow = [] } = {}) {
  const parts = []
  if (unsupported.length) {
    const names = unsupported.slice(0, 2).join('、')
    parts.push(`${unsupported.length} 个文件格式不支持（${names}${unsupported.length > 2 ? ' 等' : ''}）`)
  }
  if (overflow.length) parts.push(`超出上限，已忽略 ${overflow.length} 个`)
  if (!parts.length) return ''
  return `已忽略：${parts.join('；')}。支持 ${SUPPORTED_FORMATS_LABEL}，单个不超过 ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB，一次最多 ${MAX_FILES} 个。`
}
