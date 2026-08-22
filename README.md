# dsh-memory

Long-term memory for the DeepSeek Harness Web GUI: project-scoped + global memory stores with automatic extraction, automatic briefing injection, small-model periodic consolidation, and an Obsidian-style memory graph.

See [README.zh.md](README.zh.md) for the full Chinese documentation.

## Highlights

- **Two scopes**: per-workspace project memories (keyed by a hash of the session cwd) plus one global store; plain JSON under `~/.dsh/memory/` (respects `$DSH_HOME`), atomic writes.
- **Memory view tab** beside Chat/Trajectory: one-card-per-row list (type dot, tags, origin, reinforcement count, links) with inline edit/archive/link/delete, search, and a canvas force-directed graph with zoom/pan/drag, neighbor highlighting and a detail card.
- **Auto injection**: a global `system-prompt/assemble` waterfall listener appends the top-K memories (freshness x reinforcement x degree, interleaved scopes, char-capped) as a dynamic context; agentless assemblies get globals only; failures never touch the assembly.
- **Auto extraction**: on `turn/end`, new events are replayed as a transcript and distilled by the model into JSON candidates; near-duplicates (bigram Jaccard >= 0.65) reinforce instead of duplicating; 3 consecutive failures pause auto-extraction until a manual run recovers.
- **Periodic consolidation**: every N extracted turns per scope (default 20) or on manual trigger, the model proposes merge/link/archive/retag ops that are id-validated and applied transactionally.

## Install

```
dsh plugin --profile web add <repo-or-local-path>
dsh web   # restart, then refresh the page
```

## Settings (`~/.dsh/settings.yaml`)

```yaml
dsh-memory:
  enabled: true
  injectEnabled: true
  autoExtract: true
  extractProvider: ''   # pair with extractModel to pin a small model
  extractModel: ''
  consolidateEveryTurns: 20
  topK: 8
  maxInjectChars: 1500
  maxInputChars: 12000
  maxTokens: 1024
```

## Layout

- `lib/index.js` — host half: settings, injection/extraction listeners, consolidation pipeline, routes.
- `lib/store.js` — two-scope JSON store + durable cursors/counters.
- `lib/util.js` — pure helpers (scope keys, similarity, parsers, transcript builder).
- `lib/client.js` — browser half (hand-written bundle): additive `conversation.view` entry.
- `test/smoke.cjs` — `node test/smoke.cjs`.

MIT
