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
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage, contentHasImage } from '@deepseek-ai/dsh-llm'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { similarity, DEDUPE_THRESHOLD, MEMORY_TYPES, MAX_CONTENT_CHARS, projectKeyFor, selectBriefing, parseCandidates, parseOps, buildTranscript, resolveRoute, tokenize, messageText } from './util.js'
import { MemoryStore, PluginState, wireItem } from './store.js'

/** Cordis plugin name for the host half. */
const name = 'dsh-memory-host'
/** Services: routes, settings namespace, live sessions (cwd + replay), and the auxiliary-model caller. */
const inject = ['webServer', 'settings', 'sessions', 'llm']

/** Settings namespace holding the memory configuration. */
const NS = settingsNamespace('dsh-memory')
/** Schema: switches, the optional small-model route override, cadence, caps. */
const SCHEMA = z.object({
  enabled: z.boolean().default(true),
  injectEnabled: z.boolean().default(true),
  autoExtract: z.boolean().default(true),
  extractProvider: z.string().default(''),
  extractModel: z.string().default(''),
  consolidateEveryTurns: z.number().step(1).min(0).default(20),
  topK: z.number().step(1).min(1).max(32).default(8),
  maxInjectChars: z.number().min(200).default(1500),
  maxInputChars: z.number().min(2000).default(12000),
  maxTokens: z.number().min(256).default(1024),
  autoArchiveDays: z.number().step(1).min(0).default(90),
  memoryLocale: z.string().default(''),
})
/** Composition defaults when the settings namespace is absent. */
const DEFAULTS = {
  enabled: true,
  injectEnabled: true,
  autoExtract: true,
  extractProvider: '',
  extractModel: '',
  consolidateEveryTurns: 20,
  topK: 8,
  maxInjectChars: 1500,
  maxInputChars: 12000,
  maxTokens: 1024,
  autoArchiveDays: 90,
  memoryLocale: '',
}

/** Rolling per-session recent-user-text buffer for relevance scoring. */
const RECENT_CHARS = 2000
const RECENT_SESSIONS_MAX = 200

/** Reject bodies over 256 KiB before buffering. */
const MAX_BODY_BYTES = 256 * 1024
/** Consecutive extraction failures that pause automatic extraction. */
const PAUSE_AFTER_FAILURES = 3

//#region prompts -------------------------------------------------------------
/** Extraction directive appended after the replayed conversation tail. */
function extractInstruction(existingLines, memoryLocale) {
  const localeLine = memoryLocale === 'zh'
    ? '- 记忆内容一律使用中文书写。'
    : memoryLocale === 'en'
      ? '- Write every memory in English.'
      : '- 记忆内容使用这段对话的主要语言书写。'
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
    consolidateQueue: [],
    consolidateRunning: false,
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
  if (runtime.extractRunning || runtime.disposed) return
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
  }
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
  }
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
  if (runtime.consolidateRunning || runtime.disposed) return
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
  let route = resolveRoute(config, undefined)
  if (route === undefined && typeof sessionId === 'string' && sessionId !== '') {
    const session = runtime.ctx.sessions.get(sessionId)
    route = resolveRoute(config, session?.requestHeader?.() ?? undefined)
  }

  // Heuristic auto-archive of stale memories (never model-decided): untouched
  // past the window with no reinforcement and no links.
  const ops = []
  let archivedStale = 0
  if (config.autoArchiveDays > 0) {
    const cutoff = Date.now() - config.autoArchiveDays * 86_400_000
    for (const item of items.slice(-200)) {
      const lastTouch = item.lastUsedAt ?? item.updatedAt ?? item.createdAt
      if (lastTouch <= cutoff && item.useCount === 0 && item.links.length === 0) {
        ops.push({ op: 'archive', id: item.id, __auto: true })
        archivedStale += 1
      }
    }
  }

  if (route !== undefined) {
    const inventory = items.slice(-60).map((item) => `- [${item.id}] (${item.type}${item.tags.length > 0 ? ' #' + item.tags.join(' #') : ''}) ${item.content}`).join('\n')
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
  } else if (ops.length === 0) {
    throw Object.assign(new Error('no provider/model for consolidation: configure dsh-memory.extractProvider/extractModel'), { code: 'no-route' })
  }
  if (ops.length === 0) return { applied: 0, archivedStale: 0 }
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
  runtime.state.markConsolidated(storeKey, applied)
  return { applied, archivedStale }
}
//#endregion

//#region http helpers ----------------------------------------------------------
//#region undo snapshots --------------------------------------------------------
/** Undo snapshot file for one scope (`memory/undo/<key>.json`). */
function undoFileFor(storeKey) {
  const name = storeKey === 'global' ? 'global' : storeKey.slice(2)
  return path.join(dshHomePath('memory'), 'undo', `${name}.json`)
}

/** Dsh-home memory path join (local helper mirroring dshHomePath). */
function pathJoinMemory(...segments) {
  return path.join(dshHomePath('memory'), ...segments)
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
    await writeFile(file, JSON.stringify({ version: 1, storeKey, at: Date.now(), items: snapshots }, null, 2), 'utf8')
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
      await writeFile(file, JSON.stringify({ version: 1, storeKey, at: Date.now(), items: [] }, null, 2), 'utf8')
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

/** Error payload with its stable code. */
function errorPayload(error) {
  return { code: error?.code ?? 'internal', message: String(error instanceof Error ? error.message : error) }
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
  // Settings: installSettingsSection renders a web settings form from the
  // schema (token-viewer precedent); the plain register below is the fallback
  // when the section installer is unavailable in a stripped composition.
  let source = () => DEFAULTS
  let attached = false
  ctx.inject(['settings'], (sctx) => {
    try {
      installSettingsSection(ctx, NS, SCHEMA, { ...DEFAULTS }, {
        setSource: (current) => {
          attached = true
          source = () => ({ ...DEFAULTS, ...current() })
        },
        onChange: () => {},
      })
    } catch {
      const scope = sctx.settings.register(NS, SCHEMA)
      source = () => ({ ...DEFAULTS, ...scope.get() })
    }
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
            await runtime.store.mutate(storeKey, (items) => {
              const item = items.find((entry) => entry.id === id)
              if (item !== undefined) {
                item.useCount += 1
                item.lastUsedAt = Date.now()
              }
              return items
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
      const globals = await runtime.store.list('global')
      const projects = cwd === undefined ? [] : await runtime.store.list(projectKeyFor(cwd))
      const recentText = typeof session?.id === 'string' ? recent.get(session.id) ?? '' : ''
      const briefing = selectBriefing(globals, projects, config.topK, config.maxInjectChars, tokenize(recentText))
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

  // Extraction: watch committed turns, feed the relevance buffer, and queue
  // the finished session.
  ctx.on('session/event', (session, event) => {
    try {
      if (runtime.disposed) return
      if (event.type === 'user/message') {
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
        try {
          const body = JSON.parse(await readBody(req))
          if (typeof body.id !== 'string' || body.id === '') {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'id is required' } })
            return
          }
          const patch = {}
          if (typeof body.patch?.content === 'string') patch.content = body.patch.content
          if (typeof body.patch?.type === 'string') patch.type = body.patch.type
          if (Array.isArray(body.patch?.tags)) patch.tags = body.patch.tags.filter((tag) => typeof tag === 'string')
          if (body.patch?.status === 'active' || body.patch?.status === 'archived') patch.status = body.patch.status
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
        try {
          const body = JSON.parse(await readBody(req))
          if (typeof body.id !== 'string' || body.id === '') {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'id is required' } })
            return
          }
          await runtime.store.remove(body.id)
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
        try {
          if (runtime.config().enabled !== true) {
            send(res, 200, { ok: false, error: { code: 'disabled', message: 'memory is disabled in the dsh-memory settings' } })
            return
          }
          const body = JSON.parse(await readBody(req))
          const wantGlobal = body.scope === 'global'
          const resolved = wantGlobal ? { storeKey: 'global' } : resolveScopeParams(runtime, body)
          const applied = await consolidateScope(runtime, resolved.storeKey, typeof body.sessionId === 'string' ? body.sessionId : undefined)
          send(res, 200, { ok: true, applied, scope: resolved.storeKey === 'global' ? 'global' : 'project' })
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
        try {
          const config = runtime.config()
          if (config.enabled !== true) {
            send(res, 200, { ok: false, error: { code: 'disabled', message: 'memory is disabled in the dsh-memory settings' } })
            return
          }
          const body = JSON.parse(await readBody(req))
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
            return
          }
          const result = await extractSession(runtime, body.sessionId, body.force === true)
          send(res, 200, { ok: true, ...result })
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
        try {
          const body = JSON.parse(await readBody(req))
          if (!Array.isArray(body.items)) {
            send(res, 400, { ok: false, error: { code: 'bad-request', message: 'items array is required' } })
            return
          }
          const wantGlobal = body.scope === 'global'
          const resolved = wantGlobal ? { storeKey: 'global', cwd: undefined } : resolveScopeParams(runtime, body)
          const incoming = []
          for (const raw of body.items.slice(0, 5000)) {
            if (raw === null || typeof raw !== 'object') continue
            const content = typeof raw.content === 'string' ? raw.content.trim() : ''
            if (content === '' || content.length > MAX_CONTENT_CHARS) continue
            const now = Date.now()
            incoming.push({
              id: typeof raw.id === 'string' && raw.id.startsWith('mem_') ? raw.id : undefined,
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
            })
          }
          let imported = 0
          await runtime.store.mutateTx(resolved.storeKey, (data) => {
            const items = data.items ?? []
            const byId = new Map(items.map((item) => [item.id, item]))
            for (const item of incoming) {
              if (body.mode === 'replace') continue
              // Merge: skip exact id collisions; literal near-dupes reinforce.
              if (byId.has(item.id)) continue
              let dup = false
              for (const existing of items) {
                if (similarity(existing.content, item.content) >= DEDUPE_THRESHOLD) { existing.useCount += 1; dup = true; break }
              }
              if (dup) continue
              items.push(item)
              imported += 1
            }
            if (body.mode === 'replace') {
              data.items = incoming
              imported = incoming.length
            } else data.items = items
          })
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
          send(res, error?.code === 'no-route' ? 409 : error?.code === 'message-not-found' ? 404 : error?.code === 'empty' ? 422 : 502, { ok: false, error: errorPayload(error) })
        }
      },
    }),
    'dsh-memory: distill route',
  )

  // GET status: counters, pause state, last consolidation — the tab's status line.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/status',
      handler: async (req, res) => {
        try {
          const config = runtime.config()
          send(res, 200, {
            ok: true,
            enabled: config.enabled === true,
            injectEnabled: config.injectEnabled === true,
            autoExtract: config.autoExtract === true,
            paused: runtime.paused,
            consecutiveFailures: runtime.consecutiveFailures,
            lastError: runtime.lastError,
            extracting: runtime.extractRunning,
            consolidating: runtime.consolidateRunning,
            hasRoute: config.extractProvider !== '' && config.extractModel !== '',
            consolidateEveryTurns: config.consolidateEveryTurns,
            turnCounts: runtime.state.turnCounts,
            lastConsolidation: runtime.state.lastConsolidation,
            counts: await runtime.store.counts(),
            extractQueue: runtime.extractQueue.length,
            consolidateQueue: runtime.consolidateQueue.length,
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
  callModel,
  extractSession,
  consolidateScope,
  createRuntime,
  tokenize,
  similarity,
}

