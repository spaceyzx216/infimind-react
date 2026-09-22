/**
 * 将 Word 合同素材递归导入合同知识库。
 *
 * 用法：node server/scripts/import-templates.js [素材目录]
 *
 * 规则：带“坏/风险批注/反例”等标识的文件作为风险反例；修订、已修改、
 * 标准等文件作为正向模板。风险反例只供识别风险模式，绝不作为条款范本。
 */
import { readdir, readFile, writeFile, mkdir } from 'fs/promises'
import { join, extname, basename, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { initialize, addTemplate, listTemplates, resetKnowledgeBase, close, resolveSubType } from '../services/knowledge-base.js'
import { extractText, extractWordAnnotations, stripNativeCommentText } from '../services/file-parser.js'
import { splitIntoClauses, extractRiskRules, extractWordAnnotationRiskRules } from '../services/knowledge-processor.js'
import { syncVectorIndex } from '../services/vector-store.js'
import { listIndexableEvidence } from '../services/knowledge-base.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx'])
const DEFAULT_SOURCE_DIR = join(__dirname, '..', '..', '法飞飞商务合同第一版20260705')

async function main() {
  const inputDir = process.argv[2] || DEFAULT_SOURCE_DIR
  const outputDir = join(__dirname, '..', 'knowledge-base', 'templates')
  const indexPath = join(__dirname, '..', 'knowledge-base', 'index.json')

  console.log(`[import-templates] Scanning recursively: ${inputDir}`)
  await mkdir(outputDir, { recursive: true })

  const docFiles = await walkDocuments(inputDir)
  if (docFiles.length === 0) {
    throw new Error(`未在目录中找到 .doc 或 .docx 文件：${inputDir}`)
  }

  console.log(`[import-templates] Found ${docFiles.length} Word documents`)
  const entries = []
  const errors = []

  for (const filePath of docFiles) {
    const sourceFile = relative(inputDir, filePath).split('\\').join('/')
    const extension = extname(filePath).toLowerCase()
    const rawName = basename(filePath, extension)
    const contractType = guessContractType(sourceFile, rawName)
    const referenceRole = guessReferenceRole(rawName)
    const pairKey = buildPairKey(rawName)
    // 子类型来自 knowledge-base/sub-types.json（数据文件，可增量维护）；查不到就是空串
    const subType = resolveSubType(sourceFile)

    process.stdout.write(`  [processing] ${sourceFile}\n`)
    try {
      const buffer = await readFile(filePath)
      const result = await extractText({
        buffer,
        originalname: basename(filePath),
        mimetype: extension === '.docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/msword'
      })
      // 仅对本次新增的劳动合同类素材提取 Word 审阅批注。
      // 批注单独写为风险规则，不当作正向模板正文。
      const wordAnnotations = contractType === '劳动合同'
        ? await extractWordAnnotations({
          buffer,
          originalname: basename(filePath),
          mimetype: extension === '.docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/msword'
        })
        : { comments: [], revisions: { insertions: 0, deletions: 0 } }
      const rawText = extension === '.doc'
        ? stripNativeCommentText(result.text, wordAnnotations.comments)
        : result.text
      const text = normalizeText(rawText, { trimLineEnd: contractType === '劳动合同' })
      if (!text) {
        errors.push(`${sourceFile}: 未提取到正文`)
        continue
      }

      const fileId = createHash('sha1').update(sourceFile).digest('hex').slice(0, 12)
      const textFile = `${fileId}-${safeFilename(rawName)}.txt`
      await writeFile(join(outputDir, textFile), text, 'utf8')
      const clauses = splitIntoClauses(text)
      const riskRules = [
        ...(referenceRole === 'annotated_case' ? extractRiskRules(text, clauses) : []),
        ...extractWordAnnotationRiskRules(wordAnnotations.comments, clauses, wordAnnotations.revisions)
      ]
      entries.push({
        name: `${contractType}｜${rawName}`,
        source_file: sourceFile,
        source_path: sourceFile,
        text_file: textFile,
        contract_type: contractType,
        sub_type: subType,
        industry: guessIndustry(sourceFile, rawName),
        description: `${referenceRole === 'annotated_case' ? '已批注风险反例' : referenceRole === 'excellent_template' ? '经修订的正向合同模板' : '合同参考资料'}：${sourceFile}`,
        reference_role: referenceRole,
        pair_key: pairKey,
        content_hash: createHash('sha256').update(text).digest('hex'),
        annotation_count: wordAnnotations.comments.length,
        revision_summary: wordAnnotations.revisions,
        clauses,
        risk_rules: riskRules,
        content: text
      })
    } catch (error) {
      errors.push(`${sourceFile}: ${error.message}`)
    }
  }

  enrichReferenceNotes(entries)

  // 素材目录是知识库的权威来源，重建可以避免历史的五份样例与新资料混杂。
  initialize()
  resetKnowledgeBase()
  for (const entry of entries) {
    addTemplate({
      name: entry.name,
      contractType: entry.contract_type,
      industry: entry.industry,
      description: entry.description,
      referenceRole: entry.reference_role,
      reviewNotes: entry.review_notes,
      sourceFile: entry.source_file,
      sourcePath: entry.source_path,
      pairKey: entry.pair_key,
      contentHash: entry.content_hash,
      subType: entry.sub_type,
      clauses: entry.clauses,
      riskRules: entry.risk_rules,
      content: entry.content
    })
  }

  const indexData = entries.map(({ content, clauses, risk_rules, ...entry }) => entry)
  await writeFile(indexPath, JSON.stringify(indexData, null, 2), 'utf8')
  console.log(`[import-templates] Imported ${listTemplates().length} templates`)
  console.log(`[import-templates] Index rebuilt: ${indexPath}`)
  try {
    const vectorResult = await syncVectorIndex(listIndexableEvidence())
    console.log(`[import-templates] Vector index: ${vectorResult.skipped ? 'not configured, lexical retrieval remains active' : `${vectorResult.synced} evidence items synced`}`)
  } catch (error) {
    // 远程向量服务是可选增强；本地 SQLite/FTS 已经完成重建时，
    // 不应因短暂网络或供应商故障把整次模板导入标记为失败。
    console.warn(`[import-templates] Vector sync failed; lexical retrieval remains active: ${error.message}`)
  }
  if (errors.length) {
    console.warn(`[import-templates] ${errors.length} files failed:`)
    errors.forEach((error) => console.warn(`  - ${error}`))
  }
  close()
}

async function walkDocuments(directory) {
  let children
  try {
    children = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`无法读取素材目录：${directory}（${error.message}）`)
  }
  const files = []
  for (const child of children) {
    if (child.name.startsWith('.')) continue
    const childPath = join(directory, child.name)
    if (child.isDirectory()) files.push(...await walkDocuments(childPath))
    if (child.isFile() && DOCUMENT_EXTENSIONS.has(extname(child.name).toLowerCase())) files.push(childPath)
  }
  return files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function guessContractType(sourceFile, name) {
  const source = `${sourceFile} ${name}`.replace(/\s/g, '')
  const types = [
    ['劳动合同', /劳动合同|劳动关系|劳务派遣|派遣员工/],
    ['融资租赁合同', /融资租赁|售后回租/],
    ['建设工程合同', /建设工程|施工合同|工程承包/],
    ['知识产权合同', /专利|知识产权|许可使用|技术转让/],
    ['物业服务合同', /物业服务|物业管理/],
    ['仓储合同', /仓储/],
    ['保管合同', /保管/],
    ['运输合同', /运输|冷链|物流|货运/],
    ['承揽合同', /承揽|定作|加工/],
    ['保证合同', /保证合同|担保合同/],
    ['借款合同', /借款|贷款/],
    ['委托合同', /委托|软件开发/],
    ['中介合同', /中介|推广服务|居间/],
    ['赠与合同', /赠与/],
    ['租赁合同', /租赁|出租|承租/],
    ['买卖合同', /买卖|销售|采购|购销/]
  ]
  return types.find(([, pattern]) => pattern.test(source))?.[0] || '通用商业合同'
}

function guessIndustry(sourceFile, name) {
  const source = `${sourceFile} ${name}`
  if (/劳动合同|劳动关系|劳务派遣|派遣员工/.test(source)) return '人力资源与劳动用工'
  if (/建设工程|施工|工程/.test(source)) return '建筑工程'
  if (/冷链|运输|物流|仓储|保管/.test(source)) return '物流仓储'
  if (/软件|专利|技术|知识产权/.test(source)) return '信息技术与知识产权'
  if (/融资租赁|借款|保证/.test(source)) return '金融与担保'
  if (/物业/.test(source)) return '物业服务'
  if (/设备|机械/.test(source)) return '设备制造'
  return '通用'
}

function guessReferenceRole(name) {
  if (/(坏|风险批注|风险分析|不良|错误|反例|修订前)/.test(name)) return 'annotated_case'
  // 素材目录中的未标“坏”的合同均为可用正向样本；只有清单、运单等辅助文件
  // 保留为普通参考，避免把它们误当成完整合同范本。
  if (/(清单|托运单|订单|交接单|签收单)/.test(name)) return 'reference'
  return 'excellent_template'
}

function buildPairKey(name) {
  return name
    .replace(/[（(][^）)]*(?:坏|修订|修改|风险)[^）)]*[）)]/g, '')
    .replace(/(?:坏\d*|修订版?|已修改|风险(?:批注|分析)?|普通货物|一般商品)/g, '')
    .replace(/[\s_—-]+/g, '')
    .replace(/^\d+(?:\.\d+)?/, '')
    .slice(0, 80) || name
}

function extractRiskNotes(text) {
  const markedNotes = [
    ...text.matchAll(/【[^】]*(?:风险批注|风险分析|批注)[^】]*】/g),
    ...text.matchAll(/（(?:风险批注|风险分析)[^）]*）/g)
  ]
    .map((match) => match[0].replace(/\s+/g, ' ').trim())
    .filter((note) => note.length >= 12)
  const unique = [...new Set(markedNotes)].slice(0, 6)
  if (!unique.length) return '已批注风险反例：仅用于发现问题、提取批注逻辑与修订方向，不能作为推荐条款。'
  return `已批注风险反例：仅提取风险模式，不能作为推荐条款。重点批注：${unique.map((note, index) => `${index + 1}. ${note}`).join('；')}`.slice(0, 1800)
}

function enrichReferenceNotes(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = `${entry.contract_type}::${entry.pair_key}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  for (const entry of entries) {
    const peers = groups.get(`${entry.contract_type}::${entry.pair_key}`) || []
    const opposite = peers.filter((peer) => peer.reference_role !== entry.reference_role).map((peer) => peer.name).slice(0, 3)
    const pairHint = opposite.length ? `；关联对照资料：${opposite.join('、')}` : ''
    const wordAnnotationHint = entry.annotation_count
      ? `；已导入 ${entry.annotation_count} 条 Word 原生批注作为独立风险证据${entry.revision_summary?.insertions || entry.revision_summary?.deletions ? `（修订：新增 ${entry.revision_summary.insertions || 0} 处，删除 ${entry.revision_summary.deletions || 0} 处）` : ''}` : ''
    entry.review_notes = entry.reference_role === 'annotated_case'
      ? `${extractRiskNotes(entry.content)}${pairHint}`
      : entry.reference_role === 'excellent_template'
        ? `正向对照模板：用于核对条款结构、履行闭环与清晰表达，不替代本合同的实际交易约定${wordAnnotationHint}${pairHint}`
        : `合同参考资料：仅在合同类型及交易背景相近时辅助核查${pairHint}`
  }
}

function normalizeText(text, { trimLineEnd = false } = {}) {
  let normalized = String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
  if (trimLineEnd) normalized = normalized.replace(/[\t ]+(?=\n|$)/g, '')
  return normalized.replace(/\n{3,}/g, '\n\n').trim()
}

function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 100)
}

main().catch((error) => {
  console.error('[import-templates] Fatal error:', error.message || error)
  close()
  process.exit(1)
})
