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
| orchestrator | primary | Plans, delegates, gathers context. Never edits files; dispatches one subagent at a time. | 40 | edit/write/patch deny; kindex and gitnexus allow |
| plan | primary | Analyzes the codebase and proposes a stepwise plan with draft acceptance criteria. | 20 | edit deny; bash deny-by-default with read-only allowlist (git log/diff/show/status, grep, rg, head, tail, wc) |
| implement | subagent | Applies a decided change to the exact files named in its brief. | 25 | edit/write allow, patch deny; bash deny; postgres and sentry deny |
| verify | subagent | Runs tests, builds, and linters named in the brief; reports PASS/FAIL. Never fixes anything. | 20 | edit/write deny; bash allowlist (pytest, make test/ship/check, tsc, mypy, ruff, eslint, prettier --check, read-only git) with `gh *` deny and everything else deny |
| explore | subagent | Read-only codebase search via kindex, gitnexus, then grep. Returns path:line findings. | 12 | edit/write/bash deny; kindex and gitnexus allow |
| proportionality | subagent | Proportionality gate: judges a verified diff against ticket/ACCEPTANCE.md for size, shape, and test quality; rules R1–R6 with confidence routing (BLOCK=high only, CLARIFY halts to the human); never edits. | 12 | edit/write deny; bash git diff/log/show allow with sha-verification rule; everything else deny |
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
server. Auto-compaction is on, preserving an 8k-token recent window.

## Permissions

Top-level `gh` reads (view, list, diff, checks, runs, searches) are allowed;
gh mutations (`gh pr create/edit/close`) and everything else matching `gh*`
require approval, as does `git push`. Secrets live in `secrets/` and are
referenced with `{file:}` interpolation; the directory is gitignored and its
contents are never printed.

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
