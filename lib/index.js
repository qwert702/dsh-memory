//#region lib/index.js
/**
 * Memory plugin, node half. Long-term memory for the DeepSeek Harness:
 *
 *   - Two scopes: one store per project workspace (keyed by a hash of the
 *     session cwd) plus one global store, both plain JSON files under
 *     `<dsh-home>/memory/` committed through the atomic-write service.
 *   - Injection: a global `system-prompt/assemble` waterfall listener appends
 *     a memory briefing (top items by recency x reinforcement x degree under
 *     a character cap) to every assembled prompt as an extra dynamic context.
 *     Assemblies without a session cwd still receive global memories, and any
 *     failure in this path returns the assembly untouched — injection can
 *     never break a request.
 *   - Extraction: a root `session/event` listener watches `turn/end`, queues
 *     the session, and asks the small model (settings override pair, else the
 *     conversation's own routed model — the same convention as
 *     dsh-context-compressor) to distill durable facts into JSON candidates;
 *     near-duplicates reinforce the existing memory instead of duplicating it.
 *     Three consecutive failures pause auto-extraction until a manual run
 *     succeeds.
 *   - Consolidation: after N extracted turns per scope (or on manual trigger)
 *     the small model proposes ops (merge / link / archive / retag) that are
 *     id-validated against the inventory and applied transactionally.
 *
 * Auxiliary calls never enter any session transcript; they go through
 * ctx.llm, which resolves provider credentials server-side.
 */
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage, contentHasImage } from '@deepseek-ai/dsh-llm'
import { mkdir, readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import path from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { similarity, DEDUPE_THRESHOLD, MEMORY_TYPES, MAX_CONTENT_CHARS, projectKeyFor, selectBriefing, parseCandidates, parseOps, buildTranscript, resolveRoute, resolveManageRoute, tokenize, messageText } from './util.js'
import { EmbedderManager, VectorStore, cosine } from './embeddings.js'
import { MemoryStore, PluginState, wireItem, newId } from './store.js'

/** Cordis plugin name for the host half. */
const name = 'dsh-memory-host'
/** Services: routes, settings namespace, live sessions (cwd + replay), and the auxiliary-model caller. */
const inject = ['webServer', 'settings', 'sessions', 'llm']

/** Settings namespace holding the memory configuration. */
const NS = 'dsh-memory'
/** Schema: switches, the optional small-model route override, cadence, caps. */
const SCHEMA = z.object({
  enabled: z.boolean().default(true),
  injectEnabled: z.boolean().default(true),
  autoExtract: z.boolean().default(true),
  extractProvider: z.string().default('').description('提取模型 provider（留空跟随会话模型）'),
  extractModel: z.string().default('').description('提取模型 id（与 provider 成对填写）'),
  manageProvider: z.string().default('').description('管理/整理模型 provider（留空则用提取模型）'),
  manageModel: z.string().default('').description('管理/整理模型 id（与 provider 成对填写）'),
  consolidateEveryTurns: z.number().step(1).min(0).default(20),
  topK: z.number().step(1).min(1).max(32).default(8),
  maxInjectChars: z.number().min(200).default(1500),
  maxInputChars: z.number().min(2000).default(12000),
  maxTokens: z.number().min(256).default(1024),
  autoArchiveDays: z.number().step(1).min(0).default(90),
  memoryLocale: z.string().default(''),
  embeddingsEnabled: z.boolean().default(true),
  embeddingRemoteHost: z.string().default('').description('HuggingFace 镜像地址（国内可用 https://hf-mirror.com）'),
  autoLinkThreshold: z.number().step(0.01).min(0).max(1).default(0.78).description('整理时自动建链的相似度阈值（0=关闭）'),
})
/** Composition defaults when the settings namespace is absent. */
const DEFAULTS = {
  enabled: true,
  injectEnabled: true,
  autoExtract: true,
  extractProvider: '',
  extractModel: '',
  manageProvider: '',
  manageModel: '',
  consolidateEveryTurns: 20,
  topK: 8,
  maxInjectChars: 1500,
  maxInputChars: 12000,
  maxTokens: 1024,
  autoArchiveDays: 90,
  memoryLocale: '',
  embeddingsEnabled: true,
  embeddingRemoteHost: '',
  autoLinkThreshold: 0.78,
}

/** Rolling per-session recent-user-text buffer for relevance scoring. */
const RECENT_CHARS = 2000
const RECENT_SESSIONS_MAX = 200

/** Reject bodies over 256 KiB before buffering. */
const MAX_BODY_BYTES = 256 * 1024
/** Consecutive extraction failures that pause automatic extraction. */
const PAUSE_AFTER_FAILURES = 3
/** Driver-classification table cap; both machine and human branches evict true-LRU style. */
const SESSION_KINDS_MAX = 500

/**
 * Record one session's driver classification. Delete-before-set refreshes
 * recency (Map iteration order = true LRU order), and the oldest entry is
 * evicted once the table hits its cap, so neither the machine nor the human
 * branch can grow the table without bound on a months-long harness.
 */
function setSessionKind(sessionKinds, sessionId, kind) {
  sessionKinds.delete(sessionId)
  if (sessionKinds.size >= SESSION_KINDS_MAX) {
    const oldest = sessionKinds.keys().next().value
    if (oldest !== undefined) sessionKinds.delete(oldest)
  }
  sessionKinds.set(sessionId, kind)
}

//#region prompts -------------------------------------------------------------
/** Extraction directive appended after the replayed conversation tail. */
function extractInstruction(existingLines, memoryLocale) {
  const localeLine = memoryLocale === 'zh'
    ? '记忆内容一律使用中文书写。'
    : memoryLocale === 'en'
      ? 'Write every memory in English.'
      : '记忆内容使用这段对话的主要语言书写。'
  const base = [
    '你在为一个人工智能助手的长期记忆系统工作。上面是一段对话记录。',
    '请从中提取值得长期记住的信息（用户的事实与偏好、项目的决定与约定、可复用的经验模式、重要实体）。',
  ]
  if (existingLines.length > 0) {
    base.push(
      '下面是已有的相关记忆清单（方括号里是记忆 id）。每条新记忆必须先和它们对照，用 action 字段说明关系：',
      ...existingLines,
      '- {"action":"add",...}：全新信息，现有清单没有覆盖；',
      '- {"action":"update","targetId":"<id>",...}：对某条既有记忆的修正/补充，content 给出合并后的完整表述；',
      '- {"action":"supersede","targetId":"<id>",...}：取代某条过时记忆（如偏好已改变），content 是新表述；',
      '- {"action":"contradict","targetId":"<id>",...}：与某条记忆冲突但两者都值得保留（不同场景/条件），content 是新表述。',
    )
  }
  base.push(
    '输出一个 JSON 数组（最多 6 条）：',
    '[{"content":"一句话记忆","type":"fact|preference|decision|pattern|entity","tags":["标签"],"action":"add","targetId":null}]',
    '要求：',
    '- 只提取持久信息：忽略一次性任务细节、寒暄、具体代码内容本身；',
    '- 每条一句话、不超过 80 字、脱离对话也能独立理解；',
    '- targetId 只能取清单里存在的 id；没有相关既有记忆时 action 用 "add"、targetId 用 null；',
    `- ${localeLine}`,
    '- 没有值得记住的就输出 []；只输出 JSON 数组本身，不要任何解释或代码块标记。',
  )
  return base.join('\n')
}

/**
 * Consolidation directive: the numbered inventory follows this message, and
 * the model must answer with an ops object.
 */
const CONSOLIDATE_INSTRUCTION = [
  '你在为长期记忆系统做定期整理。下面是某个作用域的现有记忆清单（方括号里是记忆 id）。',
  '请整理它们并输出操作列表，格式：{"ops":[...]}，可用操作：',
  '- {"op":"merge","into":"<保留项id>","from":["<被并入id>",...],"content":"合并后的新表述"} —— 同义/过时项合并成一条更准确的表述；',
  '- {"op":"link","a":"<idA>","b":"<idB>","kind":"related|supersedes|contradicts"} —— 补充有意义的关联；',
  '- {"op":"archive","id":"<id>"} —— 归档已失效或重复的记忆；',
  '- {"op":"retag","id":"<id>","tags":["新标签",...]} —— 修正标签。',
  '要求：',
  '- 只在确有问题时动手：宁缺毋滥，通常 0~6 个操作；',
  '- merge 的 content 必须融合各方信息且不超过 80 字；',
  '- 不要发明清单之外的 id；',
  '- 只输出 {"ops":[...]} 本身，不要解释或代码块标记。',
].join('\n')
//#endregion

//#region auxiliary model call --------------------------------------------------
/**
 * Map a terminal auxiliary-call finish to its fail-closed error (same shapes
 * as dsh-context-compressor).
 */
function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'auxiliary call failed')
      error.code = finish.failure?.code
      return error
    }
    case 'max-tokens': return new Error('auxiliary call truncated at the token cap')
    default: return undefined
  }
}

/**
 * Run one auxiliary text call through ctx.llm.stream.
 * @param llm - the harness llm service.
 * @param options - provider/model/messages/maxTokens.
 * @returns the concatenated assistant text.
 */
async function callModel(llm, options) {
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({ ...options, purpose: 'compaction' })) assembler.push(chunk)
  const error = finishError(assembler.finish ?? { kind: 'stop' })
  if (error !== undefined) throw error
  const blocks = assembler.blocks()
  if (contentHasImage(blocks)) throw new Error('auxiliary call produced image output')
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text ?? ''
  }
  if (text.trim() === '') throw new Error('auxiliary call produced no text')
  return text
}
//#endregion

//#region pipelines -------------------------------------------------------------
/** Shared mutable runtime for the listeners, pipelines, and routes. */
function createRuntime(ctx, config) {
  return {
    ctx,
    config,
    store: new MemoryStore(),
    state: new PluginState(),
    extractQueue: [],
    extractRunning: false,
    extractManualBusy: false,
    consolidateQueue: [],
    consolidateRunning: false,
    consolidateManualBusy: false,
    vectors: new VectorStore(),
    embedder: new EmbedderManager(),
    embedQueue: [],
    embedRunning: false,
    embedActive: Promise.resolve(),
    sessionKinds: new Map(),
    commanderGuideBusy: new Set(),
    consecutiveFailures: 0,
    paused: false,
    disposed: false,
    lastError: '',
    // Resolved once the durable state (cursors/counters) has been hydrated;
    // pipelines gate on it so an early turn never runs against empty state.
    ready: null,
  }
}

/**
 * Enqueue one session for memory extraction (deduplicated) and start the drain.
 * @param runtime - host runtime.
 * @param sessionId - the finished session.
 */
function enqueueExtraction(runtime, sessionId) {
  if (!runtime.extractQueue.includes(sessionId)) runtime.extractQueue.push(sessionId)
  void drainExtraction(runtime)
}

/**
 * Serially drain the extraction queue. Failures count toward the pause
 * threshold; successes reset the counter.
 */
async function drainExtraction(runtime) {
  if (runtime.extractRunning || runtime.extractManualBusy || runtime.disposed) return
  runtime.extractRunning = true
  try {
    await runtime.ready
    while (runtime.extractQueue.length > 0 && !runtime.disposed) {
      const sessionId = runtime.extractQueue.shift()
      try {
        await extractSession(runtime, sessionId, false)
      } catch (error) {
        runtime.consecutiveFailures += 1
        runtime.lastError = error instanceof Error ? error.message : String(error)
        if (runtime.consecutiveFailures >= PAUSE_AFTER_FAILURES) runtime.paused = true
      }
    }
  } finally {
    runtime.extractRunning = false
  }
}

/**
 * Extract memories from one session's events newer than its cursor.
 * @param runtime - host runtime.
 * @param sessionId - target session.
 * @param force - replay a recent tail even when the cursor is current.
 * @returns `{added, reinforced}` counters.
 */
async function extractSession(runtime, sessionId, force) {
  const config = runtime.config()
  const session = runtime.ctx.sessions.get(sessionId)
  if (session === undefined || config.enabled !== true) return { added: 0, reinforced: 0 }
  // Subagent sessions are working memory, not durable knowledge — never extract.
  const headerMeta = session.header ?? {}
  if (headerMeta.origin === 'subagent' || (headerMeta.delegationDepth ?? 0) > 0) return { added: 0, reinforced: 0 }
  // Machine-driven sessions (commander workers): every user turn is a
  // dispatched briefing, so extracting them floods the store with task spam.
  // Manual extraction (force) stays available as an explicit override.
  if (!force && runtime.sessionKinds.get(sessionId) === 'machine') return { added: 0, reinforced: 0, skipped: 'machine' }
  const cwd = session.header?.cwd
  const storeKey = cwd === undefined ? 'global' : projectKeyFor(cwd)
  const lastEventSeq = session.events.at(-1)?.seq ?? 0
  const sinceSeq = force ? Math.max(0, lastEventSeq - 40) : runtime.state.cursors[sessionId] ?? 0
  const { text } = buildTranscript(session, sinceSeq, config.maxInputChars)
  if (text.trim() === '') {
    if (!force) runtime.state.setCursor(sessionId, lastEventSeq)
    return { added: 0, reinforced: 0 }
  }
  const header = session.requestHeader?.() ?? undefined
  const route = resolveRoute(config, header)
  if (route === undefined) {
    throw Object.assign(new Error('no provider/model for extraction: configure dsh-memory.extractProvider/extractModel, or send one message in the conversation first'), { code: 'no-route' })
  }
  // Related existing memories go into the prompt so the model can classify
  // each candidate as add/update/supersede/contradict instead of duplicating.
  const existingItems = await runtime.store.list(storeKey)
  const existingActive = existingItems.filter((item) => item.status === 'active')
  const transcriptTokens = tokenize(text.slice(-RECENT_CHARS))
  const related = [...existingActive]
    .map((item) => ({ item, score: similarityOfTranscript(item, transcriptTokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .filter((entry) => entry.score > 0)
    .map((entry) => entry.item)
  const existingLines = related.length > 0
    ? related.map((item) => `- [${item.id}] ${item.content}`)
    : []
  const reply = await callModel(runtime.ctx.llm, {
    provider: route.provider,
    model: route.model,
    maxTokens: config.maxTokens,
    messages: [createUserMessage({
      content: [{ type: 'text', text: `${text}\n\n${extractInstruction(existingLines, config.memoryLocale)}` }],
      source: { kind: 'plugin', plugin: 'dsh-memory' },
    })],
  })
  const candidates = parseCandidates(reply)
  let added = 0
  let reinforced = 0
  let updated = 0
  const touchedIds = []
  for (const candidate of candidates) {
    const result = await runtime.store.applyCandidate(storeKey, {
      content: candidate.content,
      type: candidate.type,
      tags: candidate.tags,
      origin: 'auto',
      sourceSessionId: sessionId,
      ...(storeKey === 'global' || cwd === undefined ? {} : { cwd }),
    }, candidate.action, candidate.targetId)
    if (result.relation === 'created' || result.relation === 'superseded' || result.relation === 'contradicted') added += 1
    else if (result.relation === 'updated') updated += 1
    else reinforced += 1
    touchedIds.push(result.item.id)
  }
  if (touchedIds.length > 0) enqueueEmbed(runtime, storeKey, touchedIds)
  runtime.state.setCursor(sessionId, Math.max(lastEventSeq, sinceSeq))
  runtime.consecutiveFailures = 0
  runtime.paused = false
  runtime.lastError = ''
  if ((added > 0 || updated > 0) && config.consolidateEveryTurns > 0) {
    const turns = runtime.state.bumpTurn(storeKey)
    if (turns >= config.consolidateEveryTurns) enqueueConsolidation(runtime, storeKey)
  }
  return { added, reinforced, updated }
}

/**
 * Distill one conversation message into memories ("记住这条" backend).
 * Finds the message by id in the session log, replays just it, and runs the
 * extractor over it.
 * @param runtime - host runtime.
 * @param sessionId - the owning session.
 * @param messageId - the assistant message id to remember.
 * @returns `{added, reinforced, updated}` counters.
 */
async function distillMessage(runtime, sessionId, messageId) {
  const config = runtime.config()
  const session = runtime.ctx.sessions.get(sessionId)
  if (session === undefined || config.enabled !== true) throw Object.assign(new Error('session not found'), { code: 'session-not-found' })
  let targetEvent
  for (const event of session.events) {
    if (event.type !== 'assistant/message' && event.type !== 'user/message') continue
    const candidate = event.data?.message ?? {}
    if (candidate.id === messageId || event.data?.id === messageId) { targetEvent = event; break }
  }
  if (targetEvent === undefined) throw Object.assign(new Error('message not found in this session'), { code: 'message-not-found' })
  const cwd = session.header?.cwd
  const storeKey = cwd === undefined ? 'global' : projectKeyFor(cwd)
  const derived = session.deriveEventMessage?.(targetEvent) ?? targetEvent.data?.message
  const text = messageText(derived).trim()
  if (text === '') throw Object.assign(new Error('message has no text to remember'), { code: 'empty' })
  const header = session.requestHeader?.() ?? undefined
  const route = resolveRoute(config, header)
  if (route === undefined) throw Object.assign(new Error('no provider/model configured'), { code: 'no-route' })

  const existingItems = (await runtime.store.list(storeKey)).filter((item) => item.status === 'active')
  const textTokens = tokenize(text)
  const existingLines = [...existingItems]
    .map((item) => ({ item, score: similarityOfTranscript(item, textTokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .filter((entry) => entry.score > 0)
    .map((entry) => `- [${entry.item.id}] ${entry.item.content}`)

  const reply = await callModel(runtime.ctx.llm, {
    provider: route.provider,
    model: route.model,
    maxTokens: config.maxTokens,
    messages: [createUserMessage({
      content: [{ type: 'text', text: `${text}\n\n${extractInstruction(existingLines, config.memoryLocale)}` }],
      source: { kind: 'plugin', plugin: 'dsh-memory' },
    })],
  })
  const candidates = parseCandidates(reply)
  let added = 0
  let reinforced = 0
  let updated = 0
  const touchedIds = []
  for (const candidate of candidates) {
    const result = await runtime.store.applyCandidate(storeKey, {
      content: candidate.content,
      type: candidate.type,
      tags: candidate.tags,
      origin: 'manual',
      sourceSessionId: sessionId,
      ...(storeKey === 'global' || cwd === undefined ? {} : { cwd }),
    }, candidate.action, candidate.targetId)
    if (result.relation === 'created' || result.relation === 'superseded' || result.relation === 'contradicted') added += 1
    else if (result.relation === 'updated') updated += 1
    else reinforced += 1
    touchedIds.push(result.item.id)
  }
  if (touchedIds.length > 0) enqueueEmbed(runtime, storeKey, touchedIds)
  return { added, reinforced, updated }
}

/**
 * Cheap lexical overlap between one item and the transcript tokens, used to
 * pick which existing memories join the extraction prompt.
 */
function similarityOfTranscript(item, transcriptTokens) {
  if (transcriptTokens.size === 0) return 0
  const itemTokens = tokenize(item.content + ' ' + item.tags.join(' '))
  let shared = 0
  for (const token of itemTokens) { if (transcriptTokens.has(token)) shared += 1 }
  return shared / Math.max(itemTokens.size, 1)
}

/**
 * Enqueue one scope for consolidation (deduplicated).
 * @param runtime - host runtime.
 * @param storeKey - the scope to consolidate.
 */
function enqueueConsolidation(runtime, storeKey) {
  if (!runtime.consolidateQueue.includes(storeKey)) runtime.consolidateQueue.push(storeKey)
  void drainConsolidation(runtime)
}

/**
 * Serially drain the consolidation queue.
 */
async function drainConsolidation(runtime) {
  if (runtime.consolidateRunning || runtime.consolidateManualBusy || runtime.disposed) return
  runtime.consolidateRunning = true
  try {
    await runtime.ready
    while (runtime.consolidateQueue.length > 0 && !runtime.disposed) {
      const storeKey = runtime.consolidateQueue.shift()
      try {
        await consolidateScope(runtime, storeKey, undefined)
      } catch (error) {
        runtime.lastError = error instanceof Error ? error.message : String(error)
      }
    }
  } finally {
    runtime.consolidateRunning = false
  }
}

/**
 * Ask the small model to tidy one scope, then apply the id-validated ops.
 * @param runtime - host runtime.
 * @param storeKey - target scope.
 * @param sessionId - optional session providing a fallback model route.
 * @returns the number of applied ops (0 also covers "nothing to do").
 */
async function consolidateScope(runtime, storeKey, sessionId) {
  const config = runtime.config()
  if (config.enabled !== true) return { applied: 0, archivedStale: 0 }
  const items = (await runtime.store.list(storeKey)).filter((item) => item.status === 'active')
  if (items.length < 4) return { applied: 0, archivedStale: 0 }
  let route = resolveManageRoute(config, undefined)
  if (route === undefined && typeof sessionId === 'string' && sessionId !== '') {
    const session = runtime.ctx.sessions.get(sessionId)
    route = resolveManageRoute(config, session?.requestHeader?.() ?? undefined)
  }

  // Heuristic auto-archive of stale memories (never model-decided): untouched
  // past the window with no reinforcement and no links.
  const ops = []
  let archivedStale = 0
  if (config.autoArchiveDays > 0) {
    const cutoff = Date.now() - config.autoArchiveDays * 86_400_000
    // Oldest-first window: stale candidates sit at the FRONT of the
    // insertion-ordered list, so a tail slice would skip exactly the items
    // this heuristic exists to catch once the scope grows past 200.
    for (const item of items.slice(0, 200)) {
      const lastTouch = item.lastUsedAt ?? item.updatedAt ?? item.createdAt
      if (lastTouch <= cutoff && item.useCount === 0 && item.links.length === 0) {
        ops.push({ op: 'archive', id: item.id, __auto: true })
        archivedStale += 1
      }
    }
  }

  if (route !== undefined) {
    // Oldest 60, aligned with the archive window: the consolidator must see
    // the stale head it is supposed to tidy, not only the freshest tail.
    const inventory = items.slice(0, 60).map((item) => `- [${item.id}] (${item.type}${item.tags.length > 0 ? ' #' + item.tags.join(' #') : ''}) ${item.content}`).join('\n')
    try {
      const reply = await callModel(runtime.ctx.llm, {
        provider: route.provider,
        model: route.model,
        maxTokens: config.maxTokens,
        messages: [createUserMessage({
          content: [{ type: 'text', text: `${CONSOLIDATE_INSTRUCTION}\n\n${inventory}` }],
          source: { kind: 'plugin', plugin: 'dsh-memory' },
        })],
      })
      ops.push(...parseOps(reply))
    } catch (error) {
      // Auto-archive is heuristic and still worth committing even when the
      // model leg fails — keep going when synthetic ops exist.
      if (ops.length === 0) throw error
      runtime.lastError = String(error instanceof Error ? error.message : error)
    }
  } else if (ops.length === 0 && !(config.autoLinkThreshold > 0)) {
    throw Object.assign(new Error('no provider/model for consolidation: configure dsh-memory.extractProvider/extractModel'), { code: 'no-route' })
  }
  if (ops.length === 0 && config.autoLinkThreshold <= 0) return { applied: 0, archivedStale: 0, linkedAuto: 0 }
  // Snapshot every referenced item before mutating, so one undo restores it all.
  const touchedIds = new Set()
  for (const op of ops) {
    if (op.op === 'merge') {
      touchedIds.add(op.into)
      for (const id of op.from) touchedIds.add(id)
    } else if (op.op === 'link') {
      touchedIds.add(op.a)
      touchedIds.add(op.b)
    } else touchedIds.add(op.id)
  }
  const snapshots = await runtime.store.snapshotItems(storeKey, [...touchedIds])

  const applied = await runtime.store.mutateTx(storeKey, (data) => {
    const byId = new Map((data.items ?? []).map((item) => [item.id, item]))
    let count = 0
    const now = Date.now()
    for (const op of ops) {
      if (op.op === 'merge') {
        const into = byId.get(op.into)
        if (into === undefined || into.status !== 'active') continue
        const froms = op.from.map((id) => byId.get(id)).filter((entry) => entry !== undefined && entry.id !== into.id && entry.status === 'active')
        if (froms.length === 0) continue
        if (op.content !== '') into.content = op.content
        into.origin = 'consolidation'
        into.updatedAt = now
        for (const from of froms) {
          from.status = 'archived'
          from.updatedAt = now
          if (!into.links.some((edge) => edge.id === from.id)) into.links.push({ id: from.id, kind: 'supersedes' })
        }
        count += 1
      } else if (op.op === 'link') {
        const a = byId.get(op.a)
        const b = byId.get(op.b)
        if (a !== undefined && b !== undefined && op.a !== op.b && !a.links.some((edge) => edge.id === op.b)) {
          a.links.push({ id: op.b, kind: op.kind })
          b.links.push({ id: op.a, kind: op.kind })
          a.updatedAt = now
          b.updatedAt = now
          count += 1
        }
      } else if (op.op === 'archive') {
        const item = byId.get(op.id)
        if (item !== undefined && item.status === 'active') {
          item.status = 'archived'
          item.updatedAt = now
          count += 1
        }
      } else if (op.op === 'retag') {
        const item = byId.get(op.id)
        if (item !== undefined) {
          item.tags = op.tags
          item.updatedAt = now
          count += 1
        }
      }
    }
    return count
  })

  // Persist the undo point only when something actually changed, and only
  // for MODEL-driven reorganizations — heuristic auto-archives are safe and
  // must not clobber a meaningful merge-undo point.
  const hasModelOps = ops.some((op) => op.__auto !== true)
  if (applied > 0 && snapshots.length > 0 && hasModelOps) await saveUndoSnapshot(runtime, storeKey, snapshots)

  // Association growth: heuristic, post-ops, excluded from the undo snapshot
  // on purpose (restoring a snapshot wholesale removes auto-links with it).
  const linkedAuto = await autoLinkPass(runtime, storeKey, config.autoLinkThreshold)

  runtime.state.markConsolidated(storeKey, applied)
  return { applied, archivedStale, linkedAuto }
}
//#endregion

//#region embedding pipeline ----------------------------------------------------
/**
 * Queue item ids for background embedding (deduplicated per scope).
 * @param runtime - host runtime.
 * @param storeKey - owning scope.
 * @param ids - ids whose content needs a vector.
 */
function enqueueEmbed(runtime, storeKey, ids) {
  for (const id of ids) {
    const entry = `${storeKey}\u0000${id}`
    if (!runtime.embedQueue.includes(entry)) runtime.embedQueue.push(entry)
  }
  void drainEmbed(runtime)
}

/**
 * Serially drain the embed queue. Disabled settings or a dead embedder flush
 * the queue harmlessly — lexical scoring keeps working either way.
 */
async function drainEmbed(runtime) {
  if (runtime.disposed) return undefined
  // Already draining: hand back the in-flight promise so callers (the
  // backfill route) actually wait for completion instead of racing it.
  if (runtime.embedRunning) return runtime.embedActive
  runtime.embedRunning = true
  const run = (async () => {
    await runtime.ready
    const config = runtime.config()
    if (config.enabled !== true || config.embeddingsEnabled !== true) {
      runtime.embedQueue.length = 0
      return
    }
    runtime.embedder.setRemoteHost(config.embeddingRemoteHost)
    while (runtime.embedQueue.length > 0 && !runtime.disposed) {
      const entry = runtime.embedQueue.shift()
      const sep = entry.indexOf('\u0000')
      try {
        await embedOne(runtime, entry.slice(0, sep), entry.slice(sep + 1))
      } catch {}
    }
  })()
  runtime.embedActive = run
  try {
    await run
  } finally {
    runtime.embedRunning = false
  }
  return run
}

/**
 * Embed one item's content into its scope's sidecar. Skips unchanged items
 * (vector timestamp matches updatedAt).
 */
async function embedOne(runtime, storeKey, id) {
  const item = (await runtime.store.list(storeKey)).find((entry) => entry.id === id)
  if (item === undefined || item.status === 'archived') return
  const map = await runtime.vectors.load(storeKey)
  const existing = map.get(id)
  if (existing !== undefined && existing.at === item.updatedAt) return
  const vectors = await runtime.embedder.embedBatch([item.content])
  if (vectors === undefined || vectors.length !== 1) return
  map.set(id, { v: vectors[0], at: item.updatedAt })
  await runtime.vectors.save(storeKey, map)
}

/** Query-vector cache keyed by the exact recent-text payload. */
const queryVecCache = new Map()

/**
 * Embedding of the recent-conversation tail, memoized per payload. Only
 * awaits inference when the model is ALREADY ready — first-use downloads
 * happen in the background so requests never stall on them.
 */
async function queryVectorFor(runtime, config, text) {
  if (config.embeddingsEnabled !== true || typeof text !== 'string' || text.trim() === '') return undefined
  const cached = queryVecCache.get(text)
  if (cached !== undefined) return cached
  if (runtime.embedder.state !== 'ready') {
    // Warm up in the background; this assembly scores lexically only.
    runtime.embedder.setRemoteHost(config.embeddingRemoteHost)
    void runtime.embedder.embedBatch([text.trim().slice(-RECENT_CHARS)]).catch(() => {})
    return undefined
  }
  const vectors = await runtime.embedder.embedBatch([text.trim().slice(-RECENT_CHARS)])
  if (vectors === undefined || vectors.length !== 1) return undefined
  queryVecCache.set(text, vectors[0])
  if (queryVecCache.size > 20) {
    const oldest = queryVecCache.keys().next().value
    if (oldest !== undefined) queryVecCache.delete(oldest)
  }
  return vectors[0]
}

/**
 * Heuristic association growth: link active pairs whose cosine similarity
 * clears the threshold and that have no edge yet. Runs inside one
 * transaction; capped per run so huge backfills stay bounded.
 */
async function autoLinkPass(runtime, storeKey, threshold) {
  if (!(threshold > 0)) return 0
  const items = (await runtime.store.list(storeKey)).filter((item) => item.status === 'active')
  if (items.length < 2) return 0
  const vmap = await runtime.vectors.load(storeKey)
  const withVec = items.filter((item) => vmap.has(item.id))
  if (withVec.length < 2) return 0
  let linked = 0
  await runtime.store.mutateTx(storeKey, (data) => {
    const byId = new Map((data.items ?? []).map((item) => [item.id, item]))
    let done = false
    for (let i = 0; i < withVec.length && !done; i += 1) {
      for (let j = i + 1; j < withVec.length && !done; j += 1) {
        const a = byId.get(withVec[i].id)
        const b = byId.get(withVec[j].id)
        if (a === undefined || b === undefined || a.status !== 'active' || b.status !== 'active') continue
        if (a.links.some((edge) => edge.id === b.id) || b.links.some((edge) => edge.id === a.id)) continue
        if (cosine(vmap.get(a.id).v, vmap.get(b.id).v) >= threshold) {
          const stamp = Date.now()
          a.links.push({ id: b.id, kind: 'related' })
          b.links.push({ id: a.id, kind: 'related' })
          a.updatedAt = stamp
          b.updatedAt = stamp
          linked += 1
          if (linked >= 30) done = true
        }
      }
    }
  })
  return linked
}
//#endregion

//#region commander guide -------------------------------------------------------
/** Marker tag making the planted commander guide identifiable & idempotent. */
const COMMANDER_GUIDE_TAG = 'dsh-commander-guide'
/** The planted guide content: how to use commander mode + its conventions. */
const COMMANDER_GUIDE_CONTENT = [
  '指挥官模式使用规范：会话激活「成为指挥官」后，模型在回复中原样输出 <dsh-dispatch> 任务块即可派发任务给其他会话并行执行。',
  '- target 填花名册别名（#1）或会话 id；省略 target 自动新建 worker 会话（继承指挥官工作目录）；',
  '- target="#1,#2" 同任务广播多 worker；target="all" 发全体；',
  '- fork="commander" 改走会话分叉，worker 携带指挥官全部背景；',
  '- tid="a" 命名任务，另一块 depends="a,b" 编排依赖，前序失败连锁取消；',
  '- delay="10m" 支持 30s/10m/1h 延迟派发。',
  '规范：相互独立的任务分散到不同 worker 并优先空闲者；一次回复可含多个任务块；任务描述要完整自包含；worker 完成后结果以回执自动回流到本会话，无需追问或复制粘贴。',
].join('\n')

/**
 * Plant the commander usage guide into a scope once (idempotent by marker
 * tag), when commander activity is first observed there. Fire-and-forget;
 * failures are silent because this is a convenience, not a contract.
 * @param runtime - host runtime.
 * @param storeKey - target scope.
 * @param cwd - workspace root for project labeling (undefined for global).
 */
async function ensureCommanderGuide(runtime, storeKey, cwd) {
  if (runtime.commanderGuideBusy.has(storeKey)) return
  runtime.commanderGuideBusy.add(storeKey)
  try {
    await runtime.ready
    const items = await runtime.store.list(storeKey)
    if (items.some((item) => item.status === 'active' && Array.isArray(item.tags) && item.tags.includes(COMMANDER_GUIDE_TAG))) return
    const result = await runtime.store.applyCandidate(storeKey, {
      content: COMMANDER_GUIDE_CONTENT,
      type: 'pattern',
      tags: ['dsh-commander', '指挥官', '使用规范', COMMANDER_GUIDE_TAG],
      origin: 'manual',
      ...(storeKey === 'global' || cwd === undefined ? {} : { cwd }),
    }, 'add', null)
    if (result.created) enqueueEmbed(runtime, storeKey, [result.item.id])
  } catch {} finally {
    // Allow re-planting later if the user deletes the guide deliberately.
    runtime.commanderGuideBusy.delete(storeKey)
  }
}
//#endregion

//#region http helpers: body buffering, JSON replies, undo snapshots --------------------------------------------------------
/** Undo snapshot file for one scope (`memory/undo/<key>.json`). */
function undoFileFor(storeKey) {
  const name = storeKey === 'global' ? 'global' : storeKey.slice(2)
  return path.join(dshHomePath('memory'), 'undo', `${name}.json`)
}

/**
 * Persist the last consolidation's pre-change item versions for one scope.
 * Only the most recent undo point is kept.
 * @param runtime - host runtime.
 * @param storeKey - target scope.
 * @param snapshots - deep-copied items as they were before the ops applied.
 */
async function saveUndoSnapshot(runtime, storeKey, snapshots) {
  try {
    const file = undoFileFor(storeKey)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, JSON.stringify({ version: 1, storeKey, at: Date.now(), items: snapshots }, null, 2), { mode: 0o600 })
  } catch {}
}

/**
 * Load and clear the undo snapshot for one scope.
 * @param runtime - host runtime.
 * @param storeKey - target scope.
 * @returns the snapshotted items ([] when nothing to undo).
 */
async function popUndoSnapshot(runtime, storeKey) {
  const file = undoFileFor(storeKey)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      await writeFileAtomic(file, JSON.stringify({ version: 1, storeKey, at: Date.now(), items: [] }, null, 2), { mode: 0o600 })
      return parsed.items
    }
  } catch {}
  return []
}

/**
 * Buffer the request body as UTF-8 text.
 * @param req - the incoming request stream.
 * @returns the decoded body.
 */
async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write a JSON response the handler fully owns.
 * @param res - the response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable payload.
 */
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Error payload with its stable code; the message is path-redacted. */
function errorPayload(error) {
  return { code: error?.code ?? 'internal', message: redactText(error instanceof Error ? error.message : error) }
}

/**
 * Strip internal details (absolute filesystem paths, the dsh home root) from
 * outbound text so errors and status lines never leak directory layout to
 * the browser half. Length-capped as a final belt-and-braces measure.
 */
function redactText(text) {
  let out = String(text ?? '')
  out = out.replace(/[A-Za-z]:[\\/][^\s"'`,;)\]}]*/g, '[path]')
  out = out.replace(/(^|[\s(])(\/(?:Users|home|root|tmp|var|private|etc|opt)\/[^\s"'`,;)\]}]*)/g, '$1[path]')
  out = out.replace(/(^|[\s(])(\/[^\s"'`,;)\]}]*[\\/]\.dsh(?:[\\/][^\s"'`,;)\]}]*)?)/g, '$1[path]')
  return out.length > 500 ? `${out.slice(0, 500)}…` : out
}

/**
 * Enforce the documented POST convention at the handler boundary. The web
 * server matches exact routes by path alone (its method metadata is purely
 * decorative), so a GET could otherwise reach a mutating handler. Synthetic
 * callers (test doubles, IPC bridges) omit req.method entirely and stay
 * allowed — real node:http traffic always carries a method.
 */
function requirePost(req, res) {
  if (req?.method === undefined || req.method === 'POST') return true
  send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'this endpoint only accepts POST' } })
  return false
}

/** Parse a Host/hostname value down to its bare lowercase hostname. */
function bareHostname(value) {
  if (typeof value !== 'string' || value === '') return ''
  let host = value.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    host = end === -1 ? '' : host.slice(1, end)
  } else {
    host = host.split(':')[0]
  }
  return host
}

function isLocalHostname(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Loopback guard for the plugin's HTTP surface. The web server performs no
 * authentication of its own, so every request is checked against the Host
 * header (defeats DNS rebinding) and — on state-changing routes — the Origin
 * header (defeats cross-site blind POSTs: browsers attach Origin to every
 * cross-origin write, while non-browser clients legitimately omit it).
 * GET-only routes skip the Origin check on purpose: top-level navigations do
 * not send Origin at all, their responses are unreadable cross-origin anyway,
 * so Host alone closes the rebinding read hole without breaking normal
 * address-bar access. Requests without headers (in-process test doubles)
 * pass through untouched.
 */
function guardLocal(req, res, checkOrigin) {
  const headers = req?.headers
  if (headers === undefined || headers === null || typeof headers !== 'object') return true
  if (!isLocalHostname(bareHostname(headers.host))) {
    send(res, 403, { ok: false, error: { code: 'forbidden', message: 'this endpoint is local-only' } })
    return false
  }
  if (checkOrigin && typeof headers.origin === 'string' && headers.origin !== '') {
    let originHost = ''
    try { originHost = bareHostname(new URL(headers.origin).hostname) } catch {}
    if (!isLocalHostname(originHost)) {
      send(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-origin requests are not accepted' } })
      return false
    }
  }
  return true
}

/**
 * Local copies of util.js's bigram/Jaccard pair (same normalization ⇒ same
 * scores ⇒ same DEDUPE_THRESHOLD behavior): import deduplication needs
 * PRE-BUILT per-item sets, because the shared similarity() re-tokenizes both
 * sides on every call — O(N×M) tokenizations freeze large imports.
 */
function bigramSetOf(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, '')
  const grams = new Set()
  for (let index = 0; index < s.length - 1; index += 1) grams.add(s.slice(index, index + 2))
  if (s.length === 1) grams.add(s)
  return grams
}

function jaccardOf(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const gram of small) { if (large.has(gram)) shared += 1 }
  return shared / (a.size + b.size - shared)
}

/**
 * Resolve the project store key from request params (sessionId preferred,
 * explicit cwd fallback; anything else falls back to the global scope).
 * @param runtime - host runtime.
 * @param params - `{sessionId?, cwd?}` from query or body.
 * @returns the resolved `{storeKey, cwd}` (cwd undefined for global).
 */
function resolveScopeParams(runtime, params) {
  if (typeof params.sessionId === 'string' && params.sessionId !== '') {
    const session = runtime.ctx.sessions.get(params.sessionId)
    const cwd = session?.header?.cwd
    if (cwd !== undefined) return { storeKey: projectKeyFor(cwd), cwd }
  }
  if (typeof params.cwd === 'string' && params.cwd !== '') return { storeKey: projectKeyFor(params.cwd), cwd: params.cwd }
  return { storeKey: 'global', cwd: undefined }
}
//#endregion

//#region host apply ------------------------------------------------------------
/**
 * Register the settings namespace, the injection/extraction listeners, and
 * the browser-half routes. Everything additive: the plugin owns no stock
 * composition and every listener is failure-isolated.
 * @param ctx - host context carrying webServer, settings, sessions, and llm.
 */
export function apply(ctx) {
  let source = () => DEFAULTS
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, SCHEMA)
    source = () => ({ ...DEFAULTS, ...scope.get() })
  })

  const runtime = createRuntime(ctx, () => source())
  runtime.ready = runtime.state.load()

  // Rolling recent-user-text buffer per session — the relevance query for
  // injection. Cheap heuristic: last RECENT_CHARS chars of user messages.
  const recent = new Map()
  const rememberRecent = (sessionId, text) => {
    if (text === '') return
    const previous = recent.get(sessionId) ?? ''
    const merged = `${previous}\n${text}`.slice(-RECENT_CHARS)
    if (recent.has(sessionId)) recent.delete(sessionId)
    recent.set(sessionId, merged)
    if (recent.size > RECENT_SESSIONS_MAX) {
      const oldest = recent.keys().next().value
      if (oldest !== undefined) recent.delete(oldest)
    }
  }

  // Debounced "this briefing was used" reinforcement flush (useCount bump).
  const touched = new Map()
  let touchTimer
  const touch = (ids) => {
    for (const id of ids) touched.set(id, true)
    if (touchTimer !== undefined) return
    touchTimer = setTimeout(() => {
      touchTimer = undefined
      const batch = [...touched.keys()]
      touched.clear()
      void (async () => {
        for (const id of batch) {
          try {
            const storeKey = await runtime.store.findStoreOf(id)
            if (storeKey === undefined) continue
            await runtime.store.mutateTx(storeKey, (data) => {
              const item = (data.items ?? []).find((entry) => entry.id === id)
              if (item !== undefined) {
                item.useCount += 1
                item.lastUsedAt = Date.now()
              }
            })
          } catch {}
        }
      })()
    }, 3000)
  }
  // Per-agent reinforcement throttle: a turn re-assembles at every step, so
  // without this the useCount would inflate once per model step.
  const touchedRecently = new WeakMap()

  // Injection: append the memory briefing to every assembled prompt. Global
  // waterfall listener; assemblies without a session cwd still get globals;
  // relevance ranking uses the session's recent user text when available;
  // any error returns the assembly untouched so requests never break.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      const config = runtime.config()
      if (config.enabled !== true || config.injectEnabled !== true || runtime.disposed) return assembled
      const agent = context?.agent
      const session = agent?.session
      const cwd = session?.header?.cwd
      // Machine-driven sessions (commander workers etc.) execute dispatched
      // tasks: injecting the shared project briefing into every one of them
      // both leaks the same memories across conversations and wastes tokens.
      if (typeof session?.id === 'string' && runtime.sessionKinds.get(session.id) === 'machine') return assembled
      const globals = await runtime.store.list('global')
      const projects = cwd === undefined ? [] : await runtime.store.list(projectKeyFor(cwd))
      const recentText = typeof session?.id === 'string' ? recent.get(session.id) ?? '' : ''
      const queryTokens = tokenize(recentText)
      const queryVector = await queryVectorFor(runtime, config, recentText)
      let itemVectors
      if (queryVector !== undefined) {
        // Merge both scopes' vector maps (ids are unique across stores), but
        // keep ONLY fresh entries — a sidecar vector is valid while its `at`
        // timestamp equals the item's current updatedAt; anything older means
        // "content changed since embedding" and degrades to lexical scoring
        // until backfill catches up. Values are unwrapped to raw vectors,
        // matching selectBriefing/cosine's Map<id, vector> contract.
        const updatedAtById = new Map([...globals, ...projects].map((item) => [item.id, item.updatedAt]))
        const merged = [...(await runtime.vectors.load('global')), ...(cwd === undefined ? [] : await runtime.vectors.load(projectKeyFor(cwd)))]
        itemVectors = new Map()
        for (const [id, entry] of merged) {
          if (entry.at === updatedAtById.get(id)) itemVectors.set(id, entry.v)
        }
      }
      const briefing = selectBriefing(globals, projects, config.topK, config.maxInjectChars, queryTokens, queryVector, itemVectors)
      if (briefing.text === '') return assembled
      const contexts = [...(assembled.contexts ?? []), { name: 'dsh-memory', text: briefing.text }]
      const now = Date.now()
      const lastTouch = agent === undefined ? 0 : touchedRecently.get(agent) ?? 0
      if (now - lastTouch >= 60000) {
        if (agent !== undefined) touchedRecently.set(agent, now)
        touch(briefing.ids)
      }
      return { ...assembled, contexts }
    } catch {
      return assembled
    }
  })

  // Extraction: watch committed turns, feed the relevance buffer (human
  // input only), and queue the finished session.
  ctx.on('session/event', (session, event) => {
    try {
      if (runtime.disposed) return
      if (event.type === 'user/message') {
        // Classify the session by WHO is driving: plugin-sourced user
        // messages (commander dispatch briefings, plugin checkpoints) are
        // machine traffic; any human-typed message flips the session to
        // human permanently for its lifetime.
        const source = event.data?.message?.source ?? session.deriveEventMessage?.(event)?.source
        const isMachine = source?.kind === 'plugin'
        if (isMachine && runtime.sessionKinds.get(session.id) === undefined) {
          // Bounded growth + true-LRU ordering via the shared setter.
          setSessionKind(runtime.sessionKinds, session.id, 'machine')
        }
        if (isMachine && source?.plugin === 'dsh-commander') {
          const gcwd = session.header?.cwd
          void ensureCommanderGuide(runtime, gcwd === undefined ? 'global' : projectKeyFor(gcwd), gcwd)
        }
        if (!isMachine) setSessionKind(runtime.sessionKinds, session.id, 'human')
        if (runtime.sessionKinds.get(session.id) !== 'human') return
        const derived = session.deriveEventMessage?.(event) ?? event.data?.message
        const text = messageText(derived).trim()
        if (text !== '') rememberRecent(session.id, text)
        return
      }
      if (event.type !== 'turn/end') return
      const config = runtime.config()
      if (config.enabled !== true || config.autoExtract !== true) return
      if (runtime.paused) return
      enqueueExtraction(runtime, session.id)
    } catch {}
  })

  ctx.effect(() => () => {
    runtime.disposed = true
    if (touchTimer !== undefined) clearTimeout(touchTimer)
  }, 'dsh-memory: dispose queues')

  // /remember <text>: durable slash command storing a manual memory in the
  // current project scope (global when the session has no workspace). The
  // commands service ships with the base bundle; registration is failure-
  // isolated so an absent service only costs the command, never the plugin.
  ctx.inject(['commands'], (cctx) => {
    try {
      cctx.commands.register({
        name: 'remember',
        description: '记住一条信息到长期记忆（项目/全局）',
        input: { hint: '<要记住的一句话>' },
        handler: async (invocation) => {
          const text = String(invocation.rawInput ?? '').trim()
          if (text === '') {
            return { kind: 'error', text: '用法：/remember <要记住的一句话>' }
          }
          const config = runtime.config()
          if (config.enabled !== true) return { kind: 'error', text: 'dsh-memory 已在设置中停用' }
          const cwd = invocation.agent?.session?.header?.cwd
          const storeKey = cwd === undefined ? 'global' : projectKeyFor(cwd)
          const result = await runtime.store.applyCandidate(storeKey, {
            content: text.slice(0, MAX_CONTENT_CHARS),
            type: 'fact',
            tags: [],
            origin: 'manual',
            sourceSessionId: invocation.agent?.session?.id,
            ...(storeKey === 'global' || cwd === undefined ? {} : { cwd }),
          }, 'add', null)
          const scopeLabel = storeKey === 'global' ? '全局' : '项目'
          const verb = result.relation === 'reinforced' ? '已强化既有记忆' : result.relation === 'updated' ? '已更新既有记忆' : '已存入'
          return { kind: 'success', text: `✦ ${verb}${scopeLabel}记忆库：${result.item.content}` }
        },
      })
    } catch {}
  })

  // GET items: one scope's full list (sessionId/cwd resolve the project key).
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/items',
      handler: async (req, res) => {
        if (!guardLocal(req, res, false)) return
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const wanted = url.searchParams.get('scope')
          let resolved
          if (wanted === 'global') resolved = { storeKey: 'global', cwd: undefined }
          else {
            resolved = resolveScopeParams(runtime, { sessionId: url.searchParams.get('sessionId'), cwd: url.searchParams.get('cwd') })
            if (wanted === 'project' && resolved.storeKey === 'global') {
              send(res, 200, { ok: true, scope: 'project', storeKey: null, resolved: false, cwd: undefined, items: [] })
              return
            }
          }
          const items = await runtime.store.list(resolved.storeKey)
          send(res, 200, { ok: true, scope: resolved.storeKey === 'global' ? 'global' : 'project', resolved: true, cwd: resolved.cwd, storeKey: resolved.storeKey, items: items.map(wireItem) })
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: items GET route',
  )

  // POST add: manual add. (Distinct path: the webserver dedupes exact routes
  // by path alone, so same-path method-splitting is not supported.)
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/add',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const body = JSON.parse(await readBody(req))
          const content = typeof body.content === 'string' ? body.content.trim() : ''
          if (content === '' || content.length > MAX_CONTENT_CHARS) {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: `content is required (1..${MAX_CONTENT_CHARS} chars)` } })
            return
          }
          const type = MEMORY_TYPES.includes(body.type) ? body.type : 'fact'
          const tags = Array.isArray(body.tags)
            ? body.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 5)
            : []
          const wantProject = body.scope !== 'global'
          const resolved = wantProject ? resolveScopeParams(runtime, body) : { storeKey: 'global', cwd: undefined }
          if (wantProject && resolved.storeKey === 'global') {
            send(res, 400, { ok: false, error: { code: 'no-workspace', message: 'project scope requires a session with a cwd (or an explicit cwd)' } })
            return
          }
          const result = await runtime.store.applyCandidate(resolved.storeKey, {
            content,
            type,
            tags,
            origin: 'manual',
            ...(resolved.cwd === undefined || resolved.storeKey === 'global' ? {} : { cwd: resolved.cwd }),
          }, 'add', null)
          send(res, 200, { ok: true, created: result.created, relation: result.relation, item: wireItem(result.item) })
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: items POST route',
  )

  // POST update: edit content/type/tags/status.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/update',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const body = JSON.parse(await readBody(req))
          if (typeof body.id !== 'string' || body.id === '') {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'id is required' } })
            return
          }
          const rawPatch = body.patch
          if (rawPatch === null || typeof rawPatch !== 'object') {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'patch object is required' } })
            return
          }
          const patch = {}
          if (typeof rawPatch.content === 'string') {
            const content = rawPatch.content.trim()
            if (content === '' || content.length > MAX_CONTENT_CHARS) {
              send(res, 400, { ok: false, error: { code: 'bad-request', message: `content must be 1..${MAX_CONTENT_CHARS} chars` } })
              return
            }
            patch.content = content
          }
          if (typeof rawPatch.type === 'string') {
            if (!MEMORY_TYPES.includes(rawPatch.type)) {
              send(res, 400, { ok: false, error: { code: 'bad-request', message: `type must be one of: ${MEMORY_TYPES.join(', ')}` } })
              return
            }
            patch.type = rawPatch.type
          }
          if (Array.isArray(rawPatch.tags)) patch.tags = rawPatch.tags.filter((tag) => typeof tag === 'string')
          if (rawPatch.status === 'active' || rawPatch.status === 'archived') patch.status = rawPatch.status
          if (rawPatch.pinned === true || rawPatch.pinned === false) patch.pinned = rawPatch.pinned
          const item = await runtime.store.update(body.id, patch)
          send(res, 200, { ok: true, item: wireItem(item) })
        } catch (error) {
          send(res, error?.code === 'not-found' ? 404 : 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: update route',
  )

  // POST remove: hard delete.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/remove',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const body = JSON.parse(await readBody(req))
          if (typeof body.id !== 'string' || body.id === '') {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'id is required' } })
            return
          }
          const owningStore = await runtime.store.findStoreOf(body.id)
          await runtime.store.remove(body.id)
          // Keep the vector sidecar bounded: drop everything no longer present.
          if (owningStore !== undefined) {
            const knownIds = new Set((await runtime.store.list(owningStore)).map((entry) => entry.id))
            void runtime.vectors.prune(owningStore, knownIds).catch(() => {})
          }
          send(res, 200, { ok: true })
        } catch (error) {
          send(res, error?.code === 'not-found' ? 404 : 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: remove route',
  )

  // POST link / unlink: symmetric graph edges within one scope.
  for (const [routePath, runner] of [
    ['/api/dsh-memory/link', (store, body) => store.link(body.a, body.b, typeof body.kind === 'string' ? body.kind : 'related')],
    ['/api/dsh-memory/unlink', (store, body) => store.unlink(body.a, body.b)],
  ]) {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        method: 'POST',
        handler: async (req, res) => {
          if (!requirePost(req, res) || !guardLocal(req, res, true)) return
          try {
            const body = JSON.parse(await readBody(req))
            if (typeof body.a !== 'string' || typeof body.b !== 'string' || body.a === '' || body.b === '') {
              send(res, 400, { ok: false, error: { code: 'bad-request', message: 'a and b are required' } })
              return
            }
            await runner(runtime.store, body)
            send(res, 200, { ok: true })
          } catch (error) {
            send(res, error?.code === 'not-found' ? 404 : error?.code === 'cross-scope' || error?.code === 'self-link' ? 400 : 500, { ok: false, error: errorPayload(error) })
          }
        },
      }),
      `dsh-memory:${routePath} route`,
    )
  }

  // GET graph: nodes+edges projection for the canvas renderer.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/graph',
      handler: async (req, res) => {
        if (!guardLocal(req, res, false)) return
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const wanted = url.searchParams.get('scope')
          let resolved
          if (wanted === 'global') resolved = { storeKey: 'global', cwd: undefined }
          else {
            resolved = resolveScopeParams(runtime, { sessionId: url.searchParams.get('sessionId'), cwd: url.searchParams.get('cwd') })
            if (wanted === 'project' && resolved.storeKey === 'global') {
              send(res, 200, { ok: true, scope: 'project', storeKey: null, resolved: false, nodes: [], edges: [] })
              return
            }
          }
          send(res, 200, { ok: true, scope: resolved.storeKey === 'global' ? 'global' : 'project', storeKey: resolved.storeKey, ...(await runtime.store.graph(resolved.storeKey)) })
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: graph route',
  )

  // POST consolidate: manual run for one scope.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/consolidate',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          if (runtime.config().enabled !== true) {
            send(res, 200, { ok: false, error: { code: 'disabled', message: 'memory is disabled in the dsh-memory settings' } })
            return
          }
          // Manual runs join the auto pipeline's mutual exclusion: refuse with
          // 409 instead of racing the serial queue (duplicate model spend,
          // undo-point clobber). Claiming the slot synchronously — before any
          // await — closes the check/start race against a firing auto trigger.
          if (runtime.consolidateRunning || runtime.consolidateManualBusy) {
            send(res, 409, { ok: false, error: { code: 'busy', message: 'another consolidation is already running' } })
            return
          }
          runtime.consolidateManualBusy = true
          try {
            const body = JSON.parse(await readBody(req))
            const wantGlobal = body.scope === 'global'
            const resolved = wantGlobal ? { storeKey: 'global' } : resolveScopeParams(runtime, body)
            // Same contract as POST /add: never silently fall back to the
            // global scope when a project consolidation was requested.
            if (!wantGlobal && resolved.storeKey === 'global') {
              send(res, 400, { ok: false, error: { code: 'no-workspace', message: 'project scope requires a session with a cwd (or an explicit cwd)' } })
              return
            }
            const result = await consolidateScope(runtime, resolved.storeKey, typeof body.sessionId === 'string' ? body.sessionId : undefined)
            send(res, 200, { ok: true, applied: result.applied, archivedStale: result.archivedStale, scope: resolved.storeKey === 'global' ? 'global' : 'project' })
          } finally {
            runtime.consolidateManualBusy = false
            // Scopes enqueued while the manual run held the slot must not strand.
            if (runtime.consolidateQueue.length > 0) void drainConsolidation(runtime)
          }
        } catch (error) {
          runtime.lastError = String(error instanceof Error ? error.message : error)
          send(res, error?.code === 'no-route' ? 409 : 502, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: consolidate route',
  )

  // POST extract: manual run for one session (force replays a recent tail).
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/extract',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const config = runtime.config()
          if (config.enabled !== true) {
            send(res, 200, { ok: false, error: { code: 'disabled', message: 'memory is disabled in the dsh-memory settings' } })
            return
          }
          // Same manual/auto mutual exclusion as POST /consolidate: a manual
          // run must not race the serial drain over the same session.
          if (runtime.extractRunning || runtime.extractManualBusy) {
            send(res, 409, { ok: false, error: { code: 'busy', message: 'another extraction is already running' } })
            return
          }
          runtime.extractManualBusy = true
          try {
            const body = JSON.parse(await readBody(req))
            if (typeof body.sessionId !== 'string' || body.sessionId === '') {
              send(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
              return
            }
            const result = await extractSession(runtime, body.sessionId, body.force === true)
            send(res, 200, { ok: true, ...result })
          } finally {
            runtime.extractManualBusy = false
            // Sessions queued while the manual run held the slot must not strand.
            if (runtime.extractQueue.length > 0) void drainExtraction(runtime)
          }
        } catch (error) {
          runtime.consecutiveFailures += 1
          runtime.lastError = String(error instanceof Error ? error.message : error)
          if (runtime.consecutiveFailures >= PAUSE_AFTER_FAILURES) runtime.paused = true
          send(res, error?.code === 'no-route' ? 409 : 502, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: extract route',
  )

  // POST undo: restore the pre-consolidation versions for one scope.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/undo',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const body = JSON.parse(await readBody(req))
          const wantGlobal = body.scope === 'global'
          const resolved = wantGlobal ? { storeKey: 'global' } : resolveScopeParams(runtime, body)
          const snapshots = await popUndoSnapshot(runtime, resolved.storeKey)
          if (snapshots.length === 0) {
            send(res, 200, { ok: false, error: { code: 'nothing-to-undo', message: 'no consolidation to undo for this scope' } })
            return
          }
          const restored = await runtime.store.restoreItems(resolved.storeKey, snapshots)
          send(res, 200, { ok: true, restored })
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: undo route',
  )

  // GET export: download one scope as Markdown (Obsidian-friendly) or JSON.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/export',
      handler: async (req, res) => {
        if (!guardLocal(req, res, false)) return
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const format = url.searchParams.get('format') === 'json' ? 'json' : 'markdown'
          const wanted = url.searchParams.get('scope')
          let resolved
          if (wanted === 'global' || wanted === null) resolved = { storeKey: 'global', cwd: undefined }
          else {
            resolved = resolveScopeParams(runtime, { sessionId: url.searchParams.get('sessionId'), cwd: url.searchParams.get('cwd') })
            if (wanted === 'project' && resolved.storeKey === 'global') {
              send(res, 400, { ok: false, error: { code: 'no-workspace', message: 'project scope requires a session with a cwd' } })
              return
            }
          }
          const items = await runtime.store.list(resolved.storeKey)
          const stamp = new Date().toISOString().slice(0, 10)
          if (format === 'json') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="dsh-memory-${stamp}.json"` })
            res.end(JSON.stringify({ version: 1, exportedAt: Date.now(), storeKey: resolved.storeKey, items }, null, 2))
            return
          }
          const lines = [`# dsh-memory 导出（${resolved.storeKey === 'global' ? '全局' : resolved.cwd ?? '项目'}）`, '']
          for (const item of items) {
            lines.push(`## ${item.id}`)
            lines.push(`- type: ${item.type} | status: ${item.status}${item.pinned === true ? ' | 📌pinned' : ''} | created: ${new Date(item.createdAt).toISOString()}`)
            if (item.tags.length > 0) lines.push(`- tags: ${item.tags.map((tag) => `#${tag}`).join(' ')}`)
            if (item.links.length > 0) lines.push(`- links: ${item.links.map((edge) => `[[${edge.id}]](${edge.kind})`).join(', ')}`)
            lines.push('')
            lines.push(item.content)
            lines.push('')
          }
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="dsh-memory-${stamp}.md"` })
          res.end(lines.join('\n'))
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: export route',
  )

  // POST import: merge or replace one scope from a JSON backup.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/import',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const body = JSON.parse(await readBody(req))
          if (!Array.isArray(body.items)) {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'items array is required' } })
            return
          }
          const wantGlobal = body.scope === 'global'
          const resolved = wantGlobal ? { storeKey: 'global', cwd: undefined } : resolveScopeParams(runtime, body)
          if (body.mode === 'replace') {
            // Destructive wholesale swap: park an undo point FIRST so POST /undo
            // can restore the previous contents of the scope.
            const previousIds = (await runtime.store.list(resolved.storeKey)).map((item) => item.id)
            const snapshots = await runtime.store.snapshotItems(resolved.storeKey, previousIds)
            if (snapshots.length > 0) await saveUndoSnapshot(runtime, resolved.storeKey, snapshots)
          }
          const incoming = []
          for (const raw of body.items.slice(0, 5000)) {
            if (raw === null || typeof raw !== 'object') continue
            const content = typeof raw.content === 'string' ? raw.content.trim() : ''
            if (content === '' || content.length > MAX_CONTENT_CHARS) continue
            const now = Date.now()
            incoming.push({
              // Invalid or missing ids get minted fresh — an undefined id in
              // the store breaks every later lookup.
              id: typeof raw.id === 'string' && raw.id.startsWith('mem_') ? raw.id : newId(),
              scope: resolved.storeKey === 'global' ? 'global' : 'project',
              content,
              type: MEMORY_TYPES.includes(raw.type) ? raw.type : 'fact',
              tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string').slice(0, 5) : [],
              links: Array.isArray(raw.links) ? raw.links.filter((edge) => edge !== null && typeof edge === 'object' && typeof edge.id === 'string').map((edge) => ({ id: edge.id, kind: typeof edge.kind === 'string' ? edge.kind : 'related' })) : [],
              origin: raw.origin === 'manual' || raw.origin === 'consolidation' ? raw.origin : 'auto',
              status: raw.status === 'archived' ? 'archived' : 'active',
              ...(raw.pinned === true ? { pinned: true } : {}),
              createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
              updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
              useCount: typeof raw.useCount === 'number' ? Math.max(0, Math.floor(raw.useCount)) : 0,
              // Round-trip preservation: recency bookkeeping and traceability.
              ...(typeof raw.lastUsedAt === 'number' ? { lastUsedAt: raw.lastUsedAt } : {}),
              ...(typeof raw.sourceSessionId === 'string' && raw.sourceSessionId !== '' ? { sourceSessionId: raw.sourceSessionId } : {}),
            })
          }
          let imported = 0
          const importedIds = []
          await runtime.store.mutateTx(resolved.storeKey, async (data) => {
            const items = data.items ?? []
            if (body.mode === 'replace') {
              data.items = incoming
              imported = incoming.length
              return
            }
            // Merge: skip exact id collisions (including within the backup
            // itself); literal near-dupes reinforce instead of duplicating.
            // Bigram sets are PRE-BUILT once per item — comparing M imports
            // against N existing items costs N+M tokenizations instead of
            // N×M — and periodic yields keep the event loop responsive while
            // a huge backup grinds through (the mutator is awaited inside the
            // file-locked critical section, so correctness is unaffected).
            const byId = new Map(items.map((item) => [item.id, item]))
            const existingGrams = items.map((item) => bigramSetOf(item.content))
            for (let index = 0; index < incoming.length; index += 1) {
              const item = incoming[index]
              if (byId.has(item.id)) continue
              const grams = bigramSetOf(item.content)
              let dup = false
              for (let cursor = 0; cursor < items.length; cursor += 1) {
                if (jaccardOf(existingGrams[cursor], grams) >= DEDUPE_THRESHOLD) {
                  items[cursor].useCount += 1
                  dup = true
                  break
                }
              }
              if (dup) continue
              items.push(item)
              existingGrams.push(grams)
              byId.set(item.id, item)
              importedIds.push(item.id)
              imported += 1
              if ((index & 127) === 127) await new Promise((resolve) => setImmediate(resolve))
            }
            data.items = items
          })
          if (body.mode === 'replace') {
            const knownIds = new Set(incoming.map((item) => item.id))
            void runtime.vectors.prune(resolved.storeKey, knownIds).catch(() => {})
          } else if (imported > 0) enqueueEmbed(runtime, resolved.storeKey, importedIds)
          send(res, 200, { ok: true, imported, mode: body.mode === 'replace' ? 'replace' : 'merge' })
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: import route',
  )

  // POST distill: remember one message's key points (assistant-actions button).
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/distill',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const config = runtime.config()
          if (config.enabled !== true) {
            send(res, 200, { ok: false, error: { code: 'disabled', message: 'memory is disabled in the dsh-memory settings' } })
            return
          }
          const body = JSON.parse(await readBody(req))
          if (typeof body.sessionId !== 'string' || typeof body.messageId !== 'string' || body.sessionId === '' || body.messageId === '') {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId and messageId are required' } })
            return
          }
          const result = await distillMessage(runtime, body.sessionId, body.messageId)
          send(res, 200, { ok: true, ...result })
        } catch (error) {
          send(res, error?.code === 'no-route' ? 409 : error?.code === 'message-not-found' || error?.code === 'session-not-found' ? 404 : error?.code === 'empty' ? 422 : 502, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: distill route',
  )

  // POST embed: backfill vectors for one scope's active items (bounded).
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/embed',
      method: 'POST',
      handler: async (req, res) => {
        if (!requirePost(req, res) || !guardLocal(req, res, true)) return
        try {
          const config = runtime.config()
          if (config.enabled !== true || config.embeddingsEnabled !== true) {
            send(res, 200, { ok: false, error: { code: 'disabled', message: 'embeddings are disabled in the dsh-memory settings' } })
            return
          }
          runtime.embedder.setRemoteHost(config.embeddingRemoteHost)
          const body = JSON.parse(await readBody(req))
          const wantGlobal = body.scope === 'global'
          const resolved = wantGlobal ? { storeKey: 'global' } : resolveScopeParams(runtime, body)
          if (!wantGlobal && resolved.storeKey === 'global') {
            send(res, 400, { ok: false, error: { code: 'no-workspace', message: 'project scope requires a session with a cwd' } })
            return
          }
          const items = (await runtime.store.list(resolved.storeKey)).filter((item) => item.status === 'active').slice(0, 200)
          const vmap = await runtime.vectors.load(resolved.storeKey)
          let queued = 0
          for (const item of items) {
            const existing = vmap.get(item.id)
            if (existing !== undefined && existing.at === item.updatedAt) continue
            enqueueEmbed(runtime, resolved.storeKey, [item.id])
            queued += 1
          }
          // Drain inline so the response reflects the completed backfill.
          await drainEmbed(runtime)
          send(res, 200, { ok: true, queued, embedder: { state: runtime.embedder.state } })
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: embed route',
  )

  // GET status: counters, pause state, last consolidation — the tab's status line.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/status',
      handler: async (req, res) => {
        if (!guardLocal(req, res, false)) return
        try {
          const config = runtime.config()
          send(res, 200, {
            ok: true,
            enabled: config.enabled === true,
            injectEnabled: config.injectEnabled === true,
            autoExtract: config.autoExtract === true,
            paused: runtime.paused,
            consecutiveFailures: runtime.consecutiveFailures,
            lastError: redactText(runtime.lastError),
            extracting: runtime.extractRunning,
            consolidating: runtime.consolidateRunning,
            hasRoute: config.extractProvider !== '' && config.extractModel !== '',
            hasManageRoute: (config.manageProvider ?? '') !== '' && (config.manageModel ?? '') !== '',
            consolidateEveryTurns: config.consolidateEveryTurns,
            turnCounts: runtime.state.turnCounts,
            lastConsolidation: runtime.state.lastConsolidation,
            counts: await runtime.store.counts(),
            extractQueue: runtime.extractQueue.length,
            consolidateQueue: runtime.consolidateQueue.length,
            embeddings: { enabled: config.embeddingsEnabled === true, state: runtime.embedder.state, lastError: redactText(runtime.embedder.lastError) },
            machineSessions: runtime.sessionKinds.size,
          })
        } catch (error) {
          send(res, 500, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: status route',
  )
}




//#endregion

export { name, inject }
// Exported for the smoke test: pure helpers and pipeline internals.
export const __test = {
  projectKeyFor,
  selectBriefing,
  parseCandidates,
  parseOps,
  buildTranscript,
  resolveRoute,
  resolveManageRoute,
  callModel,
  extractSession,
  consolidateScope,
  createRuntime,
  tokenize,
  similarity,
}

