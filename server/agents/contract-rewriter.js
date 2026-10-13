import { MAX_MODEL_OUTPUT_TOKENS } from '../../src/utils/context-budget.js'
import { selectMaterialBlocks, formatMaterialBlocks } from '../services/document-materials.js'
import { streamChat, getProModel } from '../services/llm-client.js'
import { completeCommercial } from '../services/commercial-completion.js'
import { AGENT_3_SYSTEM_PROMPT, buildRewriteUserMessage } from '../prompts/agent-3-rewrite.js'

/**
 * Agent 3: 合同条款修订
 * 对每条风险批注给出结构化修订指令（action/rewrittenText/riskNote）。
 *
 * 注意：本 Agent 不再输出完整合同全文，而是输出一个 JSON 对象 { revisions: [...] }。
 * 原句、行号等可信字段由服务端从 finding 强制注入（见 revision-merger.js），
 * 本函数只返回模型产出的完整 JSON 文本，交由 revision-merger 配对校验。
 *
 * @param {object} params
 * @param {string} params.contractText - 原始合同文本
 * @param {string} params.analysisReport - Agent 1 分析报告
 * @param {string} params.reviewReport - Agent 2 审查报告（结构化 findings 不可用时回退使用）
 * @param {Array} params.findings - 服务端定位校验后的 findings（含 findingId、originalText、lineStart/lineEnd）
 * @param {function} onChunk - 每收到一个 token 时的回调（用于前端进度提示，非逐字展示）
 * @returns {Promise<string>} 模型返回的完整 JSON 文本
 */
export async function rewriteContract({ contractText, analysisReport, reviewReport, findings, completedRevisions = [] }, onChunk, model = getProModel(), { systemPromptSuffix = '', requireComplete = false, commercialMode, ...completionOptions } = {}) {
  if (contractText.length > 24000) contractText = formatMaterialBlocks(selectMaterialBlocks([{ name: '合同原文', text: contractText }], JSON.stringify(findings), 24000).blocks)
  const userMessage = buildRewriteUserMessage({
    contractText,
    analysisReport,
    reviewReport,
    findings
  })

  let fullOutput = ''
  let finishReason = null

  const systemPrompt = systemPromptSuffix ? `${AGENT_3_SYSTEM_PROMPT}\n\n${systemPromptSuffix}` : AGENT_3_SYSTEM_PROMPT
  const context = completedRevisions.length ? `\n\n其他组已完成的修订（只用于一致性检查，不重复输出）：${JSON.stringify(completedRevisions.map(({ findingId, rewrittenText, action }) => ({ findingId, rewrittenText, action })))}` : ''
  if (commercialMode) {
    const output = await completeCommercial({ ...completionOptions, stage: 'rewrite', mode: commercialMode, model, systemPrompt,
      userMessage: userMessage + context,
      validate: (raw) => {
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
        if (!Array.isArray(parsed.revisions)) throw new Error('修订结果缺少 revisions')
        return JSON.stringify(parsed)
      } })
    if (onChunk) onChunk(output)
    return output
  }
  for await (const chunk of streamChat(systemPrompt, userMessage + context, {
    model,
    temperature: 0.3,
    // 每条 revision 含完整改写条款（30~150 字）+ 批注（30~80 字），13 条约需 6~10k tokens。
    // 预留充足空间避免输出被 maxTokens 截断导致 JSON 不完整。
    maxTokens: MAX_MODEL_OUTPUT_TOKENS,
    ...completionOptions
  })) {
    if (chunk.finishReason) finishReason = chunk.finishReason
    if (chunk.content) {
      fullOutput += chunk.content
      if (onChunk) onChunk(chunk.content)
    }
    if (requireComplete && finishReason === 'stop') break
  }

  if (requireComplete && finishReason === 'length') {
    const error = new Error('局部修订输出达到模型长度上限')
    error.code = 'rewrite_output_truncated'
    throw error
  }
  if (requireComplete && finishReason !== 'stop') {
    throw Object.assign(new Error('局部修订连接未完整结束'), { code: 'labor_revision_incomplete', retryable: true })
  }
  return fullOutput
}

