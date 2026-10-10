// National common rules only. Local parameters must be supplied explicitly;
// this file does not assert a supported province/year or implement local transitional benefits.
export const PENSION_RULE_VERSION = 'pension-common-20261009-v1'
export const PENSION_SOURCES = Object.freeze([
  { id: 'national-pension', title: '国发〔2005〕38号：待遇公式、20%缴费与8%入账', effectiveFrom: '2005-12-03', checkedAt: '2026-10-09', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102440/c5193739/content.html' },
  { id: 'retirement-reform', title: '渐进式延迟法定退休年龄：三类人员、退休年月与最低年限', effectiveFrom: '2025-01-01', checkedAt: '2026-10-09', url: 'https://www.mot.gov.cn/hudong/xiangguanziliao/202601/t20260114_4197321.html' },
  { id: 'flexible-retirement', title: '人社部发〔2024〕94号：弹性退休及最低缴费年限对应年份', effectiveFrom: '2025-01-01', checkedAt: '2026-10-09', url: 'https://www.mohrss.gov.cn/wap/zc/zcwj/202501/t20250101_533701.html' }
])
export const PERSONAL_RATE = 0.08
export const FLEXIBLE_RATE = 0.20
export const ACCOUNT_RATE = 0.08

// Annex to 国发〔2005〕38号. Age in whole years, not a rounding policy for fractional ages.
export const PAYMENT_MONTH_TABLE = Object.freeze({
  40: 233, 41: 230, 42: 226, 43: 223, 44: 220, 45: 216, 46: 212, 47: 208,
  48: 204, 49: 199, 50: 195, 51: 190, 52: 185, 53: 180, 54: 175, 55: 170,
  56: 164, 57: 158, 58: 152, 59: 145, 60: 139, 61: 132, 62: 125, 63: 117,
  64: 109, 65: 101, 66: 93, 67: 84, 68: 75, 69: 65, 70: 56
})
