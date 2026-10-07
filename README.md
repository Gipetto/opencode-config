# OpenCode setup

A local-first OpenCode configuration. All models run on omlx, a local MLX
inference server (`http://127.0.0.1:8000/v1`); no cloud model providers are
in active use. The setup drives a multi-agent workflow: an orchestrator
delegates to planning, implementation, verification, proportionality, and
review agents, and the user ratifies acceptance criteria and approves anything
destructive.

## Models

The `omlx` provider (OpenAI-compatible, local) defines Qwen 3.8 and Qwen 3.6
MLX variants at 4/6/8-bit quantizations, 32k–150k context. Every agent pins
the same model: `omlx/Qwen3.8-Flash-Next-oQ4e-mtp`. `default_agent` is
`orchestrator` and `subagent_depth` is 1, so subagents do not spawn further
subagents.

## Agent roster

| Agent | Mode | Role | Steps | Permission posture |
| --- | --- | --- | --- | --- |
| orchestrator | primary | Plans, delegates, gathers context. Never edits files; dispatches one subagent at a time. | 500 | edit/write/patch deny; kindex and gitnexus allow |
| plan | primary | Analyzes the codebase and proposes a stepwise plan with draft acceptance criteria. | 20 | edit deny; bash deny-by-default with read-only allowlist (git log/diff/show/status, grep, rg, head, tail, wc) |
| implement | subagent | Applies a decided change to the exact files named in its brief. | 25 | edit/write allow, patch deny; bash deny; postgres and sentry deny |
| verify | subagent | Runs tests, builds, and linters named in the brief; reports PASS/FAIL. Never fixes anything. | 20 | edit/write deny; bash allowlist (pytest, make test/ship/check, tsc, mypy, ruff, eslint, prettier --check, read-only git) with `gh *` deny and everything else deny |
| explore | subagent | Read-only codebase search via kindex, gitnexus, then grep. Returns path:line findings. | 12 | edit/write/bash deny; kindex and gitnexus allow |
| proportionality | subagent | Proportionality gate: judges a verified diff against ticket/ACCEPTANCE.md for size, shape, and test quality; rules R1–R7; constant single-home (R7) with confidence routing (BLOCK=high only, CLARIFY halts to the human); never edits. | uncapped | edit/write deny; bash git diff/log/show allow with sha-verification rule; everything else deny; temperature 0.2 for judgment consistency |
| review | subagent | Final gate: judges the diff against the brief and ACCEPTANCE.md, spot-checks claims. | 12 | edit/write deny; bash read-only allowlist (git diff/show/log/status, grep, rg, head, tail, wc, sort, uniq) |

## Workflow

1. A user request lands on the orchestrator, which orients via kindex and
   gitnexus (explore only when those come up empty).
2. plan produces a stepwise plan with a draft "Acceptance criteria" list.
3. The orchestrator presents the criteria verbatim via the question tool and
   waits for the user's explicit ratification.
4. implement receives the brief with the confirmed criteria and writes
   ACCEPTANCE.md first, verbatim, before any other edit.
5. verify runs the acceptance commands within its allowlist and ends with
   PASS or FAIL. FAIL sends the work back to implement.
6. proportionality runs after verify PASS on diffs above ~150 lines or
   introducing new abstractions. BLOCK routes its items verbatim back to
   implement (max two cycles); CLARIFY surfaces its questions verbatim to
   the user and re-dispatches with the answers. The report goes to review.
7. review judges the diff against ACCEPTANCE.md — never the implementer's
   summary — and its verdict is final.
8. Commit and push are gated by user approval: `git push` and gh mutations
   prompt.

## MCP servers

- **gitnexus** — code knowledge graph: impact analysis, execution-flow
  queries, change detection.
- **kindex** — persistent knowledge graph for durable memory across sessions.
- **postgres** — schema and data queries; connects with the URL in
  `secrets/postgres-url`.
- **sentry** — remote server (OAuth) for error and issue triage.
- **svelte** — official Svelte 5 / SvelteKit documentation and autofixer.

## Plugins

`plugins/kindex-compaction.js` is active: it integrates kindex with context
compaction, reading `../kindex/opencode.yaml` and talking to the local omlx
server. Auto-compaction is on, preserving the last 6 turns (compaction.tail_turns).

## Permissions

Top-level `gh` reads (view, list, diff, checks, runs, searches) are allowed;
gh mutations (`gh pr create/edit/close`) and everything else matching `gh*`
require approval, as does `git push`. Secrets live in `secrets/` and are
referenced with `{file:}` interpolation; the directory is gitignored and its
contents are never printed. Repetition protection is native and strict:
doom_loop (same tool call 3x with identical input) is denied, not prompted, so
unattended runs block spinners instead of stalling on approvals—while
paraphrase-level thrashing remains guarded only by worker step budgets and the
kindex checkpoint discipline.

## Skills

Available skills: gitnexus-exploring, gitnexus-impact-analysis,
gitnexus-debugging, gitnexus-refactoring, gitnexus-pr-review, gitnexus-cli,
gitnexus-guide, rebase, merge, worktree, and open-pr. Portable
`SKILL.md` skills shared across tools live in `~/.agents/skills`;
tool-specific ones live in `~/.config/opencode/skills`.

## AGENTS.md

`AGENTS.md` carries the standing collaboration agreement: communication style,
advisory-vs-implementation behavior, the acceptance contract, testing and PR
rules, shell conventions, and how agents use kindex and GitNexus.

## Repo

This directory is a git repository (Gipetto/opencode-config). Changes are
committed deliberately, not automatically.

## Vendored tooling

This repo is a Nix flake that vendors the agent tooling. Layout:

- `flake.nix` — pins and builds all eight packages: `kindex` (bin `kin`),
  `kindex-mcp` (same derivation, bin `kin-mcp`), `gitnexus`, `sim`,
  `advocate`, `meditate`, `pact`, `signet-eval`.
- `patches/` — patches applied to vendored builds (e.g. the kindex
  provider-default wrapper patch).
- `bin/` — one launcher script per command. Each launcher resolves its own
  real path (so it works via a `~/.local/bin` symlink), builds from this
  repo's flake (`nix build --no-link --print-out-paths "$REPO#<pkg>"`), and
  execs the binary.
- `install.sh` — symlinks the eight launchers into `~/.local/bin`.
  Idempotent; safe to re-run.

`patches/kindex-wrapper-provider-default.patch` repoints kindex's config
defaults at a local endpoint: in `src/kindex/config.py` it adds
`_DEFAULT_LLM_PROVIDER = os.environ.get("LOCAL_LLM_PROVIDER", "anthropic")`
just above the config classes and makes `LLMConfig`'s `provider`, `model`,
and `api_key_env` defaults (plus `EmbeddingConfig`'s `provider`) derive from
it, so `LOCAL_LLM_PROVIDER=openai` switches kindex's defaults to
OpenAI-compatible routing. If the patch fails to apply after a kindex bump,
re-derive it: unpack the kindex source at the new rev (e.g. clone
`github.com/wandercom/kindex` at the pinned `rev`), re-apply those same
edits in the `LLMConfig`/`EmbeddingConfig` defaults region of
`src/kindex/config.py`, then regenerate with
`git diff > patches/kindex-wrapper-provider-default.patch`.

`sim` and `advocate` route through the local oMLX server at
`http://127.0.0.1:8000/v1`, authenticating with `secrets/omlx-api-key`
(git-ignored). kindex deliberately stays unpatched for local routing: kindex
0.46.0 hardcodes `api.openai.com` in `llm.py`, so an env-var base URL has no
effect there — a `LOCAL_LLM_BASE_URL` patch is tracked as deferred.

`~/.local/bin` must be on `PATH`: `opencode.json` launches `kin-mcp` and
`gitnexus` as bare commands, so they must resolve through those symlinks.
`nix` must also be on `PATH` (every launcher calls `nix build`); on this
machine it lives at `/nix/var/nix/profiles/default/bin`, not
`~/.nix-profile/bin`.

On a fresh machine:

```sh
git clone <this repo> ~/.config/opencode
~/.config/opencode/install.sh
```

Make sure `~/.local/bin` is on `PATH` in your shell profile, then verify
with `kin --version` and `gitnexus --version` outside any devshell.

To uninstall, remove the eight symlinks:
`rm ~/.local/bin/{kin,kin-mcp,gitnexus,sim,advocate,meditate,pact,signet-eval}`.

To refresh a pin:

- Real flake inputs (`kindex`, `nixpkgs`, `flake-utils`): run
  `nix flake update <input>` (or bare `nix flake update` for all), which
  rewrites `flake.lock` itself.
- GitNexus is not a flake input: it is fetched via `fetchgit` inside its
  derivation in `flake.nix:23-27`. Resolve the commit SHA for the desired
  upstream tag at `https://github.com/abhigyanpatwari/GitNexus` with
  `git ls-remote https://github.com/abhigyanpatwari/GitNexus refs/tags/<tag>`
  (for annotated tags, use the `refs/tags/<tag>^{}` line), update the
  `rev` (`flake.nix:25`), then rebuild with `nix build '.#gitnexus'`: the
  build reports the new source hash to paste into `hash` (`flake.nix:26`),
  or compute it up front with `nix-prefetch-git`. If upstream's dependency
  lockfile changed, refresh `npmDepsHash` (`flake.nix:31`) the same way —
  the `buildNpmPackage` error names the exact command to run
  (`prefetch-npm-deps <unpacked-source>`).

Then rebuild (`nix build '.#<pkg>'`) and re-run `./install.sh`. All fetches
— flake inputs and the in-derivation GitNexus recipe alike — go over public
HTTPS; none requires SSH access.

## Makefile

`Makefile` is a thin convenience layer over the flake with no package list of
its own — it derives the package names from the flake at parse time. On a
fresh machine, `make init` checks, pre-warms, and links (`install.sh`). After
any flake or pin change, `make update` bumps inputs and pre-warms builds.
