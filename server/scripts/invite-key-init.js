/**
 * 只生成/轮换 `ADMIN_CODE_KEY`（邀请码明文 AES-256-GCM 密钥）。
 *
 * 用法：node server/scripts/invite-key-init.js
 * 输出一行 `ADMIN_CODE_KEY=...`，写入服务器 .env.local（600）后 pm2 reload。
 *
 * ⚠️ 轮换密钥后，旧密文将无法解密；如需保留旧码可见，必须先用旧 key
 * 导出明文并用新 key 重新回填（见 backfill-invite-plaintext.js），或临时配置
 * 双钥解密（当前未实现）。
 */
import { generateInviteCodeKey } from '../services/invite-crypto.js'

console.log(`ADMIN_CODE_KEY=${generateInviteCodeKey()}`)
console.error('[提示] 写入服务器 .env.local（600）后 pm2 reload infimind-server；轮换前先考虑历史密文迁移。')
