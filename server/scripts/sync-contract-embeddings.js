/**
 * 同步合同知识库的向量索引到 Qdrant。
 *
 * 为什么需要这个脚本：此前唯一能做向量同步的入口是 `npm run import:templates`，
 * 而它会先 `resetKnowledgeBase()` 再全量重建——在服务器上跑等于拿"源目录是否完整"
 * 赌整个知识库。部署/迁移后往往只是**新的 Qdrant 实例是空的**，需要的仅仅是灌一次向量。
 *
 * 本脚本只做向量部分：读现有 `templates.db` 里可索引的证据 → embedding → 写入 Qdrant，
 * 不触碰 templates / clauses / risk_rules 任何一行。
 *
 * 用法：
 *   node server/scripts/sync-contract-embeddings.js            # 增量写（保留已有 collection）
 *   node server/scripts/sync-contract-embeddings.js --rebuild  # 先删 collection 再重建
 *   node server/scripts/sync-contract-embeddings.js --status   # 只看状态，不写入
 */
import { initialize, listIndexableEvidence } from '../services/knowledge-base.js'
import { syncVectorIndex, getVectorStatus } from '../services/vector-store.js'

const args = process.argv.slice(2)
const rebuild = args.includes('--rebuild')
const statusOnly = args.includes('--status')

const status = getVectorStatus()
console.log('[sync-contract-embeddings] 向量服务状态:', JSON.stringify(status))

if (!status.enabled) {
  console.error('[sync-contract-embeddings] ❌ 向量服务未启用：')
  if (!status.vectorConfigured) console.error('   · 缺少 RAG_VECTOR_URL（Qdrant 地址）')
  if (!status.embeddingConfigured) console.error('   · 缺少 RAG_EMBEDDING_URL / SILICONFLOW_API_KEY')
  console.error('   词法检索不受影响，但语义召回会降级。')
  process.exit(1)
}

initialize()
const records = listIndexableEvidence()
console.log(`[sync-contract-embeddings] 可索引证据 ${records.length} 条` +
  `（条款 + 风险规则），模式=${rebuild ? '重建' : '增量'}`)

if (statusOnly) {
  console.log('[sync-contract-embeddings] --status 只读模式，未写入。')
  process.exit(0)
}

const started = Date.now()
try {
  const result = await syncVectorIndex(records, {
    rebuild,
    onProgress: ({ phase, done, total }) => {
      if (phase === 'upsert' && (done === total || done % 8 === 0)) {
        console.log(`[sync-contract-embeddings] 写入进度 ${done}/${total} 批`)
      }
    }
  })
  console.log(`[sync-contract-embeddings] ✅ 完成：${result.synced} 条向量，` +
    `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log('[sync-contract-embeddings] 验证：' +
    `curl -s ${process.env.RAG_VECTOR_URL || 'http://127.0.0.1:6333'}/collections/${status.collection}`)
} catch (error) {
  console.error(`[sync-contract-embeddings] ❌ 失败：${error.message}`)
  console.error('   词法检索不受影响；修复后可直接重跑本脚本（幂等）。')
  process.exit(1)
}
