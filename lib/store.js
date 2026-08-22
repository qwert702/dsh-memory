/**
 * Memory plugin persistence: the two-scope JSON store and the durable
 * cross-restart state (extraction cursors, turn counters, consolidation
 * records). Files live under `<dsh-home>/memory/` and are committed through
 * the atomic-write service so readers never see partial writes.
 */
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { similarity, DEDUPE_THRESHOLD } from './util.js'

let idCounter = 0

/** Mint a collision-proof memory id. */
export function newId() {
  idCounter += 1
  return `mem_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Sanitize an item for the wire: keep display data, drop internals. */
export function wireItem(item) {
  return {
    id: item.id,
    scope: item.scope,
    content: item.content,
    type: item.type,
    tags: item.tags,
    links: item.links,
    origin: item.origin,
    status: item.status,
    cwd: item.cwd,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastUsedAt: item.lastUsedAt,
    useCount: item.useCount,
  }
}

/** Error with a stable machine code for the browser half. */
function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Plain-JSON memory store: one global file plus one file per project hash.
 * Reads go through a per-file in-memory cache (the host is the single owner);
 * mutations are serialized per store key through a promise chain.
 */
export class MemoryStore {
  #cache = new Map()
  #locks = new Map()

  /** File path of one store key (`global` or `p:<hash>`). */
  fileFor(storeKey) {
    return storeKey === 'global'
      ? path.join(dshHomePath('memory'), 'global.json')
      : path.join(dshHomePath('memory'), 'projects', `${storeKey.slice(2)}.json`)
  }

  /**
   * Run one mutation under the store key's lock.
   * @param storeKey - the scope being mutated.
   * @param fn - the serialized mutation.
   * @returns the mutation's result.
   */
  locked(storeKey, fn) {
    const previous = this.#locks.get(storeKey) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.#locks.set(storeKey, next.catch(() => undefined))
    return next
  }

  #emptyStore(storeKey) {
    return { version: 1, kind: storeKey === 'global' ? 'global' : 'project', items: [] }
  }

  /**
   * Read one store file (cached after first load).
   * @param storeKey - the scope to load.
   * @returns the parsed file shell (always has `items`).
   */
  async loadStore(storeKey) {
    const cached = this.#cache.get(storeKey)
    if (cached !== undefined) return cached
    const data = this.#emptyStore(storeKey)
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(storeKey), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
        data.cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined
        data.items = parsed.items
      }
    } catch {}
    this.#cache.set(storeKey, data)
    return data
  }

  /**
   * Persist one store file atomically (cache updated first).
   * @param storeKey - the scope being written.
   * @param data - the complete next file content.
   */
  async saveStore(storeKey, data) {
    this.#cache.set(storeKey, data)
    const file = this.fileFor(storeKey)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, JSON.stringify(data, null, 2), { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * List one scope's items (including archived).
   * @param storeKey - the scope.
   * @returns the item array.
   */
  async list(storeKey) {
    const data = await this.loadStore(storeKey)
    return data.items ?? []
  }

  /**
   * Insert one item, or reinforce a near-duplicate already present.
   * @param storeKey - target scope.
   * @param draft - `{content,type,tags,origin,cwd?,sourceSessionId?}`.
   * @returns the resulting item and whether it was newly created.
   */
  addOrReinforce(storeKey, draft) {
    return this.locked(storeKey, async () => {
      const data = await this.loadStore(storeKey)
      const items = data.items ?? []
      const now = Date.now()
      let match
      let best = 0
      for (const existing of items) {
        const score = similarity(existing.content, draft.content)
        if (score > best) { best = score; match = existing }
      }
      if (match !== undefined && best >= DEDUPE_THRESHOLD) {
        match.useCount += 1
        match.lastUsedAt = now
        match.updatedAt = now
        if (draft.sourceSessionId !== undefined) match.sourceSessionId = draft.sourceSessionId
        await this.saveStore(storeKey, data)
        return { item: match, created: false }
      }
      const item = {
        id: newId(),
        scope: storeKey === 'global' ? 'global' : 'project',
        content: draft.content,
        type: draft.type,
        tags: draft.tags,
        links: [],
        origin: draft.origin,
        status: 'active',
        ...(draft.sourceSessionId === undefined ? {} : { sourceSessionId: draft.sourceSessionId }),
        ...(storeKey === 'global' ? {} : { cwd: draft.cwd }),
        createdAt: now,
        updatedAt: now,
        useCount: 0,
      }
      items.push(item)
      await this.saveStore(storeKey, data)
      return { item, created: true }
    })
  }

  /**
   * Apply one mutation to a store's items under its lock and persist.
   * @param storeKey - target scope.
   * @param mutator - receives the items array (mutate in place).
   */
  async mutate(storeKey, mutator) {
    await this.locked(storeKey, async () => {
      const data = await this.loadStore(storeKey)
      data.items = (await mutator(data.items ?? [])) ?? data.items
      await this.saveStore(storeKey, data)
    })
  }

  /**
   * Locate the store key holding one id by scanning global + all project files.
   * @param id - memory id.
   * @returns the owning store key, or undefined.
   */
  async findStoreOf(id) {
    if (typeof id !== 'string' || id === '') return undefined
    const globalData = await this.loadStore('global')
    if ((globalData.items ?? []).some((item) => item.id === id)) return 'global'
    let files = []
    try { files = await readdir(path.join(dshHomePath('memory'), 'projects')) } catch { return undefined }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const storeKey = `p:${file.slice(0, -5)}`
      const data = await this.loadStore(storeKey)
      if ((data.items ?? []).some((item) => item.id === id)) return storeKey
    }
    return undefined
  }

  /**
   * Add symmetric link edges between two items in the same store.
   * @param a - one endpoint id.
   * @param b - the other endpoint id.
   * @param kind - edge kind.
   */
  async link(a, b, kind) {
    const storeKeyA = await this.findStoreOf(a)
    const storeKeyB = await this.findStoreOf(b)
    if (storeKeyA === undefined || storeKeyB === undefined) throw coded('not-found', 'memory not found')
    if (storeKeyA !== storeKeyB) throw coded('cross-scope', 'both memories must live in the same scope')
    if (a === b) throw coded('self-link', 'cannot link a memory to itself')
    await this.mutate(storeKeyA, (items) => {
      for (const [from, to] of [[a, b], [b, a]]) {
        const item = items.find((entry) => entry.id === from)
        if (item === undefined) throw coded('not-found', 'memory not found')
        if (!item.links.some((edge) => edge.id === to)) item.links.push({ id: to, kind })
        item.updatedAt = Date.now()
      }
      return items
    })
  }

  /**
   * Remove one link edge (either direction spelling).
   * @param a - one endpoint id.
   * @param b - the other endpoint id.
   */
  async unlink(a, b) {
    const storeKey = await this.findStoreOf(a)
    if (storeKey === undefined) throw coded('not-found', 'memory not found')
    await this.mutate(storeKey, (items) => {
      for (const [from, to] of [[a, b], [b, a]]) {
        const item = items.find((entry) => entry.id === from)
        if (item !== undefined) {
          item.links = item.links.filter((edge) => edge.id !== to)
          item.updatedAt = Date.now()
        }
      }
      return items
    })
  }

  /**
   * Update one item by id within whatever store holds it.
   * @param id - memory id.
   * @param patch - `{content?,type?,tags?,status?}`.
   * @returns the updated item.
   */
  async update(id, patch) {
    const storeKey = await this.findStoreOf(id)
    if (storeKey === undefined) throw coded('not-found', 'memory not found')
    return this.locked(storeKey, async () => {
      const data = await this.loadStore(storeKey)
      const item = (data.items ?? []).find((entry) => entry.id === id)
      if (item === undefined) throw coded('not-found', 'memory not found')
      if (typeof patch.content === 'string' && patch.content.trim() !== '') item.content = patch.content.trim()
      if (typeof patch.type === 'string') item.type = patch.type
      if (Array.isArray(patch.tags)) item.tags = patch.tags.slice(0, 5)
      if (patch.status === 'active' || patch.status === 'archived') item.status = patch.status
      item.updatedAt = Date.now()
      await this.saveStore(storeKey, data)
      return item
    })
  }

  /**
   * Delete one item outright from whichever store holds it.
   * @param id - memory id.
   */
  async remove(id) {
    const storeKey = await this.findStoreOf(id)
    if (storeKey === undefined) throw coded('not-found', 'memory not found')
    await this.mutate(storeKey, (items) => items.filter((entry) => entry.id !== id))
  }

  /**
   * Graph projection of one scope: active nodes with degree + undirected edges.
   * @param storeKey - the scope.
   * @returns nodes/edges for the browser half's canvas renderer.
   */
  async graph(storeKey) {
    const items = (await this.list(storeKey)).filter((item) => item.status === 'active')
    const known = new Set(items.map((item) => item.id))
    const seen = new Set()
    const edges = []
    for (const item of items) {
      for (const edge of item.links) {
        if (!known.has(edge.id)) continue
        const key = [item.id, edge.id].sort().join('~')
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ a: item.id, b: edge.id, kind: edge.kind })
      }
    }
    const nodes = items.map((item) => ({
      id: item.id,
      label: item.content.length > 24 ? `${item.content.slice(0, 24)}…` : item.content,
      type: item.type,
      useCount: item.useCount,
      degree: item.links.filter((edge) => known.has(edge.id)).length,
    }))
    return { nodes, edges }
  }

  /** @returns per-scope counts across all known stores. */
  async counts() {
    const summarize = (items) => ({
      active: items.filter((item) => item.status === 'active').length,
      archived: items.filter((item) => item.status === 'archived').length,
    })
    const out = { global: summarize(await this.list('global')), projects: [] }
    let files = []
    try { files = await readdir(path.join(dshHomePath('memory'), 'projects')).catch(() => []) } catch {}
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const storeKey = `p:${file.slice(0, -5)}`
      const data = await this.loadStore(storeKey)
      out.projects.push({ key: storeKey, cwd: data.cwd, ...summarize(data.items ?? []) })
    }
    return out
  }
}

/**
 * Durable cross-restart bookkeeping: extraction cursors per session,
 * extracted-turn counters and last-consolidation records per scope. Flushed
 * through a debounced atomic write.
 */
export class PluginState {
  #data = { version: 1, cursors: {}, turnCounts: {}, lastConsolidation: {} }
  #dirty = false
  #timer

  /** Hydrate from disk once at plugin startup. */
  async load() {
    try {
      const parsed = JSON.parse(await readFile(path.join(dshHomePath('memory'), 'state.json'), 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        this.#data = {
          version: 1,
          cursors: parsed.cursors ?? {},
          turnCounts: parsed.turnCounts ?? {},
          lastConsolidation: parsed.lastConsolidation ?? {},
        }
      }
    } catch {}
  }

  #scheduleFlush() {
    this.#dirty = true
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void (async () => {
        if (!this.#dirty) return
        this.#dirty = false
        try {
          const file = path.join(dshHomePath('memory'), 'state.json')
          await mkdir(path.dirname(file), { recursive: true })
          await writeFileAtomic(file, JSON.stringify(this.#data, null, 2), { mode: 0o600, dirMode: 0o700 })
        } catch {}
      })()
    }, 800)
  }

  /** @returns the persisted extraction cursor map. */
  get cursors() { return this.#data.cursors }

  /** @returns the per-scope extracted-turn counter map. */
  get turnCounts() { return this.#data.turnCounts }

  /** @returns the per-scope last-consolidation record map. */
  get lastConsolidation() { return this.#data.lastConsolidation }

  /**
   * Advance one session's extraction cursor.
   * @param sessionId - the processed session.
   * @param seq - the highest processed event seq.
   */
  setCursor(sessionId, seq) {
    if (this.#data.cursors[sessionId] === seq) return
    this.#data.cursors[sessionId] = seq
    this.#scheduleFlush()
  }

  /**
   * Bump one scope's extracted-turn counter.
   * @param storeKey - the scope.
   * @returns the new count.
   */
  bumpTurn(storeKey) {
    const next = (this.#data.turnCounts[storeKey] ?? 0) + 1
    this.#data.turnCounts[storeKey] = next
    this.#scheduleFlush()
    return next
  }

  /**
   * Reset one scope's counter after consolidation and record the run.
   * @param storeKey - the scope.
   * @param applied - how many ops were applied.
   */
  markConsolidated(storeKey, applied) {
    this.#data.turnCounts[storeKey] = 0
    this.#data.lastConsolidation[storeKey] = { at: Date.now(), applied }
    this.#scheduleFlush()
  }
}

