/**
 * Memory plugin persistence: the two-scope JSON store and the durable
 * cross-restart state (extraction cursors, turn counters, consolidation
 * records). Files live under `<dsh-home>/memory/` and are committed through
 * the atomic-write service so readers never see partial writes.
 *
 * Concurrency: mutations hold BOTH an in-process promise lock (serializes
 * this host) AND a cross-process `withFileLock` (serializes other harness
 * instances sharing the same home, e.g. headless + web), and re-read the
 * file fresh from disk inside the critical section so a sibling process's
 * last write is never clobbered. Reads go through a cache validated by
 * mtime+size, so external changes are picked up too.
 */
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
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
    pinned: item.pinned === true,
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
 */
export class MemoryStore {
  /** Cache of parsed store files keyed by store key: `{data, mtimeMs, size}`. */
  #cache = new Map()
  /** Per-store-key in-process locks (serialized read-modify-write). */
  #locks = new Map()
  /** id -> owning store key, filled lazily by scans. Ids never migrate stores. */
  #idIndex = new Map()

  /** File path of one store key (`global` or `p:<hash>`). */
  fileFor(storeKey) {
    return storeKey === 'global'
      ? path.join(dshHomePath('memory'), 'global.json')
      : path.join(dshHomePath('memory'), 'projects', `${storeKey.slice(2)}.json`)
  }

  /**
   * Run one mutation under the store key's in-process lock.
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
   * Read one store file straight from disk (no cache).
   * @param storeKey - the scope to load.
   * @returns the parsed file shell (always has `items`).
   */
  async readFresh(storeKey) {
    const data = this.#emptyStore(storeKey)
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(storeKey), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
        data.cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined
        data.items = parsed.items
      }
    } catch {}
    return data
  }

  /**
   * Read one store through the mtime+size-validated cache.
   * @param storeKey - the scope to load.
   * @returns the parsed file shell.
   */
  async loadStore(storeKey) {
    const file = this.fileFor(storeKey)
    let mtimeMs = 0
    let size = 0
    try {
      const info = await stat(file)
      mtimeMs = info.mtimeMs
      size = info.size
    } catch {}
    const cached = this.#cache.get(storeKey)
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) return cached.data
    const data = await this.readFresh(storeKey)
    this.#cache.set(storeKey, { data, mtimeMs, size })
    return data
  }

  /**
   * Persist one store file atomically; refreshes the cache with real stat
   * values. Must be called while holding the store's locks.
   * @param storeKey - the scope being written.
   * @param data - the complete next file content.
   */
  async saveStore(storeKey, data) {
    const file = this.fileFor(storeKey)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, JSON.stringify(data, null, 2), { mode: 0o600, dirMode: 0o700 })
    let mtimeMs = 0
    let size = 0
    try {
      const info = await stat(file)
      mtimeMs = info.mtimeMs
      size = info.size
    } catch {}
    this.#cache.set(storeKey, { data, mtimeMs, size })
  }

  /**
   * Cross-process-safe mutation: in-process lock + file lock + fresh read,
   * mutate, atomic save. Ensures the parent directory exists first because
   * withFileLock requires it.
   * @param storeKey - target scope.
   * @param mutator - receives the fresh data shell (mutate `data.items`).
   * @returns the mutator's result.
   */
  mutateTx(storeKey, mutator) {
    return this.locked(storeKey, () => this.#withFileLockPrepared(storeKey, () => withFileLock(this.fileFor(storeKey), async () => {
      const data = await this.readFresh(storeKey)
      const result = await mutator(data)
      await this.saveStore(storeKey, data)
      return result
    })))
  }

  /** mkdir the store's parent directory, then run the file-locked operation. */
  async #withFileLockPrepared(storeKey, operation) {
    await mkdir(path.dirname(this.fileFor(storeKey)), { recursive: true })
    return operation()
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
   * Insert one item, or apply the candidate's action against an explicit
   * target. Literal near-duplicates (Jaccard >= threshold) always reinforce
   * in place regardless of the requested action, so model mistakes cannot
   * spam duplicates.
   * @param storeKey - target scope.
   * @param draft - `{content,type,tags,origin,cwd?,sourceSessionId?,pinned?}`.
   * @param action - `add` | `update` | `supersede` | `contradict`.
   * @param targetId - existing id required by non-add actions.
   * @returns `{item, created, relation}`; relation: created|reinforced|updated|superseded|contradicted.
   */
  applyCandidate(storeKey, draft, action = 'add', targetId = null) {
    return this.locked(storeKey, () => this.#withFileLockPrepared(storeKey, () => withFileLock(this.fileFor(storeKey), async () => {
      const data = await this.readFresh(storeKey)
      const items = data.items ?? []
      const now = Date.now()
      const kind = action === 'supersede' ? 'supersedes' : action === 'contradict' ? 'contradicts' : 'related'

      if (action !== 'add' && typeof targetId === 'string') {
        const target = items.find((entry) => entry.id === targetId && entry.status === 'active')
        if (target !== undefined) {
          if (action === 'update') {
            target.content = draft.content
            target.updatedAt = now
            if (draft.sourceSessionId !== undefined) target.sourceSessionId = draft.sourceSessionId
            await this.saveStore(storeKey, data)
            return { item: target, created: false, relation: 'updated' }
          }
          const item = {
            id: newId(),
            scope: storeKey === 'global' ? 'global' : 'project',
            content: draft.content,
            type: draft.type,
            tags: draft.tags,
            links: [{ id: target.id, kind }],
            origin: draft.origin ?? 'auto',
            status: 'active',
            ...(draft.sourceSessionId === undefined ? {} : { sourceSessionId: draft.sourceSessionId }),
            ...(storeKey === 'global' ? {} : { cwd: draft.cwd }),
            createdAt: now,
            updatedAt: now,
            useCount: 0,
          }
          this.#idIndex.set(item.id, storeKey)
          target.links.push({ id: item.id, kind })
          target.updatedAt = now
          if (action === 'supersede') {
            // The new item's initial edge already carries kind 'supersedes',
            // so archiving the target needs no second (duplicate) link.
            target.status = 'archived'
          }
          items.push(item)
          await this.saveStore(storeKey, data)
          return { item, created: true, relation: action === 'supersede' ? 'superseded' : 'contradicted' }
        }
        // Target missing/archived: fall through to dedupe/add handling.
      }

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
        return { item: match, created: false, relation: 'reinforced' }
      }
      const item = {
        id: newId(),
        scope: storeKey === 'global' ? 'global' : 'project',
        content: draft.content,
        type: draft.type,
        tags: draft.tags,
        links: [],
        origin: draft.origin ?? 'auto',
        status: 'active',
        ...(draft.pinned === true ? { pinned: true } : {}),
        ...(draft.sourceSessionId === undefined ? {} : { sourceSessionId: draft.sourceSessionId }),
        ...(storeKey === 'global' ? {} : { cwd: draft.cwd }),
        createdAt: now,
        updatedAt: now,
        useCount: 0,
      }
      this.#idIndex.set(item.id, storeKey)
      items.push(item)
      await this.saveStore(storeKey, data)
      return { item, created: true, relation: 'created' }
    })))
  }

  /**
   * Locate the store key holding one id (index fast path, scan fallback).
   * @param id - memory id.
   * @returns the owning store key, or undefined.
   */
  async findStoreOf(id) {
    if (typeof id !== 'string' || id === '') return undefined
    const known = this.#idIndex.get(id)
    if (known !== undefined) {
      // Re-validate: the index may predate a manual file edit.
      const data = await this.loadStore(known)
      if ((data.items ?? []).some((item) => item.id === id)) return known
      this.#idIndex.delete(id)
    }
    const globalData = await this.loadStore('global')
    if ((globalData.items ?? []).some((item) => item.id === id)) {
      this.#idIndex.set(id, 'global')
      return 'global'
    }
    let files = []
    try { files = await readdir(path.join(dshHomePath('memory'), 'projects')).catch(() => []) } catch {}
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const storeKey = `p:${file.slice(0, -5)}`
      const data = await this.loadStore(storeKey)
      if ((data.items ?? []).some((item) => item.id === id)) {
        this.#idIndex.set(id, storeKey)
        return storeKey
      }
    }
    return undefined
  }

  /**
   * Add symmetric link edges between two items in the same store.
   * @param a - one endpoint id.
   * @param b - the other endpoint id.
   * @param kind - edge kind.
   */
  link(a, b, kind = 'related') {
    return this.#edge(a, b, (item, to) => {
      if (!item.links.some((edge) => edge.id === to)) item.links.push({ id: to, kind })
    })
  }

  /**
   * Remove one link edge (either direction spelling).
   * @param a - one endpoint id.
   * @param b - the other endpoint id.
   */
  unlink(a, b) {
    return this.#edge(a, b, (item, to) => {
      item.links = item.links.filter((edge) => edge.id !== to)
    })
  }

  /**
   * Shared two-endpoint mutation: validates same-store + existence, then
   * applies `apply` to both directions under one transaction.
   */
  #edge(a, b, apply) {
    if (a === b) return Promise.reject(coded('self-link', 'cannot link a memory to itself'))
    return (async () => {
      const storeKeyA = await this.findStoreOf(a)
      const storeKeyB = await this.findStoreOf(b)
      if (storeKeyA === undefined || storeKeyB === undefined) throw coded('not-found', 'memory not found')
      if (storeKeyA !== storeKeyB) throw coded('cross-scope', 'both memories must live in the same scope')
      await this.mutateTx(storeKeyA, (data) => {
        for (const [from, to] of [[a, b], [b, a]]) {
          const item = (data.items ?? []).find((entry) => entry.id === from)
          if (item === undefined) throw coded('not-found', 'memory not found')
          apply(item, to)
          item.updatedAt = Date.now()
        }
      })
    })()
  }

  /**
   * Update one item by id within whatever store holds it.
   * @param id - memory id.
   * @param patch - `{content?,type?,tags?,status?,pinned?}`.
   * @returns the updated item.
   */
  async update(id, patch) {
    const storeKey = await this.findStoreOf(id)
    if (storeKey === undefined) throw coded('not-found', 'memory not found')
    return this.mutateTx(storeKey, (data) => {
      const item = (data.items ?? []).find((entry) => entry.id === id)
      if (item === undefined) throw coded('not-found', 'memory not found')
      if (typeof patch.content === 'string' && patch.content.trim() !== '') item.content = patch.content.trim()
      if (typeof patch.type === 'string' && patch.type !== '') item.type = patch.type
      if (Array.isArray(patch.tags)) item.tags = patch.tags.filter((tag) => typeof tag === 'string').slice(0, 5)
      if (patch.status === 'active' || patch.status === 'archived') item.status = patch.status
      if (patch.pinned === true || patch.pinned === false) item.pinned = patch.pinned
      item.updatedAt = Date.now()
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
    this.#idIndex.delete(id)
    await this.mutateTx(storeKey, (data) => {
      data.items = (data.items ?? []).filter((entry) => entry.id !== id)
    })
  }

  /**
   * Snapshot the current versions of the given ids (deep copies), for undo.
   * @param storeKey - target scope.
   * @param ids - ids to capture.
   * @returns array of deep-copied items that exist (possibly empty).
   */
  async snapshotItems(storeKey, ids) {
    const wanted = new Set(ids)
    const items = await this.list(storeKey)
    return items.filter((item) => wanted.has(item.id)).map((item) => JSON.parse(JSON.stringify(item)))
  }

  /**
   * Restore previously snapshotted item versions wholesale (undo).
   * @param storeKey - target scope.
   * @param snapshots - deep-copied items as captured by snapshotItems.
   * @returns how many items were restored.
   */
  restoreItems(storeKey, snapshots) {
    return this.mutateTx(storeKey, (data) => {
      const items = data.items ?? []
      let restored = 0
      for (const snapshot of snapshots) {
        const index = items.findIndex((entry) => entry.id === snapshot.id)
        if (index >= 0) {
          items[index] = snapshot
          restored += 1
        } else {
          items.push(snapshot)
          restored += 1
        }
        this.#idIndex.set(snapshot.id, storeKey)
      }
      return restored
    })
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
      pinned: item.pinned === true,
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
 * extracted-turn counters and last-consolidation records per scope.
 *
 * Flushes are debounced; each flush takes the cross-process file lock and
 * merges only the PENDING DELTAS into the on-disk copy, so two harness
 * processes sharing one home never clobber each other's cursors/counters.
 */
export class PluginState {
  #data = { version: 1, cursors: {}, turnCounts: {}, lastConsolidation: {} }
  /** Uncommitted deltas: cursors {id:seq}, turnIncr {key:n}, consolidated {key:record}. */
  #pending = { cursors: new Map(), turnIncr: new Map(), consolidated: new Map() }
  #timer
  #flushing = false

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
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush()
    }, 800)
  }

  /**
   * Commit pending deltas into state.json under the file lock (merge-safe
   * across processes). The batch is snapshotted synchronously before any
   * await, so deltas arriving DURING the disk write are neither lost nor
   * double-cleared. Failures put the batch back and retry on next schedule.
   */
  async flush() {
    if (this.#flushing) return
    if (this.#pending.cursors.size === 0 && this.#pending.turnIncr.size === 0 && this.#pending.consolidated.size === 0) return
    // Snapshot + clear synchronously: anything added after this point stays
    // pending for the next flush.
    const batch = {
      cursors: new Map(this.#pending.cursors),
      turnIncr: new Map(this.#pending.turnIncr),
      consolidated: new Map(this.#pending.consolidated),
    }
    this.#pending.cursors.clear()
    this.#pending.turnIncr.clear()
    this.#pending.consolidated.clear()
    this.#flushing = true
    const file = path.join(dshHomePath('memory'), 'state.json')
    try {
      await withFileLock(file, async () => {
        let disk = { version: 1, cursors: {}, turnCounts: {}, lastConsolidation: {} }
        try {
          const parsed = JSON.parse(await readFile(file, 'utf8'))
          if (parsed !== null && typeof parsed === 'object') {
            disk = {
              version: 1,
              cursors: parsed.cursors ?? {},
              turnCounts: parsed.turnCounts ?? {},
              lastConsolidation: parsed.lastConsolidation ?? {},
            }
          }
        } catch {}
        for (const [id, seq] of batch.cursors) disk.cursors[id] = Math.max(disk.cursors[id] ?? 0, seq)
        for (const [key, incr] of batch.turnIncr) disk.turnCounts[key] = (disk.turnCounts[key] ?? 0) + incr
        for (const [key, record] of batch.consolidated) disk.lastConsolidation[key] = record
        await mkdir(path.dirname(file), { recursive: true })
        await writeFileAtomic(file, JSON.stringify(disk, null, 2), { mode: 0o600, dirMode: 0o700 })
        // Local mirror follows the merged view so reads stay coherent.
        // turnCounts intentionally NOT mirrored here: the getter folds
        // pending increments, and mirroring could resurrect a counter that
        // markConsolidated zeroed while this flush was in flight.
        for (const [id, seq] of batch.cursors) this.#data.cursors[id] = Math.max(this.#data.cursors[id] ?? 0, seq)
        for (const [key, record] of batch.consolidated) {
          const current = this.#data.lastConsolidation[key]
          if (current === undefined || record.at >= current.at) this.#data.lastConsolidation[key] = record
        }
      })
    } catch {
      // Put the failed batch back (keeping whatever newer values arrived
      // meanwhile), then retry on the next debounce tick.
      for (const [id, seq] of batch.cursors) this.#pending.cursors.set(id, Math.max(seq, this.#pending.cursors.get(id) ?? 0))
      for (const [key, incr] of batch.turnIncr) this.#pending.turnIncr.set(key, incr + (this.#pending.turnIncr.get(key) ?? 0))
      for (const [key, record] of batch.consolidated) this.#pending.consolidated.set(key, record)
      this.#scheduleFlush()
    } finally {
      this.#flushing = false
    }
  }

  /** @returns the persisted extraction cursor map. */
  get cursors() { return this.#data.cursors }

  /** @returns the per-scope extracted-turn counter map (base + pending). */
  get turnCounts() {
    const out = { ...this.#data.turnCounts }
    for (const [key, incr] of this.#pending.turnIncr) out[key] = (out[key] ?? 0) + incr
    return out
  }

  /** @returns the per-scope last-consolidation record map. */
  get lastConsolidation() { return this.#data.lastConsolidation }

  /**
   * Advance one session's extraction cursor.
   * @param sessionId - the processed session.
   * @param seq - the highest processed event seq.
   */
  setCursor(sessionId, seq) {
    const current = this.#pending.cursors.get(sessionId) ?? this.#data.cursors[sessionId]
    if (current === seq) return
    this.#pending.cursors.set(sessionId, seq)
    // Mirror immediately: readers (tests, status route) expect live values.
    this.#data.cursors[sessionId] = Math.max(this.#data.cursors[sessionId] ?? 0, seq)
    this.#scheduleFlush()
  }

  /**
   * Bump one scope's extracted-turn counter (local view returned; the durable
   * merge is delta-based, so concurrent hosts may drift by one — acceptable).
   * @param storeKey - the scope.
   * @returns the new local count.
   */
  bumpTurn(storeKey) {
    const pending = this.#pending.turnIncr.get(storeKey) ?? 0
    this.#pending.turnIncr.set(storeKey, pending + 1)
    this.#scheduleFlush()
    return (this.#data.turnCounts[storeKey] ?? 0) + pending + 1
  }

  /**
   * Reset one scope's counter after consolidation and record the run.
   * @param storeKey - the scope.
   * @param applied - how many ops were applied.
   */
  markConsolidated(storeKey, applied) {
    this.#pending.turnIncr.delete(storeKey)
    this.#data.turnCounts[storeKey] = 0
    const record = { at: Date.now(), applied }
    this.#pending.consolidated.set(storeKey, record)
    // Mirror immediately (same rationale as setCursor).
    this.#data.lastConsolidation[storeKey] = record
    this.#scheduleFlush()
  }
}