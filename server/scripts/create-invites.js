import { createBusinessDatabase } from '../services/business-db.js'
import { createAuthService } from '../services/auth-service.js'

const countArgIndex = process.argv.findIndex((argument) => argument === '--count')
const count = countArgIndex >= 0 ? Number(process.argv[countArgIndex + 1]) : 1
const database = createBusinessDatabase()

try {
  const codes = createAuthService(database).createInviteCodes(count)
  console.log(`已生成 ${codes.length} 个邀请码（邀请码只在本次命令输出，请安全保存）：`)
  codes.forEach((code) => console.log(code))
} finally {
  database.close()
}
