/**
 * Memory plugin pure helpers: scope keys, similarity, briefing selection,
 * small-model output parsers, and transcript building. No services, no I/O —
 * everything here is unit-testable in isolation.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Memory taxonomy rendered as colored dots in the browser half. */
export const MEMORY_TYPES = ['fact', 'preference', 'decision', 'pattern', 'entity']
/** Link kinds stored on edges. */
export const LINK_KINDS = ['related', 'supersedes', 'contradicts']
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

/** Recency decay over days (~21-day half-life). */
function recencyScore(timestamp) {
  const days = Math.max(0, (Date.now() - timestamp) / 86_400_000)
  return Math.exp(-days / 21)
}

/**
 * Standing-briefing score: recency x reinforcement x graph degree. The prompt
 * assembly carries no query text, so ranking is importance-based rather than
 * keyword-based by design.
 * @param item - memory item.
 * @returns the score.
 */
function briefingScore(item) {
  const reinforcement = 1 + Math.log2(1 + item.useCount)
  const degree = Math.min(item.links.length, 3)
  return recencyScore(item.lastUsedAt ?? item.createdAt) * reinforcement * (1 + degree * 0.15)
}

/**
 * Build the injected briefing text from both scopes under the caps. Picks an
 * interleaved global/project sequence so neither scope can crowd the other
 * out entirely.
 * @param globalItems - global memories (any status).
 * @param projectItems - workspace memories (may be empty).
 * @param topK - maximum number of memories to include.
 * @param maxChars - character budget for the whole briefing body.
 * @returns the briefing text ('' when nothing to say) and the picked ids.
 */
export function selectBriefing(globalItems, projectItems, topK, maxChars) {
  const rank = (list) => [...list].sort((a, b) => briefingScore(b) - briefingScore(a))
  const globals = rank(globalItems.filter((item) => item.status === 'active'))
  const projects = rank(projectItems.filter((item) => item.status === 'active'))
  const picked = []
  let gi = 0
  let pi = 0
  while (picked.length < topK && (gi < globals.length || pi < projects.length)) {
    if (gi < globals.length && (pi >= projects.length || picked.length % 2 === 0)) picked.push(globals[gi++])
    else if (pi < projects.length) picked.push(projects[pi++])
    else break
  }
  const lines = []
  const ids = []
  let used = 0
  for (const item of picked) {
    const prefix = item.scope === 'global' ? '【全局】' : '【项目】'
    const line = prefix + item.content
    if (used + line.length > maxChars) continue
    lines.push(line)
    ids.push(item.id)
    used += line.length
  }
  if (lines.length === 0) return { text: '', ids: [] }
  const text = [
    '<memory-briefing>',
    '以下是关于这位用户与当前项目的长期记忆速览，作为既有背景参考；与当前任务相关时可以运用，但不要复述或提及本清单：',
    ...lines,
    '</memory-briefing>',
  ].join('\n')
  return { text, ids }
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
 * Parse the extractor's output into validated memory candidates.
 * @param text - raw assistant text.
 * @returns at most 5 sanitized candidates ([] on any structural problem).
 */
export function parseCandidates(text) {
  const slice = jsonSlice(text, '[', ']')
  if (slice === '') return []
  let parsed
  try { parsed = JSON.parse(slice) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out = []
  for (const entry of parsed.slice(0, 5)) {
    if (entry === null || typeof entry !== 'object') continue
    const content = typeof entry.content === 'string' ? entry.content.trim() : ''
    if (content === '' || content.length > MAX_CONTENT_CHARS) continue
    const type = MEMORY_TYPES.includes(entry.type) ? entry.type : 'fact'
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim()).slice(0, 5)
      : []
    out.push({ content, type, tags })
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
    const label = event.type === 'user/message' ? '用户' : '助手'
    const derived = session.deriveEventMessage(event) ?? event.data?.message
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
      kept.unshift(used + line.length > budget ? line.slice(line.length - budget) : line)
      used += line.length
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


