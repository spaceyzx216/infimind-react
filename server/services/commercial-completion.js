import { streamChat, getProModel } from './llm-client.js'
import { MAX_MODEL_OUTPUT_TOKENS } from '../../src/utils/context-budget.js'

const LABELS = { analysis: '合同结构分析', review: '合同风险审查', rewrite: '条款修订', consolidation: '问题归并', merge: '结构汇总' }
// DeepSeek Flash's documented per-response ceiling. This is a ceiling, not
// a target; only generated tokens are billed. Split/validation still applies.
export const MAX_COMMERCIAL_OUTPUT_TOKENS = MAX_MODEL_OUTPUT_TOKENS

export function commercialPhaseOptions(mode, stage) {
  const thinking = mode !== 'fast' && !['consolidation', 'merge'].includes(stage)
  return {
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    ...(thinking ? { reasoningEffort: stage === 'review' ? 'high' : 'low' } : {}),
    maxTokens: MAX_COMMERCIAL_OUTPUT_TOKENS,
    requestTimeoutMs: thinking ? 300000 : 180000,
    maxAttempts: 1
  }
}

// One repair attempt per block; callers split a persistently incomplete block.
// Failed attempts never become successful reports or publish broken JSON.
export async function completeCommercial({ stage, systemPrompt, userMessage, model = getProModel(),
  mode = 'thinking', signal, checkpoint, emit, onChunk, onReset, validate = (text) => text, key = stage }) {
  const profile = commercialPhaseOptions(mode, stage)
  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal?.throwIfAborted()
    let content = '', finishReason = null, usage = null, pending = '', lastFlush = Date.now()
    const flush = async () => {
      if (!pending) return
      const delta = pending
      pending = ''
      lastFlush = Date.now()
      await onChunk?.(delta)
    }
    const maxTokens = profile.maxTokens
    try {
      if (attempt > 1) await onReset?.()
      for await (const chunk of streamChat(systemPrompt,
        userMessage + (attempt === 2 ? '\n\n上次输出未完整结束或格式不合要求。本次保持完整必要字段，压缩重复说明，完整闭合输出；不要重复思考过程。' : ''),
        { model, ...profile, maxTokens, signal, ...(stage === 'review' || stage === 'rewrite' ? { responseFormat: { type: 'json_object' } } : {}) })) {
        content += chunk.content || ''
        // Markdown previews can stream; structured JSON callers remain buffered
        // until validated. Batch writes to the durable event store.
        if (onChunk && chunk.content) {
          pending += chunk.content
          if (pending.length >= 512 || Date.now() - lastFlush >= 80) await flush()
        }
        if (chunk.finishReason) finishReason = chunk.finishReason
        if (chunk.usage) usage = chunk.usage
      }
      signal?.throwIfAborted()
      await checkpoint?.(`commercial-completion:${key}`, { stage, attempt, maxTokens, finishReason, usage })
      if (finishReason !== 'stop' || !content.trim()) {
        throw Object.assign(new Error(`${LABELS[stage]}本次未完整返回`), { code: 'commercial_output_incomplete' })
      }
      let result
      try { result = validate(content) } catch (cause) {
        throw Object.assign(new Error(`${LABELS[stage]}返回格式无法校验`, { cause }), { code: 'commercial_output_invalid' })
      }
      await flush()
      return result
    } catch (error) {
      signal?.throwIfAborted()
      if (error.code === 'LLM_REQUEST_ABORTED' || error.code === 'material_context_overflow') throw error
      lastError = error
      if (attempt === 1) await emit?.('stage.progress', { stage, message: `${LABELS[stage]}正在补全本次输出，已完成的内容块保留。` })
    }
  }
  throw Object.assign(new Error(`${LABELS[stage]}重试后仍未完整返回，已完成内容块保留。`, { cause: lastError }), {
    code: lastError?.code || 'commercial_output_incomplete', retryable: false
  })
}
