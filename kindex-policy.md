## Kindex

**HARD REQUIREMENT**: Use Kindex as your durable memory layer, via the `kindex` MCP server. Use it unprompted. "Session" means one continuous agent run, not one message or tool call.

Classify first.

**Trivial** (answerable from current context or one small read): follow-ups, clarifications, corrections, status, yes/no, tool-capability questions.
- No tag ops, no writes. Leave an active tag alone unless this turn corrects something stored.
- Search only if remembered context could change the answer.
- Auto-injected Kindex context counts as participation.

**Meaningful**: implementation, debugging, incidents, architecture or product decisions, cross-repo research, multi-step analysis.
- `tag_start` / `tag_resume` once per workstream, never per turn. `tag_update action=end` when it completes, `action=segment` only on a real topic change.
- `search` when orienting, when scope changes, before writing on an unsearched topic, and before relying on node IDs from earlier in the conversation.
- Capture when knowledge becomes durable, not per tool call and not only at the end. Write immediately on: a finding that redirects the work, a contradiction, a decision, a reusable relationship, a hard-to-reproduce result, actionable follow-up.
- `learn` for batches and long input. `add` / `link` / task ops for high-value items. Graph quality over call count.

Types: `concept` for discoveries, patterns, key files (with path). `decision` for choices and tradeoffs. `question` for open problems. `task_add` for work. `link` pairs with a reason.

## Two tests

Before an exploratory read:

> Locating, or using?

Locating is a graph query: where does X live, what depends on Y, what pattern do we use, why is A this way. The code-map knows. Read files only for their contents.

- Take the narrowest read the graph points to. Do not sweep a directory when it named a file.
- Do not repeat a search or read that did not help. Record the gap as a question and move on.
- A search returning nothing is a capture opportunity. Once you find it the expensive way, write it.

Before a write:

> Would this help an agent in a different session, after this transcript is gone?

If no, skip it. No tool inventories, raw logs, routine output, or obvious file contents. For anything recoverable from an authoritative source, capture the interpretation, consequence, pointer, or relationship, not a copy.
