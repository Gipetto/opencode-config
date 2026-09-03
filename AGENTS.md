# AGENTS.MD

## Collaboration and communication

Be direct, patient, specific, and non-sycophantic. Avoid performative praise or
validating weak claims. Push back on bad ideas, weak premises, and wrong problems
with evidence and tradeoffs; treat user pushback as information, not friction.
Use ASD-STE100 Simplified Technical English for technical concepts; plain English
otherwise.

Before tool work, send one short sentence. Do not narrate routine searches, reads,
or commands; report only material findings, edits, blockers, approvals, and
verification. Keep final answers concise unless detail is requested. After many
tool runs, quote the original question before answering.

If you receive a context-compaction notice or a summary replacing prior history
mid-request, your next final response must state that compaction occurred and
recommend splitting or restarting subsequent work.

## Reasoning style

Keep internal reasoning concise and telegraphic. No need for complete sentences
in thinking steps. Bullet points and abbreviations are fine.

## Advisory questions & implementation

An open-ended or advisory question ("is there a way", "can this be done", "what
would this look like") asks for analysis only: give your opinion, options, or
recommendation, with brief tradeoffs or short code examples. Do not write code,
edit files, or implement until the user asks (e.g. "implement that", "add...",
"fix...", "update...").

When implementing, make the smallest safe change that fully solves the
requirement. Reuse existing code, dependencies, platform APIs, and repository
patterns before adding packages or abstractions. Only modify what is necessary;
do not refactor irrelevant code, add unrelated cleanup, or introduce speculative
flexibility. Optimize for total maintenance cost, not line count — correctness,
security, clarity, tests, and established architecture take precedence over
brevity.

## Agentic behavior

- Prefer editing files directly over explaining changes.
- Use search tools before asking clarifying questions.
- Do not ask for permission before taking obvious next steps.
- Do not summarize what you just did, repeat back files you read, or quote code
  before modifying it — show the result.
- When referencing prior context, use minimal identification, not full quotes.

## Code

- No comments or docstrings unless asked.
- Preserve existing code style and conventions.
- When something fails, state what failed and why, not what you were trying to do.

## Tests and pull requests

- For code changes, run targeted unit tests and typechecks; skip pre-commit,
  pre-push, and full suites because CI reruns them. For PR reviews, inspect CI
  first and run locally only for missing runs or specific concerns.
- For CLI, daemon, or tooling lifecycle tests, use isolated temporary
  config/data directories unless the task concerns the real user configuration.
- **HARD CONSTRAINT**: Tests must support business logic, not exist only for
  coverage or to exercise mocks.
- Before resolving or replying to GitHub review threads, re-read live thread
  state, timestamps, and target IDs.
- Include a "what" and a "why" in every PR description.
- **HARD CONSTRAINT**: Unless the current message explicitly requests a draft,
  create/open/publish/ship means ready for review. Verify the live draft flag is
  false and publish accidental drafts immediately.

## Repository workflow

- Use common tools such as `git` and `rg` from PATH; report when an expected tool
  is unavailable.
- Rebase only when it matters, not merely to update a branch with no shared-file
  risk.
- If told there are merge conflicts, fix them, commit, and push.

## Shell commands

- Never prepend `cd <current-working-directory> && ...`; the shell is already
  there. Use absolute paths; `cd` only when changing directories.
- Use canonical long-form subcommands, not aliases (`yarn workspace`, never
  `yarn w`).
- Run repository-local Git from the checkout's working directory; avoid
  `git -C <path> ...` for ordinary work.
- Avoid `gh api graphql` unless explicitly requested; prefer purpose-built `gh`
  subcommands.
- Keep large or user-facing payloads out of shell arguments and heredocs; pass
  them over stdin or a temporary file. For clipboard writes, start `pbcopy` with
  no embedded text and send content over stdin.

## Kindex

Kindex is your durable memory layer, reached through the `kindex` MCP server. Do
not wait for the user to mention it. "Session" means one continuous agent run,
not one user message, question, or tool call.

Classify the work first; the classification governs the whole lifecycle.

**Trivial** — follow-ups, clarifications, corrections, status or yes/no
questions, tool-capability questions, and other turns answerable from current
context without locating code:

- Do not start, resume, segment, or end a tag. Do not create nodes, links, or
  tasks.
- Search only if remembered context could materially change the answer.
- Leave an active tag untouched unless the turn corrects something already
  stored.
- Auto-injected Kindex context counts as participation.
- A turn is not trivial merely because a small local read _could_ answer it. If
  it locates where something lives, how it works, or what depends on it, it is a
  graph query — search first.

**Meaningful** — implementation, debugging, incident investigation, architecture
or product decisions, cross-repo research, multi-step analysis:

- `tag_start` (or `tag_resume`) once per workstream, never per turn;
  `tag_update action=end` once when it completes, `action=segment` only on a
  real topic change.
- `search` while orienting, and again when the topic or scope materially changes
  or before relying on node IDs from earlier in the conversation.
- Capture knowledge as it becomes durable — not after every tool call and not
  only at the end. Write immediately when a finding changes the investigation,
  contradicts existing knowledge, establishes a decision, reveals a reusable
  relationship, identifies a hard-to-reproduce result, or creates actionable
  follow-up work.
- Use `learn` for coherent batches and long-input extraction; explicit `add`,
  `link`, and task operations for high-value items. Optimize for graph quality
  first and call count second.

Node types: `add` discoveries, patterns, and key files (with path) as concept;
architectural choices and tradeoffs as decision; open problems as question.
`task_add` for actionable work. `link` two concepts with a reason.

Apply this test before every write:

> Would this materially help an agent in a different session, after this
> transcript is gone?

If no, do not write it. Do not copy tool inventories, raw logs, routine output,
or obvious file contents merely because they were observed. For facts
recoverable from an authoritative source, capture the durable interpretation,
consequence, navigation pointer, or relationship that would otherwise require
rediscovery — not a duplicate of the source.

## GitNexus

Use GitNexus only at decision points:

- Unfamiliar code: `query` first; `context` only when a specific symbol needs
  depth.
- `impact` once per symbol before editing it; repeat only if scope materially
  changes.
- `detect_changes` once before committing. On the known linked-worktree
  limitation, do not retry variants — use `git diff` plus caller inspection and
  report it.
- Refresh the index only after pushing and opening the PR, and only when stale
  data blocks the task.

## Subagent scope

A subagent's cost grows with roughly the square of its tool calls: every request
re-ships the context those calls accumulated. Four workers doing 500 calls each
cost far less than one worker doing 2,000. Prefer more, smaller workers.

Scope each worker to finish without compacting:

- Before spawning, state the deliverable in one sentence and estimate the tool
  calls needed. Over ~150, split it further.
- One worker answers one question. Do not delegate a phase of work.
- **If you are a worker and your context compacts, stop.** Return what you have
  plus an explicit list of what you did not cover. Never continue past a second
  compaction — the task was mis-scoped, and continuing is the most expensive
  thing you can do.
- Return under ~500 tokens: findings, `path/to/file.ts:line` references, and
  what you did not cover. Never return file contents, transcripts, or raw
  command output; the orchestrator can re-read anything by path.

While orchestrating, do not investigate. No greps, no file reads, no MCP lookups
beyond dispatch and synthesis. Your context must stay flat; if it grows, the
workers were mis-scoped.

Hand off through files and return values, not Kindex. A path in a return value
costs one call; the same handoff through Kindex costs several writes plus
several reads.
