# kindex-memory

Lightweight companion to kindex-compaction. Injects a static Kindex usage
policy into every system-prompt build, and appends a regenerated Kindex
orientation block at compaction. It is read-only: nothing is written to disk
or to the graph, and nothing is captured.

## Registration

Registered in opencode.json as a plain string:

```json
"./plugins/kindex-memory"
```

No options object and no `configPath`. Consequence: every `kin` call here runs
without `--config` and uses kin's own default config discovery, while
kindex-compaction pins `~/.config/kindex/opencode.yaml`. If kin's default
config differs, this plugin's orientation can read a different graph than the
compaction plugin writes (see caveats). Subprocesses also inherit only the
parent environment; there is no `env` option.

## Behavior

1. **kin probe at startup.** Runs `kin --version` once (5s timeout). Failure
   is not fatal: the probe is retried at every later compaction until it
   succeeds. Orientation stays skipped until kin is confirmed available.
2. **`context` hook (every context build).** Reads the policy file and pushes
   it verbatim into the system prompt. The file is cached by mtime and re-read
   on change; if it is missing or empty, nothing is injected.
3. **`compaction` hook.** Injects the policy again, then runs `kin context`
   (subcommand only, no flags; 5s timeout, project directory as cwd),
   truncates the output to 4000 characters, and pushes it under the heading
   "## Kindex orientation (regenerated at compaction)".
4. **Failures are silent.** Non-zero exits, timeouts and spawn errors all
   collapse to empty output; on timeout the child is killed, then SIGKILL'd
   after 1 second. Nothing this plugin does can break a session — or report a
   problem.

Orientation is regenerated only at compaction; between compactions the only
Kindex content in the prompt is the (static) policy text.

## Prerequisites

- `kin` on PATH.
- Policy file: `KINDEX_POLICY_PATH` env override, default
  `~/.config/opencode/kindex-policy.md`. Optional — without it, policy
  injection is silently disabled.
- No env wiring of its own: `ANTHROPIC_BASE_URL` / `OMLX_KEY` are passed only
  to the kindex-compaction plugin's subprocesses. Anything this plugin's
  `kin context` call needs must already be in OpenCode's own environment.

## Known caveats

- **No configPath passthrough.** Asymmetric with kindex-compaction (see
  Registration). Fixing it requires extending the plugin to accept options
  and append `--config` to its `kin` invocations.
- **Upstream capture is broken.** `kin compact-hook` writes zero graph nodes
  while reporting success
  ([opencode-config issue #3](https://github.com/Gipetto/opencode-config/issues/3)),
  so the orientation block reflects only whatever is already in the graph.
- **Upstream final-two-turns loss.** kindex-compaction's `dropRecentTurns` (2)
  means a session ending without a later idle/compaction event never captures
  its last two turns; orientation can therefore lag the true end of a session
  even when capture works.
- **Silent failure by design.** If kin is slow, absent, or misconfigured, the
  only symptom is a missing prompt section.
