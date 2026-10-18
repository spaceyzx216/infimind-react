/**
 * 邀请码的格式、规范化与哈希。
 *
 * 注册链路（auth-service）与运维管理台（admin-service）必须共用同一套规则：
 * - 格式：7 位大写字母 + 数字（36^7≈781 亿种），便于人工抄写与电话传递；
 * - 入库：只存 sha256 哈希，业务库/备份泄露都拿不到明文邀请码；
 * - 生成：取模前先丢弃 >=252 的字节，避免字符分布偏差。
 */
import { createHash, randomBytes } from 'node:crypto'

export const INVITE_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const INVITE_CODE_LENGTH = 7
export const INVITE_CODE_PATTERN = /^[A-Z0-9]{7}$/

/** 用户输入可能带空格/小写；入库与比对前统一规范化。 */
export const normalizeInviteCode = (value) => String(value || '').trim().toUpperCase()

/** 只保存哈希，不保存明文。 */
export const hashInviteCode = (value) => createHash('sha256').update(normalizeInviteCode(value)).digest('hex')

/** 生成一个符合格式的邀请码；唯一性由 invite_codes.code_hash 唯一索引兜底。 */
export const generateInviteCode = () => {
  let code = ''
  while (code.length < INVITE_CODE_LENGTH) {
    for (const byte of randomBytes(INVITE_CODE_LENGTH * 2)) {
      if (code.length >= INVITE_CODE_LENGTH) break
      if (byte >= 252) continue
      code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length]
    }
  }
  return code
}

export const isValidInviteCodeFormat = (value) => INVITE_CODE_PATTERN.test(normalizeInviteCode(value))
