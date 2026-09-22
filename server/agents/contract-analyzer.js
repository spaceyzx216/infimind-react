import { streamChat, getProModel } from '../services/llm-client.js'
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
export async function analyzeContract(contractText, onChunk, model = getProModel()) {
  const userMessage = buildAnalysisUserMessage(contractText)

  let systemPrompt
  try {
    const { contractTypes, subTypes } = getTypeCatalogForPrompt()
    systemPrompt = buildAnalysisSystemPrompt({ contractTypes, subTypes })
  } catch (error) {
    console.warn(`[contract-analyzer] 类型目录不可用，Agent 1 将自行判断类型：${error.message}`)
    systemPrompt = buildAnalysisSystemPrompt()
  }

  let fullReport = ''

  for await (const chunk of streamChat(systemPrompt, userMessage, {
    model,
    temperature: 0.3,
    maxTokens: 8192
  })) {
    if (chunk.content) {
      fullReport += chunk.content
      if (onChunk) onChunk(chunk.content)
    }
  }

  return fullReport
}
