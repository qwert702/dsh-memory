/**
 * Memory plugin embeddings: local semantic vectors via transformers.js.
 *
 * The whole module is fail-soft by design. `@huggingface/transformers` is an
 * OPTIONAL dependency — when it (or the model download) is unavailable, the
 * embedder reports a non-ready state and every caller degrades to the
 * lexical path. Nothing here can break extraction or injection.
 *
 * Vectors live in per-scope sidecar files (`memory/vectors/<key>.json`),
 * separate from the main store so the human-readable memory files stay
 * small. They are a CACHE keyed by item id: a vector is valid while the
 * item's updatedAt matches the timestamp recorded at embed time; stale or
 * missing vectors simply mean "lexical scoring only" until the backfill
 * queue catches up.
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The embedding model served through transformers.js (384 dims, quantized). */
export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIM = 384

/**
 * Self-healing backoff schedule for failed model loads (module-level state,
 * review P2-15): the first automatic retry waits 60s after the failure, then
 * doubles per further failure, capped at 30 minutes. A successful load resets
 * the schedule. Shared across EmbedderManager instances by design.
 */
const LOAD_RETRY_BASE_MS = 60_000
const LOAD_RETRY_MAX_MS = 30 * 60_000
let failedLoadCount = 0
let lastLoadAttemptMs = 0

/** Wait before the next automatic retry after `failures` consecutive failures. */
function retryDelayFor(failures) {
  if (failures <= 0) return LOAD_RETRY_BASE_MS
  return Math.min(LOAD_RETRY_BASE_MS * 2 ** (failures - 1), LOAD_RETRY_MAX_MS)
}

/** Ceiling for one inference batch; past it the batch fails and the serial queue moves on. */
const INFERENCE_TIMEOUT_MS = 30_000

/**
 * Reject unless `promise` settles within `ms`. Used so one hung inference
 * call cannot occupy the serialized pipeline slot permanently. The losing
 * promise is abandoned — Promise.race already subscribed to it, so its
 * eventual settlement raises no unhandled rejection.
 */
function withTimeout(promise, ms, label) {
  let timer
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer))
}

/**
 * Cosine similarity of two equal-length numeric vectors, explicitly divided
 * by the vector norms (no reliance on upstream normalization; clamped to
 * 0..1). Vectors containing non-finite components and zero-norm vectors
 * score 0.
 * @param a - first vector.
 * @param b - second vector.
 * @returns similarity clamped to [0, 1].
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]
    const y = b[index]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  // Non-finite components poison every accumulator -> score 0.
  if (!Number.isFinite(dot) || !Number.isFinite(normA) || !Number.isFinite(normB)) return 0
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (!(denom > 0)) return 0
  return Math.max(0, Math.min(1, dot / denom))
}

/** Round vector components to keep the JSON sidecar compact. */
function roundVec(vec) {
  return vec.map((x) => Math.round(x * 10000) / 10000)
}

/**
 * Lazy transformers.js pipeline holder. States: 'idle' (never tried),
 * 'loading', 'ready', 'unavailable' (optional lib missing), 'failed:<msg>'
 * (lib present but model download/load failed).
 */
export class EmbedderManager {
  #state = 'idle'
  #pipeline = undefined
  /** Serializes inference runs; failures do not break the chain. */
  #chain = Promise.resolve()
  #remoteHost = ''
  #triedHost = ''

  /** @returns 'idle' | 'loading' | 'ready' | 'unavailable' | string starting with 'failed'. */
  get state() { return this.#state }

  /**
   * Configure the download endpoint BEFORE first load (hf-mirror friendly).
   * Changing the host on a failed embedder makes it retryable: a different
   * endpoint is worth one more attempt.
   * @param remoteHost - override for the HF-compatible host ('' = official).
   */
  setRemoteHost(remoteHost) {
    const host = typeof remoteHost === 'string' ? remoteHost : ''
    if (host !== this.#remoteHost && this.#state.startsWith('failed')) {
      this.#state = 'idle'
      this.#pipeline = undefined
      failedLoadCount = 0
    }
    this.#remoteHost = host
  }

  /**
   * Load the feature-extraction pipeline once. Never throws: failures move
   * the manager into a failed/unavailable state (retryable via reset()).
   * @returns the pipeline, or undefined when unusable.
   */
  async get() {
    if (this.#state === 'ready') return this.#pipeline
    if (this.#state.startsWith('failed')) {
      // Self-healing (review P2-15): a transient download/load failure used
      // to wedge semantic recall until restart. Once the backoff window has
      // elapsed, fall through into ONE fresh load attempt; get() still never
      // throws — another failure just re-arms a longer backoff.
      if (Date.now() - lastLoadAttemptMs < retryDelayFor(failedLoadCount)) return undefined
      this.#state = 'idle'
      this.#pipeline = undefined
    }
    if (this.#state !== 'idle') return undefined
    this.#triedHost = this.#remoteHost
    this.#state = 'loading'
    lastLoadAttemptMs = Date.now()
    try {
      let mod
      try {
        mod = await import('@huggingface/transformers')
      } catch {
        mod = await import('transformers')
      }
      if (this.#remoteHost !== '') mod.env.remoteHost = this.#remoteHost
      this.#pipeline = await mod.pipeline('feature-extraction', EMBEDDING_MODEL_ID)
      this.#state = 'ready'
      failedLoadCount = 0
      return this.#pipeline
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#state = /Cannot find module|not find/i.test(message) ? 'unavailable' : `failed:${message.slice(0, 160)}`
      failedLoadCount += 1
      return undefined
    }
  }

  /**
   * Embed a batch of texts (mean pooling + L2 normalization). Calls are
   * serialized through an internal promise chain so concurrent callers share
   * one pipeline instance safely.
   * @param texts - strings to embed.
   * @returns array of vectors aligned with inputs, or undefined when the
   *   embedder cannot serve (callers must fall back to lexical).
   */
  embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return Promise.resolve([])
    const run = this.#chain.then(() => this.#run(texts))
    this.#chain = run.catch(() => undefined)
    return run
  }

  async #run(texts) {
    const pipe = await this.get()
    if (pipe === undefined) return undefined
    try {
      // 30s watchdog: one hung inference call must not hold the serialized
      // chain slot forever. Timing out counts as THIS batch's failure (the
      // abandoned promise's eventual settlement is ignored) and frees the
      // slot for the next queued batch. The download phase inside get() is
      // deliberately NOT timed out — the failed-state self-healing retry
      // covers that case.
      const output = await withTimeout(pipe(texts, { pooling: 'mean', normalize: true }), INFERENCE_TIMEOUT_MS, 'embedding inference')
      const list = typeof output.tolist === 'function'
        ? output.tolist()
        : Array.from({ length: texts.length }, (_, i) => Array.from(output[i].tolist?.() ?? []))
      return list.map((vec) => roundVec(Array.from(vec)))
    } catch (error) {
      // Transient inference errors must not brick future batches: keep state
      // 'ready' but report failure for THIS batch only.
      this.#lastError = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  #lastError = ''

  /** @returns the most recent inference error ('' when none). */
  get lastError() { return this.#lastError }

  /**
   * Retry a previously failed/unavailable embedder (settings change). Also
   * clears the automatic-retry backoff schedule.
   */
  reset() {
    if (this.#state !== 'ready') {
      this.#state = 'idle'
      this.#pipeline = undefined
      this.#lastError = ''
      failedLoadCount = 0
    }
  }
}

/**
 * Per-scope vector cache: `memory/vectors/<storeKey>.json` mapping id ->
 * `{ v, at }`, where `at` is the item's updatedAt at embed time. Same
 * mtime+size validation pattern as MemoryStore.
 */
export class VectorStore {
  #cache = new Map()

  fileFor(storeKey) {
    const name = storeKey === 'global' ? 'global' : storeKey.slice(2)
    return path.join(dshHomePath('memory'), 'vectors', `${name}.json`)
  }

  /**
   * Read one scope's vectors (mtime+size validated cache).
   * @param storeKey - target scope.
   * @returns Map<id, {v:number[], at:number}>.
   */
  async load(storeKey) {
    const file = this.fileFor(storeKey)
    let mtimeMs = 0
    let size = 0
    try {
      const info = await stat(file)
      mtimeMs = info.mtimeMs
      size = info.size
    } catch {}
    const cached = this.#cache.get(storeKey)
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) return cached.map
    const map = new Map()
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      // Header gate (review P2-13): accept entries only from a sidecar
      // written by the SAME model at the SAME dimensionality. Anything else
      // — model swap, foreign sidecar, legacy file without a usable header —
      // leaves the map empty so the backfill queue rebuilds it naturally.
      const headerValid = parsed !== null && typeof parsed === 'object'
        && parsed.model === EMBEDDING_MODEL_ID
        && parsed.dim === EMBEDDING_DIM
        && parsed.items !== null && typeof parsed.items === 'object'
      if (headerValid) {
        for (const [id, entry] of Object.entries(parsed.items)) {
          if (entry !== null && typeof entry === 'object' && Array.isArray(entry.v) && entry.v.length === EMBEDDING_DIM) {
            map.set(id, { v: entry.v, at: typeof entry.at === 'number' ? entry.at : 0 })
          }
        }
      }
    } catch {}
    this.#cache.set(storeKey, { map, mtimeMs, size })
    return map
  }

  /**
   * Persist one scope's vector map atomically.
   * @param storeKey - target scope.
   * @param map - the complete next map.
   */
  async save(storeKey, map) {
    const file = this.fileFor(storeKey)
    await mkdir(path.dirname(file), { recursive: true })
    const items = {}
    for (const [id, entry] of map) items[id] = entry
    await writeFileAtomic(file, JSON.stringify({ version: 1, model: EMBEDDING_MODEL_ID, dim: EMBEDDING_DIM, items }, null, 1), { mode: 0o600, dirMode: 0o700 })
    let mtimeMs = 0
    let size = 0
    try {
      const info = await stat(file)
      mtimeMs = info.mtimeMs
      size = info.size
    } catch {}
    this.#cache.set(storeKey, { map, mtimeMs, size })
  }

  /**
   * Drop ids that no longer exist in the store (called after removes).
   * @param storeKey - target scope.
   * @param knownIds - Set of ids currently present in the store.
   */
  async prune(storeKey, knownIds) {
    const map = await this.load(storeKey)
    let changed = false
    for (const id of [...map.keys()]) {
      if (!knownIds.has(id)) { map.delete(id); changed = true }
    }
    if (changed) await this.save(storeKey, map)
  }
}
