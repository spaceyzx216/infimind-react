import { MAX_MODEL_OUTPUT_TOKENS } from '../../src/utils/context-budget.js'
import { chat, getProModel } from '../services/llm-client.js'
import { AGENT_4_SYSTEM_PROMPT, buildConsolidationUserMessage } from '../prompts/agent-4-consolidation.js'

/**
 * 归并 Agent：只判断已定位 findings 的分组关系，不改写、不增删问题。
 * 输出由 finding-consolidator.js 做 ID 覆盖和定位兼容性校验。
 */
export async function consolidateContractFindings(findings = [], model = getProModel(), options = {}) {
  return chat(AGENT_4_SYSTEM_PROMPT, buildConsolidationUserMessage(findings), {
    model,
    temperature: 0,
    maxTokens: MAX_MODEL_OUTPUT_TOKENS,
    ...options
  })
}
