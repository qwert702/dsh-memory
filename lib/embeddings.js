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
 * Cosine similarity of two equal-length numeric vectors (0..1 after
 * normalization clamp). Zero-length vectors score 0.
 * @param a - first vector.
 * @param b - second vector.
 * @returns similarity clamped to [0, 1].
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index]
  return Math.max(0, Math.min(1, dot))
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
    if (this.#state !== 'idle') return undefined
    this.#triedHost = this.#remoteHost
    this.#state = 'loading'
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
      return this.#pipeline
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#state = /Cannot find module|not find/i.test(message) ? 'unavailable' : `failed:${message.slice(0, 160)}`
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
      const output = await pipe(texts, { pooling: 'mean', normalize: true })
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

  /** Retry a previously failed/unavailable embedder (settings change). */
  reset() {
    if (this.#state !== 'ready') {
      this.#state = 'idle'
      this.#pipeline = undefined
      this.#lastError = ''
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
      if (parsed !== null && typeof parsed === 'object' && parsed.items !== null && typeof parsed.items === 'object') {
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
