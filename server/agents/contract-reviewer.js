import { splitDocument } from '../services/document-materials.js'
import { getProModel } from '../services/llm-client.js'
import { completeCommercial } from '../services/commercial-completion.js'
import { estimateTokens } from '../../src/utils/context-budget.js'
import { AGENT_2_SYSTEM_PROMPT, buildReviewUserMessage } from '../prompts/agent-2-review.js'

/**
 * Agent 2: 法律合规审查
 * 获取结构化审查结果。原始模型输出只在服务端校验后才会被渲染给前端，
 * 避免未完成的 JSON 或模型 Markdown 变体成为另一套批注事实来源。
 *
 * 支持多轮审查：第 2 轮起把前几轮已发现的问题摘要（previousFindings）注入提示词，
 * 引导模型补充遗漏的新问题，而非重复已有问题。
 *
 * @param {object} params
 * @param {string} params.contractText - 原始合同文本
 * @param {string} params.analysisReport - Agent 1 的分析报告
 * @param {Array} params.evidence - 知识库检索到的条款与风险证据
 * @param {object} params.reviewPlan - 受控审查检索计划
 * @param {string} params.userInstruction - 用户额外关注点
 * @param {number} params.round - 当前审查轮次（1 起始）
 * @param {Array} params.previousFindings - 前几轮已发现问题的摘要 [{ level, title, location }]
 * @param {object|null} params.wholeTemplate - 整份对口范本（结构参照通道，非风险证据；见 knowledge-base.getWholeTemplateForReview）
 * @returns {Promise<string>} 模型返回的完整 JSON 文本
 */
export async function reviewContract({ contractText, analysisReport, evidence, reviewPlan, userInstruction, round = 1, previousFindings = [], wholeTemplate = null, signal, checkpoint = async () => {}, getCheckpoint = () => null, mode = 'thinking', emit, blockBudget = 6000, checkpointScope = 'review' }, model = getProModel()) {
  const blocks = splitDocument(contractText, { budget: blockBudget })
  if (blocks.length > 1) {
    const outputs = []
    for (const block of blocks) {
      signal?.throwIfAborted()
      const key = `commercial-${checkpointScope}:${round}:${block.id}`
      const saved = (await getCheckpoint(key))?.result
      await checkpoint('material-coverage', { parsed: blocks.length, selected: blocks.slice(0, outputs.length + 1).map((b) => b.id),
        entered: blocks.slice(0, outputs.length + 1).map((b) => b.id), checked: blocks.slice(0, outputs.length).map((b) => b.id), round,
        partial: true, phase: 'review' })
      const output = saved?.output || await reviewContract({ contractText: block.text, analysisReport, evidence, reviewPlan,
        userInstruction: `${userInstruction || ''}\n当前为全文内容块，不能因本块未出现某项约定就判断全文缺失。原文字符范围${block.start + 1}-${block.end}。`,
        round, previousFindings, wholeTemplate, signal, checkpoint, getCheckpoint, mode, emit, blockBudget, checkpointScope }, model)
      const parsed = JSON.parse(output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
      if (!Array.isArray(parsed.findings) || !Array.isArray(parsed.completeness)) throw new Error('合同内容块未返回完整审查结构')
      await checkpoint(key, { output, start: block.start, end: block.end })
      outputs.push(parsed)
      await checkpoint('material-coverage', { parsed: blocks.length, selected: blocks.slice(0, outputs.length).map((b) => b.id),
        entered: blocks.slice(0, outputs.length).map((b) => b.id), checked: blocks.slice(0, outputs.length).map((b) => b.id), round,
        partial: outputs.length !== blocks.length, phase: 'review' })
    }
    return JSON.stringify({ ...outputs[0], findings: outputs.flatMap((o) => o.findings || []),
      completeness: outputs.flatMap((o) => Array.isArray(o.completeness) ? o.completeness : []),
      conclusion: outputs.map((o) => o.conclusion || '').join('\n') })
  }
  const userMessage = buildReviewUserMessage({
    contractText,
    analysisReport,
    evidence,
    reviewPlan,
    userInstruction,
    round,
    previousFindings,
    wholeTemplate
  })

  try {
    return await completeCommercial({ stage: 'review', systemPrompt: AGENT_2_SYSTEM_PROMPT, userMessage, model, mode, signal, checkpoint, emit,
      key: `${checkpointScope}:${round}:${blocks[0]?.id || 'empty'}`,
      validate: (output) => {
        const parsed = JSON.parse(output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
        if (!Array.isArray(parsed.findings) || !Array.isArray(parsed.completeness)) throw new Error('合同内容块未返回完整审查结构')
        return JSON.stringify(parsed)
      } })
  } catch (error) {
    if (['commercial_output_incomplete', 'commercial_output_invalid'].includes(error.code) && blockBudget > 1500 && estimateTokens(contractText) > 1500) {
      await emit?.('stage.progress', { stage: 'review', message: '正在把未完成的内容块拆小后继续核对。' })
      return reviewContract({ contractText, analysisReport, evidence, reviewPlan, userInstruction, round, previousFindings, wholeTemplate,
        signal, checkpoint, getCheckpoint, mode, emit, blockBudget: Math.floor(blockBudget / 2), checkpointScope }, model)
    }
    throw error
  }
}
