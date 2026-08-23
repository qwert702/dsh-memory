/**
 * Memory plugin pure helpers: scope keys, similarity, tokenization,
 * relevance-scored briefing selection, small-model output parsers, and
 * transcript building. No services, no I/O — everything here is
 * unit-testable in isolation.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { cosine } from './embeddings.js'

/** Memory taxonomy rendered as colored dots in the browser half. */
export const MEMORY_TYPES = ['fact', 'preference', 'decision', 'pattern', 'entity']
/** Link kinds stored on edges. */
export const LINK_KINDS = ['related', 'supersedes', 'contradicts']
/** Candidate actions the extractor may request against existing memories. */
export const CANDIDATE_ACTIONS = ['add', 'update', 'supersede', 'contradict']
/** Hard ceiling for one memory's text. */
export const MAX_CONTENT_CHARS = 500
/** Near-duplicate threshold over character-bigram Jaccard similarity. */
export const DEDUPE_THRESHOLD = 0.65

/**
 * Normalize one workspace cwd into its project store key. Windows paths are
 * case-folded first so `D:\Work` and `d:\work` share one store.
 * @param cwd - absolute workspace root reported by the session header.
 * @returns the stable short store key (`p:<16 hex chars>`).
 */
export function projectKeyFor(cwd) {
  let norm = path.resolve(String(cwd)).replace(/[\\/]+$/, '')
  if (process.platform === 'win32') norm = norm.toLowerCase()
  return 'p:' + createHash('sha1').update(norm).digest('hex').slice(0, 16)
}

/**
 * Character bigrams of one normalized string, used by the near-duplicate check.
 * @param text - raw memory text.
 * @returns the bigram set.
 */
function bigrams(text) {
  const s = String(text).toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  for (let index = 0; index < s.length - 1; index += 1) set.add(s.slice(index, index + 2))
  if (s.length === 1) set.add(s)
  return set
}

/**
 * Jaccard similarity of two texts over character bigrams (0..1).
 * @param a - first text.
 * @param b - second text.
 * @returns similarity score.
 */
export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const gram of A) { if (B.has(gram)) shared += 1 }
  return shared / (A.size + B.size - shared)
}

/**
 * Tokenize one text for relevance matching: latin/digit words (>=2 chars)
 * plus CJK character bigrams, lowercased. Returns a Set for fast overlap.
 * @param text - arbitrary query text (recent conversation tail).
 * @returns the token set (possibly empty).
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const word of s.matchAll(/[a-z0-9][a-z0-9._-]+/g)) tokens.add(word[0])
  const cjk = s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g)
  if (cjk !== null && cjk !== undefined) {
    for (let index = 0; index < cjk.length - 1; index += 1) tokens.add(cjk[index] + cjk[index + 1])
    if (cjk.length === 1) tokens.add(cjk[0])
  }
  return tokens
}

/** Recency decay over days (~21-day half-life). */
function recencyScore(timestamp) {
  const days = Math.max(0, (Date.now() - timestamp) / 86_400_000)
  return Math.exp(-days / 21)
}

/**
 * Importance score: recency x reinforcement x graph degree. Pinned items are
 * handled separately by the picker and always outrank everything.
 * @param item - memory item.
 * @returns the score.
 */
function importanceScore(item) {
  const reinforcement = 1 + Math.log2(1 + item.useCount)
  const degree = Math.min(item.links.length, 3)
  return recencyScore(item.lastUsedAt ?? item.createdAt) * reinforcement * (1 + degree * 0.15)
}

/**
 * Relevance of one memory against the recent-conversation token set:
 * the fraction of query tokens the memory shares (0..1). Empty queries
 * yield 0 so pure-importance ordering applies unchanged.
 */
function lexicalRelevance(item, queryTokens) {
  if (queryTokens === undefined || queryTokens.size === 0) return 0
  const itemTokens = tokenize(item.content + ' ' + item.tags.join(' '))
  let shared = 0
  for (const token of queryTokens) { if (itemTokens.has(token)) shared += 1 }
  return shared / queryTokens.size
}

/**
 * Build the injected briefing text from both scopes under the caps.
 *
 * Pick order: pinned memories first (always carried, up to topK), then the
 * rest ranked by `importance x (1 + wLex x lexicalRelevance + wSem x
 * semanticSimilarity)` with an interleaved global/project sequence so neither
 * scope crowds the other out. When neither signal is available the ranking
 * degenerates to pure importance — the original behavior. Semantic scoring
 * only applies to entries that have a vector in `itemVectors`.
 * @param globalItems - global memories (any status).
 * @param projectItems - workspace memories (may be empty).
 * @param topK - maximum number of memories to include.
 * @param maxChars - character budget for the whole briefing body.
 * @param queryTokens - optional recent-conversation token set.
 * @param queryVector - optional embedding of the same recent text.
 * @param itemVectors - optional Map<id, vector> for candidate items.
 * @returns the briefing text ('' when nothing to say), picked ids, and how
 *   many were pinned.
 */
export function selectBriefing(globalItems, projectItems, topK, maxChars, queryTokens, queryVector, itemVectors) {
  const activeGlobal = globalItems.filter((item) => item.status === 'active')
  const activeProject = projectItems.filter((item) => item.status === 'active')
  const pinned = [...activeGlobal, ...activeProject].filter((item) => item.pinned === true)
  const hasQueryVector = Array.isArray(queryVector) && queryVector.length > 0 && itemVectors !== undefined && itemVectors.size > 0
  const rank = (list) => [...list].sort((a, b) => scoreOf(b) - scoreOf(a))
  function scoreOf(item) {
    let score = importanceScore(item) * (1 + 10 * lexicalRelevance(item, queryTokens))
    if (hasQueryVector) {
      const vec = itemVectors.get(item.id)
      if (vec !== undefined) {
        // Semantic similarity rescaled: MiniLM cosine for related text lands
        // ~0.5-0.9 and unrelated ~0-0.3, so stretch [0,1] around a 0.35 pivot.
        const stretched = Math.max(0, Math.min(1, (cosine(vec, queryVector) - 0.35) / 0.55))
        score *= 1 + 14 * stretched
      }
    }
    return score
  }
  const globals = rank(activeGlobal.filter((item) => item.pinned !== true))
  const projects = rank(activeProject.filter((item) => item.pinned !== true))
  const picked = []
  let gi = 0
  let pi = 0
  const budget = topK - Math.min(pinned.length, topK)
  while (picked.length < budget && (gi < globals.length || pi < projects.length)) {
    if (gi < globals.length && (pi >= projects.length || picked.length % 2 === 0)) picked.push(globals[gi++])
    else if (pi < projects.length) picked.push(projects[pi++])
    else break
  }
  const lines = []
  const ids = []
  let used = 0
  let pinnedCount = 0
  for (const item of [...pinned.slice(0, topK), ...picked]) {
    const prefix = item.scope === 'global' ? '【全局】' : '【项目】'
    const pinMark = item.pinned === true ? '📌' : ''
    const line = prefix + pinMark + item.content
    if (used + line.length > maxChars) continue
    lines.push(line)
    ids.push(item.id)
    used += line.length
    if (item.pinned === true) pinnedCount += 1
  }
  if (lines.length === 0) return { text: '', ids: [], pinnedCount: 0 }
  const text = [
    '<memory-briefing>',
    '以下是关于这位用户与当前项目的长期记忆速览，作为既有背景参考；与当前任务相关时可以运用，但不要复述或提及本清单：',
    ...lines,
    '</memory-briefing>',
  ].join('\n')
  return { text, ids, pinnedCount }
}

/**
 * Strip code fences and surrounding prose, then slice out the outermost JSON.
 * @param text - raw assistant output.
 * @param opener - opening bracket char.
 * @param closer - closing bracket char.
 * @returns the candidate JSON slice, or '' when absent.
 */
function jsonSlice(text, opener, closer) {
  let t = String(text).trim()
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const start = t.indexOf(opener)
  const end = t.lastIndexOf(closer)
  if (start < 0 || end <= start) return ''
  return t.slice(start, end + 1)
}

/**
 * Parse the extractor's output into validated memory candidates. The v2
 * protocol carries an action against the existing inventory:
 * `{action:'add'|'update'|'supersede'|'contradict', targetId}`. Plain v1
 * arrays (no action field) parse as `action:'add'`.
 * @param text - raw assistant text.
 * @returns at most 6 sanitized candidates ([] on any structural problem).
 */
export function parseCandidates(text) {
  const slice = jsonSlice(text, '[', ']')
  if (slice === '') return []
  let parsed
  try { parsed = JSON.parse(slice) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out = []
  for (const entry of parsed.slice(0, 6)) {
    if (entry === null || typeof entry !== 'object') continue
    const content = typeof entry.content === 'string' ? entry.content.trim() : ''
    if (content === '' || content.length > MAX_CONTENT_CHARS) continue
    const type = MEMORY_TYPES.includes(entry.type) ? entry.type : 'fact'
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim()).slice(0, 5)
      : []
    const hasTarget = typeof entry.targetId === 'string' && entry.targetId.startsWith('mem_')
    const action = CANDIDATE_ACTIONS.includes(entry.action) && (entry.action === 'add' || hasTarget)
      ? entry.action
      : 'add'
    out.push({ content, type, tags, action, targetId: hasTarget ? entry.targetId : null })
  }
  return out
}

/**
 * Parse the consolidator's op list, tolerating fences/prose.
 * @param text - raw assistant text.
 * @returns validated op objects ([] when unparseable).
 */
export function parseOps(text) {
  const slice = jsonSlice(text, '{', '}')
  if (slice === '') return []
  let parsed
  try { parsed = JSON.parse(slice) } catch { return [] }
  const ops = Array.isArray(parsed?.ops) ? parsed.ops : []
  const out = []
  for (const op of ops.slice(0, 50)) {
    if (op === null || typeof op !== 'object') continue
    if (op.op === 'merge' && typeof op.into === 'string' && Array.isArray(op.from)) {
      out.push({
        op: 'merge',
        into: op.into,
        from: op.from.filter((id) => typeof id === 'string'),
        content: typeof op.content === 'string' ? op.content.trim().slice(0, MAX_CONTENT_CHARS) : '',
      })
    } else if (op.op === 'link' && typeof op.a === 'string' && typeof op.b === 'string') {
      out.push({ op: 'link', a: op.a, b: op.b, kind: LINK_KINDS.includes(op.kind) ? op.kind : 'related' })
    } else if (op.op === 'archive' && typeof op.id === 'string') {
      out.push({ op: 'archive', id: op.id })
    } else if (op.op === 'retag' && typeof op.id === 'string' && Array.isArray(op.tags)) {
      out.push({ op: 'retag', id: op.id, tags: op.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 5) })
    }
  }
  return out
}

/**
 * Collect the text of one derived LLM message (string or block array).
 * @param message - derived message or undefined.
 * @returns concatenated text parts ('' when none).
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let total = ''
    for (const part of content) {
      if (part !== null && typeof part === 'object' && typeof part.text === 'string') total += part.text
    }
    return total
  }
  return ''
}

/**
 * Build the extraction transcript from the events newer than `sinceSeq`,
 * preserving the newest tail under the char budget.
 * @param session - session-like object (events + deriveEventMessage).
 * @param sinceSeq - exclusive lower bound of event seq to include.
 * @param budget - maximum transcript characters.
 * @returns `{ text, lastSeq }`; text '' when nothing new is replayable.
 */
export function buildTranscript(session, sinceSeq, budget) {
  const fresh = session.events.filter((event) => event.seq > sinceSeq && (event.type === 'user/message' || event.type === 'assistant/message'))
  const lines = []
  for (const event of fresh) {
    const derived = session.deriveEventMessage(event) ?? event.data?.message
    // Plugin-injected user messages (commander dispatch briefings, plugin
    // checkpoints) are machine-to-machine traffic, not human intent — they
    // would teach the extractor to remember task spam. The durable source
    // rides on the raw event payload; deriveEventMessage implementations may
    // or may not preserve it on the derived message.
    const sourceKind = event.data?.message?.source?.kind ?? derived?.source?.kind
    if (event.type === 'user/message' && sourceKind === 'plugin') continue
    const label = event.type === 'user/message' ? '用户' : '助手'
    const text = messageText(derived).trim()
    if (text === '') continue
    lines.push(`${label}：${text}`)
  }
  let text = lines.join('\n\n')
  if (text.length > budget) {
    const kept = []
    let used = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (used + line.length > budget && kept.length > 0) break
      // A single over-budget line is hard-truncated; count what we KEEP.
      const piece = used + line.length > budget ? line.slice(line.length - budget) : line
      kept.unshift(piece)
      used += piece.length
    }
    text = kept.join('\n\n')
  }
  const lastSeq = fresh.length > 0 ? fresh[fresh.length - 1].seq : sinceSeq
  return { text, lastSeq }
}

/**
 * Resolve the auxiliary-call route: the settings override pair wins, then the
 * session's own last routed request header.
 * @param config - resolved plugin settings.
 * @param header - the session's folded request header, if any.
 * @returns the provider/model pair, or undefined when neither is available.
 */
export function resolveRoute(config, header) {
  if (config.extractProvider !== '' && config.extractModel !== '') return { provider: config.extractProvider, model: config.extractModel }
  const routed = header?.config
  if (routed !== undefined && typeof routed.provider === 'string' && typeof routed.model === 'string' && routed.provider !== '' && routed.model !== '') {
    return { provider: routed.provider, model: routed.model }
  }
  return undefined
}

/**
 * Resolve the MEMORY-MANAGEMENT (consolidation) route: the dedicated
 * manage pair wins, then the extraction pair, then the session header.
 * Keeping management separate lets a cheap model handle frequent
 * extractions while a stronger model does the periodic reorganization.
 * @param config - resolved plugin settings.
 * @param header - the session's folded request header, if any.
 * @returns the provider/model pair, or undefined when neither is available.
 */
export function resolveManageRoute(config, header) {
  if (config.manageProvider !== undefined && config.manageModel !== undefined && config.manageProvider !== '' && config.manageModel !== '') {
    return { provider: config.manageProvider, model: config.manageModel }
  }
  return resolveRoute(config, header)
}
