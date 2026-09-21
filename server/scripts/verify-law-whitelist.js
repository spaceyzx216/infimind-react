/**
 * 法规白名单人工核对清单。
 *
 * 用法：
 *   node server/scripts/verify-law-whitelist.js              # 列出待核对条目与核对指引
 *   node server/scripts/verify-law-whitelist.js --all        # 列出全部条目
 *   node server/scripts/verify-law-whitelist.js --confirm "中华人民共和国劳动法" 张三
 *       # 将某条法规标记为已核对（记录核对人与日期）
 *
 * 这是白名单机制的运维入口：引用被拒时会记日志，运营按需补录与核对，
 * 从而把"法规时效性"从模型判断变成一个**可度量、可审计**的覆盖率问题。
 */
import {
  initialize,
  listPendingReviewLaws,
  listLawsForBaseline,
  findLaw,
  upsertLaw,
  getLaborStatus,
  close
} from '../services/law-whitelist.js'

const today = () => {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const pick = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

const CHECKLIST = [
  '1. 打开国家法律法规数据库 https://flk.npc.gov.cn/ （人工网页查询，免费且允许）',
  '2. 搜索法规全称，核对「公布日期」「施行日期」是否与本表一致',
  '3. 确认「时效性」为现行有效；若显示已修改/已废止，更新 status 与 effective_to',
  '4. 若已废止，填写 superseded_by（取代它的法规）与 repeal_basis（废止依据条款）',
  '5. 核对完成后执行：node server/scripts/verify-law-whitelist.js --confirm "法规全称" 你的姓名'
]

function main() {
  const args = process.argv.slice(2)
  initialize()

  if (args[0] === '--confirm') {
    const title = args[1]
    const who = args[2] || 'unknown'
    if (!title) {
      console.error('用法：node server/scripts/verify-law-whitelist.js --confirm "法规全称" 核对人')
      process.exit(1)
    }
    const law = findLaw(title)
    if (!law) {
      console.error(`未找到法规：${title}。先用 --all 查看现有条目名。`)
      process.exit(1)
    }
    upsertLaw({ ...law, reviewStatus: 'verified', verifiedAt: today(), verifiedBy: who })
    console.log(`✅ 已标记为已核对：《${law.title}》 by ${who} @ ${today()}`)
    close()
    return
  }

  const status = getLaborStatus()

  console.log('='.repeat(78))
  console.log('法规白名单状态')
  console.log('='.repeat(78))
  console.log(`  条目总数：${status.laws}`)
  console.log(`  已人工核对：${status.verifiedLaws}`)
  console.log(`  待人工核对：${status.pendingReviewLaws}   ← 上线前需清零`)
  console.log(`  现行有效：${status.effectiveLaws}`)
  console.log(`  案例库：${status.cases} 条${status.casesByType.length ? `（${status.casesByType.map((i) => `${i.caseType} ${i.count}`).join(' · ')}）` : ''}`)
  console.log('')

  if (args[0] === '--all') {
    console.log('全部条目：')
    listLawsForBaseline({ includeRepealed: true }).forEach((law) => {
      const mark = law.reviewStatus === 'verified' ? '✅' : '⏳'
      console.log(`  ${mark} 《${law.title}》(${law.versionLabel || '—'}) 施行 ${law.effectiveFrom}｜状态 ${law.status}`)
    })
    close()
    return
  }

  const list = listPendingReviewLaws()
  if (!list.length) {
    console.log('🎉 全部条目均已人工核对。')
  } else {
    console.log(`待核对条目（${list.length}）：`)
    list.forEach((law) => {
      console.log(`  ⏳ 《${law.title}》`)
      console.log(`      版本=${law.versionLabel || '未标注'}｜施行=${law.effectiveFrom}｜状态=${law.status}`)
      if (law.note) console.log(`      备注=${law.note}`)
    })
    console.log('')
    console.log('核对指引：')
    CHECKLIST.forEach((line) => console.log(`  ${line}`))
    console.log('')
    console.log('提示：种子数据中 review_status=verified 的条目已通过公开渠道核对；')
    console.log('      其余为通行版本，必须逐条核对后才可用于生产法条引用校验。')
  }
  close()
}

try {
  main()
} catch (error) {
  console.error('[verify-laws] 执行失败:', error.message || error)
  close()
  process.exit(1)
}
