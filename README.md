# OpenCode setup

A local-first OpenCode configuration. All models run on omlx, a local MLX
inference server (`http://127.0.0.1:8000/v1`); no cloud model providers are
in active use. The setup drives a multi-agent workflow: an orchestrator
delegates to planning, test, implementation, verification, proportionality,
review, critic, and refute agents, and the user ratifies acceptance criteria
for critical work and approves anything destructive.

Every agent runs the same model, so agents share blind spots. Independence
comes only from what each agent may see: tests are written from the acceptance
criteria before the implementation exists, the implementer never sees the
tests, and reviewers get the artifact and contract but not the reasoning behind
it. Reports and PRs say so instead of claiming independent verification.

## Models

The `omlx` provider (OpenAI-compatible, local) defines Qwen 3.8 and Qwen 3.6
MLX variants at 4/6/8-bit quantizations, 32k–150k context. Every agent pins
the same model: `omlx/Qwen3.8-Flash-Next-oQ4e-mtp`. `default_agent` is
`orchestrator` and `subagent_depth` is 1, so subagents do not spawn further
subagents.

`profiles.yaml` maps agents to models per profile. `PROFILE=split make render`
writes the gitignored `opencode.profile.local.json` and reloads the server;
`bin/opencoded` points `OPENCODE_CONFIG` at that file. Its entries override
the `model:` line in each agent's frontmatter. Without the file, the
frontmatter models apply, which match the `single` profile.

## Agent roster

| Agent | Mode | Role | Steps | Permission posture |
| --- | --- | --- | --- | --- |
| orchestrator | primary | Plans, delegates, gathers context. Never edits files; dispatches one subagent at a time. | 500 | edit/write/patch deny; kindex and gitnexus allow |
| plan | primary | Analyzes the codebase and proposes a stepwise plan with draft acceptance criteria. | 20 | edit deny; bash deny-by-default with read-only allowlist (git log/diff/show/status, grep, rg, head, tail, wc) |
| test | subagent | Writes ACCEPTANCE.md and tests from the acceptance criteria before implementation; reports each test red for a named reason. | 30 | edit limited to ACCEPTANCE.md and test-file globs; bash test runners, read-only git, rg |
| implement | subagent | Applies a decided change to the exact files named in its brief. Never writes or opens tests. | 25 | edit allow except ACCEPTANCE.md and test-file globs; bash typecheck/lint/build and read-only git only; postgres and sentry deny |
| verify | subagent | Runs tests, builds, and linters named in the brief; reports which tests went red before, green now. Never fixes anything. | 20 | edit/write deny; bash allowlist (pytest, make test/check, tsc, mypy, ruff, eslint, prettier --check, read-only git) with `gh *` deny and everything else deny |
| explore | subagent | Read-only codebase search via kindex, gitnexus, then grep. Returns path:line findings. | 12 | edit/write/bash deny; kindex and gitnexus allow |
| proportionality | subagent | Proportionality gate: judges a verified diff against ticket/ACCEPTANCE.md for size, shape, and test quality; rules R1–R7; constant single-home (R7) with confidence routing (BLOCK=high only, CLARIFY halts to the human); never edits. | uncapped | edit/write deny; bash git diff/log/show allow with sha-verification rule; everything else deny; temperature 0.2 for judgment consistency |
| review | subagent | Final gate: traces the committed SHA against ACCEPTANCE.md; PASS, FAIL, or HUMAN_REVIEW_REQUIRED for critical work. | 25 | edit/write deny; bash read-only allowlist (git diff/show/log/status, grep, rg, head, tail, wc, sort, uniq) |
| critic | subagent | Adversarial reviewer for plans and clean critical results; can apply a persona skill. Temperature from the server default for varied samples. | 20 | edit deny; bash `sim`, read-only git, rg |
| refute | subagent | Tries to disprove each review or critic finding in a fresh context; only survivors go back to implement. | 20 | edit deny; bash read-only git, rg |

## Workflow

1. A user request lands on the orchestrator, which orients via kindex and
   gitnexus (explore only when those come up empty).
2. plan produces a stepwise plan with draft acceptance criteria, the
   properties the change must keep, and a risk class (critical, standard,
   cosmetic; unclassified counts as critical).
3. For critical work or a real open question, the orchestrator presents the
   criteria verbatim via the question tool and waits for ratification. For
   standard and cosmetic work it records its interpretation and proceeds.
   Critical plans also get two critic runs, filtered through refute.
4. test writes ACCEPTANCE.md and the tests from the criteria, runs them, and
   reports each one red for its stated reason.
5. implement builds the behavior from the brief without seeing the tests.
6. verify runs the tests and repo checks: red before, green now is the
   evidence. FAIL goes back to implement as behavior and location.
7. The orchestrator commits the candidate so later gates judge a fixed SHA.
8. proportionality runs on diffs above ~150 lines or introducing new
   abstractions. BLOCK routes its items verbatim back to implement (max two
   cycles); CLARIFY surfaces its questions verbatim to the user.
9. review traces the committed SHA against ACCEPTANCE.md. FAIL findings pass
   through refute first; only survivors return to implement. Critical work
   ends in HUMAN_REVIEW_REQUIRED: the user sees the evidence and decides. A
   clean critical review also gets one critic run.
10. After three correction rounds on one issue the orchestrator reassesses,
    and escalates to the user by the fourth.
11. Pushes go through `git pbs`; gh mutations prompt.

## MCP servers

- **gitnexus** — code knowledge graph: impact analysis, execution-flow
  queries, change detection.
- **kindex** — persistent knowledge graph for durable memory across sessions.
- **sentry** — remote server (OAuth) for error and issue triage.
- **svelte** — official Svelte 5 / SvelteKit documentation and autofixer.

## Plugins

`plugins/kindex-compaction/` journals complete serialized session messages
before compaction under `${XDG_STATE_HOME:-~/.local/state}/opencode/kindex-compaction/`.
The journal is private to the user (0700 directory, 0600 files) and retains
source text across restarts and compactions. It has no automatic expiry because
`kin compact-hook` does not confirm that every extracted candidate was saved.
The plugin marks successful process exits as unconfirmed, keeps that source,
and does not retry it automatically. Explicit process failures remain pending
for a later attempt; partial writes can create duplicate candidates on retry.
This protects the source text, but it cannot guarantee Kindex extraction or
exactly-once delivery. Review journal size and remove files only when their
source is no longer needed.

## Permissions

Top-level `gh` reads (view, list, diff, checks, runs, searches) are allowed;
gh mutations (`gh pr create/edit/close`) and everything else matching `gh*`
require approval. `git push` and its aliases are denied globally; only the
orchestrator may push, through `git pbs`, and never to main. Secrets live in `secrets/` and are
referenced with `{file:}` interpolation; the directory is gitignored and its
contents are never printed. Repetition protection is native and strict:
doom_loop (same tool call 3x with identical input) is denied, not prompted, so
unattended runs block spinners instead of stalling on approvals—while
paraphrase-level thrashing remains guarded only by worker step budgets and the
kindex checkpoint discipline.

Repo-specific verification commands belong in `<repo>/.opencode/opencode.json`
under `agents.verify.permissions`, which merges with the global rules in
`agents/verify.md` (measured v2.2.5). Repos with non-standard script names
(e.g. quizstreak's `sync`) must declare them there.

## Skills

Available skills: gitnexus-exploring, gitnexus-impact-analysis,
gitnexus-debugging, gitnexus-refactoring, gitnexus-pr-review, gitnexus-cli,
gitnexus-guide, rebase, merge, worktree, and open-pr.

Persona review skills (ask-jeremy, ask-devon, ask-shawn) are personal and live
in private repositories, so this public repo never tracks them. List their
absolute directories, one per line, in the gitignored `personal-skills.local`
and run `make personal-skills` to symlink them into `skills/`. The critic agent
applies them when a brief names one. ask-jeremy runs the vendored `sim` CLI,
which talks to the same resident model; `bin/sim` leaves `GENERALIST_MODEL`
unset to skip a routing call that critique never needs.

Portable
`SKILL.md` skills shared across tools live in `~/.agents/skills`;
tool-specific ones live in `~/.config/opencode/skills`.

## AGENTS.md

`AGENTS.md` carries the standing agreement every agent reads: communication
style, advisory-vs-implementation behavior, the acceptance contract, testing and
PR rules, shell conventions, how agents use kindex and GitNexus, and worker
limits. Orchestrator-only rules (delegation sizing, the workflow, risk classes,
the proportionality gate, correction rounds, long-running checkpoints) live in
`agents/orchestrator.md`, so workers on the local model do not carry them.

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
