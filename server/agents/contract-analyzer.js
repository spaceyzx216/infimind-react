import { splitDocument, fingerprint } from '../services/document-materials.js'
import { getProModel } from '../services/llm-client.js'
import { completeCommercial } from '../services/commercial-completion.js'
import { estimateTokens } from '../../src/utils/context-budget.js'
import { buildAnalysisSystemPrompt, buildAnalysisUserMessage } from '../prompts/agent-1-analysis.js'
import { getTypeCatalogForPrompt } from '../services/knowledge-base.js'

/**
 * Agent 1: 合同结构分析
 * 流式输出分析报告
 *
 * 顺手承担「判定合同类型与子类型」——这份判定会成为后续检索的过滤键，
 * 因此把库内真实存在的类型（以及已启用过滤的主类型下的子类型）注入提示词，
 * 让模型在有限选项里挑，而不是自己造一个检索不到的名字。
 * 目录不可用时退化为不带目录的提示词，分析本身不受影响。
 *
 * @param {string} contractText - 文件解析出的合同纯文本
 * @param {function} onChunk - 每收到一个 token 时的回调
 * @returns {Promise<string>} 完整的分析报告文本
 */
export async function analyzeContract(contractText, onChunk, model = getProModel(), options = {}) {
  // Reuse stage.start to replace an unfinished preview on retry/split/merge.
  // Only a validated report is returned and written to the analysis checkpoint.
  const resetPreview = async (label = '正在重新分析合同结构与要素完整性') => {
    if (onChunk) await options.emit?.('stage.start', { stage: 'analysis', label })
  }
  const blockBudget = options.blockBudget || 6000
  const blocks = splitDocument(contractText, { budget: blockBudget })
  if (blocks.length > 1) {
    const reports = []
    for (const [index, block] of blocks.entries()) {
      options.signal?.throwIfAborted()
      const key = `commercial-analysis:${block.id}`
      const saved = (await options.getCheckpoint?.(key))?.result
      await resetPreview(`正在分析合同第 ${index + 1}/${blocks.length} 个内容块`)
      const report = saved?.report || await analyzeContract(block.text, onChunk, model, options)
      if (saved?.report && onChunk) await onChunk(saved.report)
      await options.checkpoint?.(key, { report }); reports.push(report)
    }
    let pending = reports
    while (pending.length > 1) {
      const merged = []
      for (let i = 0; i < pending.length; i += 4) {
        options.signal?.throwIfAborted()
        const key = `commercial-analysis-merge:${fingerprint(pending.slice(i, i + 4).join('\n'))}`
        const saved = (await options.getCheckpoint?.(key))?.result
        const finalMerge = pending.length <= 4
        if (finalMerge) await resetPreview('正在汇总合同结构与要素分析')
        if (saved?.report) {
          if (finalMerge && onChunk) await onChunk(saved.report)
          merged.push(saved.report); continue
        }
        const report = await completeCommercial({ ...options, stage: 'merge', key, model,
          ...(finalMerge ? { onChunk, onReset: resetPreview } : {}),
          systemPrompt: '将各内容块的结构分析汇总成一份合同结构概览，保留主体、交易条件、条款引用与冲突线索。不得补造原文；摘要只用于安排审查，不替代原文证据。',
          userMessage: pending.slice(i, i + 4).join('\n') })
        await options.checkpoint?.(key, { report })
        merged.push(report)
      }
      pending = merged
    }
    return pending[0]
  }
  const userMessage = buildAnalysisUserMessage(contractText)

  let systemPrompt
  try {
    const { contractTypes, subTypes } = getTypeCatalogForPrompt()
    systemPrompt = buildAnalysisSystemPrompt({ contractTypes, subTypes })
  } catch (error) {
    console.warn(`[contract-analyzer] 类型目录不可用，Agent 1 将自行判断类型：${error.message}`)
    systemPrompt = buildAnalysisSystemPrompt()
  }

  try {
    const report = await completeCommercial({ ...options, stage: 'analysis', key: fingerprint(contractText), model, systemPrompt, userMessage,
      onChunk, onReset: resetPreview })
    return report
  } catch (error) {
    if (['commercial_output_incomplete', 'commercial_output_invalid'].includes(error.code) && blockBudget > 1500 && estimateTokens(contractText) > 1500) {
      await options.emit?.('stage.progress', { stage: 'analysis', message: '正在把未完成的内容块拆小后继续分析。' })
      await resetPreview('正在拆分后继续分析合同结构')
      return analyzeContract(contractText, onChunk, model, { ...options, blockBudget: Math.floor(blockBudget / 2) })
    }
    throw error
  }
}
