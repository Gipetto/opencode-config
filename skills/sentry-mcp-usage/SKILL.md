---
name: sentry-mcp-usage
description: How to call the Sentry MCP tools without argument, query-syntax or routing errors. Use this skill whenever you are about to query Sentry for issues, events, errors, traces or releases, look up a Sentry URL, or call search_events, search_sentry_tools or execute_sentry_tool, and whenever a Sentry call fails with an input validation error, a 400/403/404, "Unauthorized", or "tool is not available in this session".
---

# Sentry MCP: get the call right the first time

Sentry calls fail mostly on the call contract, not on Sentry itself: a required argument
is missing, a value is in the wrong format, or the search string uses syntax the API
rejects. Each failed call returns an error that names the problem, so read it and fix
that specific thing instead of varying the call at random.

> **Maintainer note:** the rules below are the ones proven by logged errors and the
> tool schemas. Where the logs only show `Invalid input` with no detail (the `fields`
> argument), this file says so rather than guessing. Fill that in from the tool schema
> (see "Open items" at the bottom).

## Always query live, never from memory

Issue state on Sentry changes constantly. Acting on a stale snapshot causes redundant
mutations and misattribution — a real incident came from working off a weeks-old triage
note instead of live state.

1. **Query live, in this session.** When asked to look at, triage, report on, or mutate
   Sentry issues, always run fresh queries now (`get_sentry_resource`, `search_issues`,
   `search_errors`, ...). Never answer from prior snapshots: earlier session transcripts,
   saved triage notes, knowledge-graph context, cached dashboards, or issue state recalled
   from previous conversations.
2. **Check live state before any mutation.** Before resolving, ignoring, or reassigning
   (via `update_issue`), fetch the issue's current status first. If the live state already
   matches the intended outcome, skip the mutation and say so.
3. **Verify after writing.** After any mutation, re-fetch the issue live and confirm the
   actual state before reporting completion. Never claim done from the mutation call alone.

## Before any call

1. **Know the organization.** Most tools need `organizationSlug` unless you pass a Sentry
   URL. If you do not have the slug, get it from the user, from a URL they pasted, or by
   listing organizations first. Do not guess it. A wrong slug produces a 404 that looks
   like a missing resource.
2. **Prefer a URL when the user gave one.** Pass the `url` and the org and IDs are parsed
   for you. For lookups of a single resource, you must supply either `url` or
   `resourceType` (with its identifier); a call with neither is rejected.
3. **Do not call tools by name from memory.** Tools in this server are discovered, not
   assumed. If you call a tool that is not exposed in the session you get
   `Tool "<name>" is not available in this session`. Instead:
   - call `search_sentry_tools` with a few keywords describing what you need
     (for example `event details`, `issues`),
   - take the exact tool name and argument schema it returns,
   - then call `execute_sentry_tool` with that exact name and arguments that match the
     returned schema.

   If `search_sentry_tools` rejects its arguments, note its `limit` is 1–20 (default
   8); drop the optional arguments and send just the query, then add them back
   one at a time.

## Arguments with known constraints

- **`period`** must be a relative window matching digits followed by `h`, `d`, or `w`
  (`^\d+[hdw]$`). The documented windows are `24h`, `7d`, `14d`, `30d` and `90d`;
  absolute dates and free text are rejected. For a custom range, put an explicit
  time filter in the query only if the tool documents it; otherwise pick the nearest
  allowed window.
- **`organizationSlug`** is required whenever no `url` is given.
- **`limit`** ranges by tool: `search_sentry_tools` takes `limit` 1–20 (default 8);
  `search_issues` takes `limit` 1–100 (default 10); other search tools take `limit`
  1–100 (default 10).
- **`fields`** on `search_events` is validated strictly (`Invalid input` three times in
  the logs, with no detail). Use only field names returned by the tool's own schema or
  by a previous successful result, and pass them in the shape the schema shows (array vs
  comma-separated string). If it is rejected, retry once with the smallest set that
  answers the question rather than a long list.

## Search query syntax

Sentry search is `key:value` pairs separated by spaces (space means AND). Things that
have been rejected, and what to do instead:

- **`OR` / `AND` keywords** are rejected with: `Error parsing search query: Boolean
  statements containing "OR" or "AND" are not supported in this search`. Avoid them.
  Run one search per branch and merge the results yourself, or use an in-list on one
  attribute where Sentry supports it (`environment:[production,staging]`).
- **Unknown attributes** fail validation with the format `INVALID <key> — Unknown
  attribute`; `env` and `message` were observed rejected. Do not invent keys. Use
  `environment:` for the environment key; a free-text `message:` key is not valid on
  every endpoint, so verify against the tool's docs or drop it. Otherwise use keys you
  have already seen in a result, or standard ones for the dataset (for issues:
  `is:unresolved`, `level:error`, `environment`, `release`, `assigned`; for custom tags
  use `tags[name]:value` if the tool supports it).
- **`timestamp:` ranges** — the `timestamp:` key exists, but the value format was wrong
  in the logged failure: `timestamp: >-10m` was rejected with "Expected +/-duration
  (e.g. +1h) or ISO 8601-like (e.g. 2026-09-30T21:58:15.44)". Use the `period`
  argument for relative ranges; if you must filter time in the query, use
  `timestamp:-1h` style or ISO 8601, not `>-10m`.
- Quote values containing spaces: `message:"connection reset"`.

When a search is rejected, change the query once, deliberately, based on the error
text. If it is still rejected, report the error to the user rather than cycling
through variants.

## Errors that retrying will not fix

- **`Unauthorized` / 403 "You do not have permission"**: the token or session lacks
  access to that org, project or action. Stop, tell the user which org/project you were
  trying to reach, and do not retry with different arguments.
- **404 "requested resource does not exist"**: usually a wrong slug or ID. Re-check the
  organization slug, project slug and the issue or event ID against what the user gave
  you or what a list call returned. Fix the identifier before calling again.

## Open items for the maintainer

These cannot be settled from the error logs alone. Fill them in once and the skill gets
stronger:

- The exact valid values and shape of `fields` for `search_events` (the schema only
  lists field names plus aggregate functions like `count()` and `avg()`; paste the
  tool's input schema here).
- Which Sentry tools are actually exposed in your sessions, so the discovery step can name
  the few you really use.

