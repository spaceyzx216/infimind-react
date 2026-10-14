import assert from 'node:assert/strict'
import { streamChat } from '../services/llm-client.js'
import { MAX_MODEL_OUTPUT_TOKENS, selectHistoryByTokens } from '../../src/utils/context-budget.js'
import { normalizeDraftHistory, normalizeDraftSnapshot, buildDraftChatMessage, runContractDraft } from '../workflows/contract-draft.js'
import { updateDraftInBlocks } from '../services/draft-block-update.js'
import { splitDocument } from '../services/document-materials.js'
import { createLaborContractFollowupWorkflow } from '../workflows/labor-contract-analysis.js'

const originalFetch = globalThis.fetch
try {
  assert.equal(splitDocument('第一条 虚构条款。\n第二条 虚构条款。\n最后一行。').length, 1, 'A fitting document must not split off its last line')
  const history = Array.from({ length: 18 }, (_, at) => ({ role: at % 2 ? 'assistant' : 'user', content: `message-${at}:` + 'x'.repeat(7000) + `TAIL-${at}` }))
  assert.deepEqual(normalizeDraftHistory(history), history)
  let captured
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/chat/completions'))
    captured = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"mock"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } })
  }
  for await (const chunk of streamChat('synthetic system', 'synthetic question', { history, thinking: { type: 'disabled' } })) void chunk
  assert.equal(captured.max_tokens, MAX_MODEL_OUTPUT_TOKENS)
  assert.deepEqual(captured.messages.slice(1, -1), history)
  const followupHistory = Array.from({ length: 18 }, (_, at) => ({ question: `虚构问答${at}`, answer: '虚构完整回复。' }))
  const longAnswer = '虚构完整答案。'.repeat(3000) + 'FOLLOWUP-TAIL'
  let followupContext
  const followupWorkflow = createLaborContractFollowupWorkflow({
    messageBuilder: (context) => JSON.stringify(context),
    generate: async (message) => { followupContext = JSON.parse(message); return { content: longAnswer, finishReason: 'stop' } }
  })
  const followupArgs = { task: { id: 'synthetic-followup', mode: 'fast' }, input: { message: '解释报告中的虚构问题' },
    report: { productId: 'labor-contract-analysis', analysisStatus: 'completed' }, history: followupHistory }
  const followup = await followupWorkflow(followupArgs)
  assert.deepEqual(followupContext.history, followupHistory, 'Labor followups must keep more than six complete pairs')
  assert.equal(followup.answer, longAnswer, 'Persisted followup answers must retain their tail beyond 16000 characters')
  const largePairs = Array.from({ length: 12 }, (_, at) => ({ question: `虚构问题${at}`, answer: '虚构内容'.repeat(16000) }))
  const capacityFollowup = await followupWorkflow({ ...followupArgs, history: largePairs })
  assert.ok(followupContext.history.length > 6 && followupContext.history.length < largePairs.length)
  assert.deepEqual(followupContext.history, largePairs.slice(-followupContext.history.length), 'Select whole pairs by actual capacity')
  assert.match(capacityFollowup.answer, /较早的.*完整问答/)
  const selected = selectHistoryByTokens(history, 8000)
  assert.ok(selected.droppedMessages > 0)
  assert.ok(selected.history.every((item) => history.some((original) => original.content === item.content)), 'Capacity selection must never cut a message')

  const longDraft = '# 虚构合同\n\n## 待确认信息\n- [ ] 虚构待确认事项\n\n## 合同正文\n' + '本条合同约定持续履行。\n'.repeat(62000) + 'TAIL-PRESERVED-END'
  assert.equal(normalizeDraftSnapshot({ draftText: longDraft }).draftText, longDraft)
  const ordinaryDraft = longDraft.slice(0, 70000) + 'NORMAL-DRAFT-TAIL'
  const chatContext = buildDraftChatMessage({ message: '解释当前草稿的尾部条款', currentDraft: { draftText: ordinaryDraft } })
  assert.ok(chatContext.userMessage.includes(ordinaryDraft), 'Draft explanation must receive its full mandatory draft after the SSE fallback')
  assert.equal(chatContext.notice, '')
  const longChatContext = buildDraftChatMessage({ message: '解释TAIL-PRESERVED-END附近条款', currentDraft: { draftText: longDraft } })
  assert.ok(longChatContext.userMessage.includes('TAIL-PRESERVED-END'), 'Over-context explanation must select a relevant tail block instead of cutting to the prefix')
  assert.ok(longChatContext.notice, 'Selected-only explanation must state its scope')
  const ordinaryResult = await runContractDraft({ task: { id: 'synthetic-update', productId: 'contract-draft', mode: 'fast', prompt: '核对虚构合同' },
    input: { operation: 'update', currentDraft: { draftText: ordinaryDraft } }, fakeLlm: false,
    classifyType: async () => ({ profile: { id: 'general_contract', label: '虚构合同', clauses: [], confirmations: [], risk: 'standard' }, confidence: 'low' }),
    streamFn: async function* (system, message) {
      assert.ok(message.includes(ordinaryDraft), 'The full current draft belongs in mandatory input, not optional history')
      yield { content: ordinaryDraft, finishReason: 'stop' }
    } })
  assert.equal(ordinaryResult.draftText, ordinaryDraft)
  const checkpoints = new Map(), submitted = []
  let failOnce = true
  const streamFn = async function* (system, message, options) {
    assert.equal(options.maxTokens, MAX_MODEL_OUTPUT_TOKENS)
    assert.equal(options.thinking.type, 'disabled')
    const context = JSON.parse(message)
    submitted.push(context.block)
    if (failOnce) { failOnce = false; yield { content: '{', finishReason: 'length' }; return }
    yield { content: JSON.stringify({ complete: true, text: context.block.text }), finishReason: 'stop' }
  }
  const result = await runContractDraft({ task: { id: 'synthetic-long-draft', productId: 'contract-draft', mode: 'fast', prompt: '核对虚构合同并保留正文' },
    input: { operation: 'update', currentDraft: { draftText: longDraft } }, fakeLlm: false, streamFn,
    classifyType: async () => ({ profile: { id: 'general_contract', label: '虚构合同', clauses: [], confirmations: [], risk: 'standard' }, confidence: 'low' }),
    checkpoint: async (key, result) => checkpoints.set(key, { result }), getCheckpoint: (key) => checkpoints.get(key) })
  assert.equal(result.draftText, longDraft)
  assert.ok(submitted.length > 2, 'Over-context drafts must go through block updates')
  const checked = checkpoints.size
  const submittedBeforeReplay = submitted.length
  const again = await updateDraftInBlocks({ currentDraft: longDraft, instruction: '核对虚构合同并保留正文', streamFn,
    mode: 'fast', ensure: () => {}, emit: async () => {}, referenceMaterials: [],
    checkpoint: async (key, result) => checkpoints.set(key, { result }), getCheckpoint: (key) => checkpoints.get(key) })
  assert.equal(again, longDraft)
  assert.equal(checkpoints.size, checked)
  assert.equal(submitted.length, submittedBeforeReplay, 'Completed blocks must not call the model again on replay')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(updateDraftInBlocks({ currentDraft: '虚构原文', ensure: () => controller.signal.throwIfAborted() }))
  console.log(`PASS context retention: eighteen full messages and followup pairs, long answer and >60000-character draft retained; over-context history selects whole pairs; over-context draft updated in ${submitted.length - 1} blocks, interrupted block retried, checkpoint replay and cancellation verified (model stub only)`)
} finally { globalThis.fetch = originalFetch }
