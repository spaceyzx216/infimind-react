/**
 * 用工咨询知识库向量索引构建脚本（硅基流动 BAAI/bge-m3）。
 *
 * 用法：
 *   node server/scripts/build-labor-embeddings.js            # 增量（只处理缺失/变更的条目）
 *   node server/scripts/build-labor-embeddings.js --force    # 全量重建
 *   node server/scripts/build-labor-embeddings.js --status   # 只看状态
 *
 * 说明：
 *   - 向量存于 labor.db 的 labor_kb_embeddings 表（BLOB），进程内暴力余弦检索；
 *   - 按内容哈希判重，正文变更或切换 embedding 模型后会自动重建对应条目；
 *   - 调用硅基流动会消耗少量额度，全量 764 条约数万 token。
 */
import { initializeLaborKb } from '../services/labor-kb.js'
import { initializeLaborVector, buildEmbeddings, getLaborVectorStatus, resetIndexCache } from '../services/labor-vector.js'
import { getRetrievalHealth } from '../services/siliconflow-client.js'
import { close } from '../services/law-whitelist.js'

async function main() {
  const args = process.argv.slice(2)
  initializeLaborKb()
  initializeLaborVector()

  if (args.includes('--status')) {
    console.log('[embed] 向量索引状态：')
    console.log('  ' + JSON.stringify(getLaborVectorStatus(), null, 2).replace(/\n/g, '\n  '))
    console.log('  运行时健康：' + JSON.stringify(getRetrievalHealth().embedding))
    close()
    return
  }

  const force = args.includes('--force')
  const status = getLaborVectorStatus()
  console.log(`[embed] 模型 ${status.model}｜条目 ${status.entries}｜已向量化 ${status.embedded}（覆盖 ${(status.coverage * 100).toFixed(1)}%）`)
  if (!status.configured) {
    throw new Error('未配置 SILICONFLOW_API_KEY，无法构建向量索引')
  }
  if (force) console.log('[embed] --force：将重建全部条目向量')

  const started = Date.now()
  const result = await buildEmbeddings({
    force,
    onProgress: ({ done, total }) => {
      if (done % 60 === 0 || done === total) process.stdout.write(`\r  进度 ${done}/${total}`)
    }
  })
  process.stdout.write('\n')

  const after = getLaborVectorStatus()
  console.log(`[embed] 完成：本次向量化 ${result.embedded} 条，跳过 ${result.skipped} 条，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`[embed] 当前覆盖：${after.embedded}/${after.entries}（${(after.coverage * 100).toFixed(1)}%），维度 ${after.dimension}`)
  const health = getRetrievalHealth().embedding
  console.log(`[embed] 调用统计：成功 ${health.ok}｜失败 ${health.failed}｜降级 ${health.degraded}${health.lastError ? `｜最后错误 ${health.lastError}` : ''}`)

  resetIndexCache()
  close()
}

main().catch((error) => {
  console.error('[embed] 构建失败:', error.message || error)
  close()
  process.exit(1)
})
