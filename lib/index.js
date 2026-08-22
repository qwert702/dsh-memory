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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage, contentHasImage } from '@deepseek-ai/dsh-llm'
import { MEMORY_TYPES, MAX_CONTENT_CHARS, projectKeyFor, selectBriefing, parseCandidates, parseOps, buildTranscript, resolveRoute } from './util.js'
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
}

/** Reject bodies over 256 KiB before buffering. */
const MAX_BODY_BYTES = 256 * 1024
/** Consecutive extraction failures that pause automatic extraction. */
const PAUSE_AFTER_FAILURES = 3

//#region prompts -------------------------------------------------------------
/** Extraction directive appended after the replayed conversation tail. */
const EXTRACT_INSTRUCTION = [
  '你在为一个人工智能助手的长期记忆系统工作。上面是一段对话记录。',
  '请从中提取值得长期记住的信息（用户的事实与偏好、项目的决定与约定、可复用的经验模式、重要实体），输出一个 JSON 数组：',
  '[{"content":"一句话记忆","type":"fact|preference|decision|pattern|entity","tags":["标签"]}]',
  '要求：',
  '- 只提取持久信息：忽略一次性任务细节、寒暄、具体代码内容本身；',
  '- 每条一句话、不超过 80 字、脱离对话也能独立理解；',
  '- 最多 5 条；没有值得记住的就输出 []；',
  '- 只输出 JSON 数组本身，不要任何解释或代码块标记。',
].join('\n')

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
  const reply = await callModel(runtime.ctx.llm, {
    provider: route.provider,
    model: route.model,
    maxTokens: config.maxTokens,
    messages: [createUserMessage({
      content: [{ type: 'text', text: `${text}\n\n${EXTRACT_INSTRUCTION}` }],
      source: { kind: 'plugin', plugin: 'dsh-memory' },
    })],
  })
  const candidates = parseCandidates(reply)
  let added = 0
  let reinforced = 0
  for (const candidate of candidates) {
    const result = await runtime.store.addOrReinforce(storeKey, {
      content: candidate.content,
      type: candidate.type,
      tags: candidate.tags,
      origin: 'auto',
      sourceSessionId: sessionId,
      ...(storeKey === 'global' || cwd === undefined ? {} : { cwd }),
    })
    if (result.created) added += 1
    else reinforced += 1
  }
  runtime.state.setCursor(sessionId, Math.max(lastEventSeq, sinceSeq))
  runtime.consecutiveFailures = 0
  runtime.paused = false
  runtime.lastError = ''
  if (candidates.length > 0 && config.consolidateEveryTurns > 0) {
    const turns = runtime.state.bumpTurn(storeKey)
    if (turns >= config.consolidateEveryTurns) enqueueConsolidation(runtime, storeKey)
  }
  return { added, reinforced }
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
  if (config.enabled !== true) return 0
  const items = (await runtime.store.list(storeKey)).filter((item) => item.status === 'active')
  if (items.length < 4) return 0
  let route = resolveRoute(config, undefined)
  if (route === undefined && typeof sessionId === 'string' && sessionId !== '') {
    const session = runtime.ctx.sessions.get(sessionId)
    route = resolveRoute(config, session?.requestHeader?.() ?? undefined)
  }
  if (route === undefined) {
    throw Object.assign(new Error('no provider/model for consolidation: configure dsh-memory.extractProvider/extractModel'), { code: 'no-route' })
  }
  const inventory = items.slice(-60).map((item) => `- [${item.id}] (${item.type}${item.tags.length > 0 ? ' #' + item.tags.join(' #') : ''}) ${item.content}`).join('\n')
  const reply = await callModel(runtime.ctx.llm, {
    provider: route.provider,
    model: route.model,
    maxTokens: config.maxTokens,
    messages: [createUserMessage({
      content: [{ type: 'text', text: `${CONSOLIDATE_INSTRUCTION}\n\n${inventory}` }],
      source: { kind: 'plugin', plugin: 'dsh-memory' },
    })],
  })
  const ops = parseOps(reply)
  const known = new Map(items.map((item) => [item.id, item]))
  let applied = 0
  const now = Date.now()
  for (const op of ops) {
    if (op.op === 'merge') {
      const into = known.get(op.into)
      if (into === undefined) continue
      const froms = op.from.map((id) => known.get(id)).filter((entry) => entry !== undefined && entry.id !== into.id)
      if (froms.length === 0) continue
      if (op.content !== '') into.content = op.content
      into.origin = 'consolidation'
      into.updatedAt = now
      for (const from of froms) {
        from.status = 'archived'
        from.updatedAt = now
        if (!into.links.some((edge) => edge.id === from.id)) into.links.push({ id: from.id, kind: 'supersedes' })
      }
      applied += 1
    } else if (op.op === 'link') {
      const a = known.get(op.a)
      const b = known.get(op.b)
      if (a !== undefined && b !== undefined && op.a !== op.b && !a.links.some((edge) => edge.id === op.b)) {
        a.links.push({ id: op.b, kind: op.kind })
        b.links.push({ id: op.a, kind: op.kind })
        a.updatedAt = now
        b.updatedAt = now
        applied += 1
      }
    } else if (op.op === 'archive') {
      const item = known.get(op.id)
      if (item !== undefined && item.status === 'active') {
        item.status = 'archived'
        item.updatedAt = now
        applied += 1
      }
    } else if (op.op === 'retag') {
      const item = known.get(op.id)
      if (item !== undefined) {
        item.tags = op.tags
        item.updatedAt = now
        applied += 1
      }
    }
  }
  if (applied > 0) await runtime.store.mutate(storeKey, (current) => current.map((item) => known.get(item.id) ?? item))
  runtime.state.markConsolidated(storeKey, applied)
  return applied
}
//#endregion

//#region http helpers ----------------------------------------------------------
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
  let source = () => DEFAULTS
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, SCHEMA)
    source = () => ({ ...DEFAULTS, ...scope.get() })
  })

  const runtime = createRuntime(ctx, () => source())
  runtime.ready = runtime.state.load()

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
  // any error returns the assembly untouched so requests never break.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      const config = runtime.config()
      if (config.enabled !== true || config.injectEnabled !== true || runtime.disposed) return assembled
      const agent = context?.agent
      const cwd = agent?.session?.header?.cwd
      const globals = await runtime.store.list('global')
      const projects = cwd === undefined ? [] : await runtime.store.list(projectKeyFor(cwd))
      const briefing = selectBriefing(globals, projects, config.topK, config.maxInjectChars)
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

  // Extraction: watch committed turns and queue the finished session.
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'turn/end' || runtime.disposed) return
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

  // POST items: manual add.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-memory/items',
      method: 'POST',
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
          const result = await runtime.store.addOrReinforce(resolved.storeKey, {
            content,
            type,
            tags,
            origin: 'manual',
            ...(resolved.cwd === undefined || resolved.storeKey === 'global' ? {} : { cwd: resolved.cwd }),
          })
          send(res, 200, { ok: true, created: result.created, item: wireItem(result.item) })
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
}

