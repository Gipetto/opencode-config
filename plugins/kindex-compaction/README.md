# kindex-compaction

OpenCode v2 plugin that continuously captures session conversation into the
Kindex knowledge graph via the `kin` CLI, and injects Kindex context back
into sessions at prime and compaction time.

## Registration

Registered in opencode.json with options:

```json
["./plugins/kindex-compaction", {
  "configPath": "../kindex/opencode.yaml",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8000",
    "OMLX_KEY": "{file:secrets/omlx-key}"
  },
  "debug": true
}]
```

- `configPath` is appended as `--config` to every `kin` invocation. Relative
  paths resolve against the config directory (the parent of `plugins/`), so
  this entry points at `~/.config/kindex/opencode.yaml`.
- `env` is merged into every `kin` subprocess environment (on top of the
  parent environment).
- `debug: true` logs `[kindex]` lines to stderr.

## When it fires

| Trigger | Action |
| --- | --- |
| `context` hook (first time per session) | `kin prime --for hook --tokens 500` (5s timeout); stdout appended to the system prompt. Disable with `prime: false` |
| `compaction` hook | Full capture including recent turns (up to 3 chunks, 10s each), then `kin context --topic <first user message> --level summarized --tokens 800 --format raw` (8s timeout), pushed as a "Durable project memory from Kindex" block |
| `session.idle` event | Gated capture of older turns, excluding the last 2 user turns (up to 8 chunks, 120s each) — see the flush gate |
| `session.deleted` event | Drains the stored journal via `kin compact-hook`; the journal file is removed only if the drain succeeds |
| `session.compaction.ended` event | Logged in debug mode only |
| Plugin startup | Sweeps stale journals left by other processes: up to 50, oldest first; journals older than 12h also capture recent turns |

Events are processed only when their directory and workspace match the
configured location. Captures are serialized per session through an internal
queue.

Capture runs `kin compact-hook` with a stdin payload of
`<topic>\n\n<chunk text>`, cwd set to the project directory.

## Idle flush gate

Idle capture runs only when the journal holds a chunk in `pending` state, or
the not-yet-journaled serialized conversation has grown to at least
`minCaptureChars` (default 6000) characters. Otherwise the gate stays closed.

Serialization covers user text, assistant text, tool calls and results
(results truncated to 1500 chars), and completed compaction summaries.

## Journal layout

`<state root>/opencode/kindex-compaction/<sha256(project dir)>/<sha256(sessionID)>.json`

State root is `$XDG_STATE_HOME`, else `~/.local/state`. The directory is mode
0700 and journals are 0600. Content: `{ version: 1, session, messages:
[{ key, id, topic, source, chunks: [{ body, state, attempts, nextAttemptAt,
kinExit, kinDurationMs, kinStaged, lastAttemptAt, lastError, ... }] }] }`.

Per-chunk fields written after every `kin` attempt: `kinExit` (process exit
code, null if the process could not start), `kinDurationMs` (wall time of the
attempt), `kinStaged` (nodes reported by the `# Kindex: staged N` stdout line,
null when the line is absent). To count chunk states across all journals:

```sh
find "$XDG_STATE_HOME/opencode/kindex-compaction" -name '*.json' -exec jq -r '.messages[].chunks[].state' {} + | sort | uniq -c
```

## Durability (write-ahead)

Every state transition is written to disk before the corresponding `kin` call:
temp file, write, `sync()` (fsync), atomic rename, then fsync of the parent
directory. If the process dies mid-send, the on-disk journal shows exactly
which chunk was in flight.

## Chunk lifecycle

- `pending` -> `inflight` (journaled before the kin call).
- Success with a `# Kindex: staged N` line -> `unknown`. Never retried; treated
  as probably-applied. The message body is garbage-collected from the journal
  once all of the message's chunks are `unknown`.
- Success with no staged line -> `empty`. Never retried: a zero-staged result is
  deterministic, and retrying it burns 17-20 seconds of a single-resident model.
  The message body is retained rather than garbage-collected, so the payload can
  be inspected or replayed by hand. At most 200 message payloads holding `empty`
  chunks are kept per journal, oldest dropped first.
- Failure -> back to `pending` with `lastError` and exponential backoff
  (2^attempts seconds, capped at 1 hour); the flush pass stops at that chunk
  until `nextAttemptAt`.
- On any later load, leftover `inflight` chunks become `unknown`: ambiguous
  sends are never retried.

Only messages after the latest completed compaction boundary re-enter capture
consideration; older entries shrink to their dedup key. The file itself is
removed only on `session.deleted`, after a successful drain.

## Options (defaults)

`kinBin` "kin" · `configPath` null · `env` {} · `chunkChars` 3400 ·
`chunkTimeoutMs` 120000 · `compactChunkTimeoutMs` 90000 · `sweepStaleMs`
43200000 (12h) · `toolOutputChars` 1500 · `dropRecentTurns` 2 ·
`captureOnIdle` true · `minCaptureChars` 6000 · `maxChunks` 8 ·
`captureOnCompact` true · `maxFlushChunks` 3 · `contextLevel` "summarized" ·
`contextTokens` 800 · `contextTimeoutMs` 8000 · `trustedOnly` false ·
`prime` true · `primeTokens` 500 · `primeTimeoutMs` 5000 · `debug` false

## Prerequisites

- `kin` on PATH (or `kinBin` set). Subprocesses spawn via `Bun.spawn`, so the
  Bun plugin runtime is required.
- A kin config file where `configPath` points (here
  `~/.config/kindex/opencode.yaml`).
- Whatever environment kin's capture path needs. This config supplies
  `ANTHROPIC_BASE_URL` (local oMLX server) and `OMLX_KEY` (read from
  `secrets/omlx-key`) through the plugin `env` option.

## Known caveats

- **Capture is currently broken upstream.** `kin compact-hook` reports success
  while writing zero graph nodes
  ([opencode-config issue #3](https://github.com/Gipetto/opencode-config/issues/3)).
  Until fixed, this plugin's capture is an effective no-op.
- **Success is unverified.** A chunk "succeeds" on kin exit code 0 alone; the
  `unknown` state means applied-but-unconfirmed and is never retried. The
  caveat above makes this worse. A successful run that reports no staged count
  is now recorded as `empty` instead, so the two are distinguishable in the
  journal.
- **Final-two-turns loss.** `dropRecentTurns` (default 2) excludes the last
  two user turns from idle capture; they enter only on the compaction and
  stale-sweep paths. A session that ends without a later idle, compaction, or
  deleted event never captures its last two turns (the deleted-event drain
  only replays what was already journaled).
- **Startup sweep bound.** A process starting after crashes replays at most 50
  stale journals per start, oldest first.
