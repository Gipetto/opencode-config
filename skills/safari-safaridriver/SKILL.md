---
name: safari-safaridriver
description: Drive real Safari through /usr/bin/safaridriver --mcp over a stdio bridge when the safari-mcp MCP server is not attached. Use this skill whenever Safari automation is needed (tabs, page text, JavaScript, screenshots, console errors on a real Safari page) AND the safari-mcp tools (create_tab, get_page_content) are absent from the session tool catalog. Do not use it when those tools are present; call them directly instead.
---

# Safari via safaridriver --mcp

When safari-mcp is not attached, Safari is still fully drivable: `/usr/bin/safaridriver
--mcp` speaks MCP over stdio, and a small Node bridge turns it into a local HTTP
endpoint you can hit with curl. This path is verified working on this machine: no
sudo, no "Allow Remote Automation" enablement, no config changes.

Make NO changes to `~/.config/opencode/opencode.json` or the existing safari-mcp MCP
config. This skill runs entirely outside the MCP layer.

## Workflow

1. **Probe the session catalog first.** In Code Mode, `search({query: 'create_tab'})`
   and `search({query: 'get_page_content'})`. If safari-mcp tools come back, use
   them and stop — this skill is only the fallback. If they are absent, continue.
2. **Copy the bridge and start it as a long-lived background process.** Never
   hand-roll the bridge; always copy the asset:

   ```bash
   cp ~/.config/opencode/skills/safari-safaridriver/assets/safari-bridge.mjs \
      "$TMPDIR/opencode/safari-bridge.mjs"
   nohup node "$TMPDIR/opencode/safari-bridge.mjs" \
      > "$TMPDIR/opencode/safari-bridge.log" 2>&1 &
   ```

   The bridge writes its own PID to `$TMPDIR/opencode/safari-bridge.pid` once it
   is ready (check the log for the `ready on ...` line).

   (On this machine `$TMPDIR/opencode` is
   `/private/var/folders/7w/4lmvtkb116g3zh9cbyzm3wwm0000gn/T/opencode`.)

   The process must stay alive for the whole automation session. Spawning a
   short-lived safaridriver per command kills the automation session with the
   process: tabs die between commands (`No active tab`, `list_tabs` returns `[]`)
   and the user never sees the Safari automation banner — they expect to see it,
   and a persistent session keeps it visible. stderr noise from the driver is
   ignorable; check the log file only when something fails.
3. **Smoke test before doing real work:**

   ```bash
   curl -s http://127.0.0.1:4737/call -d '{"tool":"page_info","args":{}}'
   ```

   A JSON reply with `title`/`url` (or a tool error about no active tab) means the
   bridge is live. If the second bridge instance exits with "port 4737 already
   bound", a bridge is already running — reuse it, do not start another.
4. **Per-command usage.** Every driver tool is one curl away. Body shape:
   `{"tool": "<name>", "args": { ... }}`. Verified forms:

   ```bash
   curl -s http://127.0.0.1:4737/call -d '{"tool":"create_tab","args":{"url":"https://example.com/"}}'
   curl -s http://127.0.0.1:4737/call -d '{"tool":"evaluate_javascript","args":{"expression":"return document.title;"}}'
   curl -s http://127.0.0.1:4737/call -d '{"tool":"browser_console_messages","args":{"level_filter":"error","limit":10}}'
   curl -s http://127.0.0.1:4737/call -d '{"tool":"screenshot","args":{"savePath":"/path/out.png"}}'
   ```

## Tool set

From `tools/list`: `create_tab(url)->{handle}`, `navigate_to_url({tab_uuid,url})`,
`list_tabs`, `switch_tab(handle)`, `close_tab(handle)`, `page_info`,
`evaluate_javascript(expression[,frameId])`, `get_page_content(format|region...)`,
`screenshot({savePath[,full_page]})`, `browser_console_messages({level_filter,
limit, clear})`, `page_interactions`, `wait_for_navigation`,
`list_network_requests`, `get_network_request`, `set_viewport_size`,
`set_emulated_media`, `browser_dialogs`.

## Gotchas — all personally hit

- **`evaluate_javascript` treats `expression` as a FUNCTION BODY.** Multi-statement
  code needs an explicit `return`. A bare IIFE without `return` yields `null`
  silently — it looks like a dead page, it is your bug.
- **`evaluate_javascript` acts on the ACTIVE tab.** After `create_tab` it is
  active, but when in doubt check `list_tabs` and `switch_tab` first.
- **`browser_console_messages` `level_filter` has no `'all'`.** Call `'error'` and
  `'warning'` separately.
- **`screenshot` `savePath` writes a PNG you then read with the Read tool.** This
  is the ONLY way to "see" the page if `screencapture` fails with "could not
  create image from display".
- **Do NOT use AppleScript `do JavaScript`** (needs "Allow JavaScript from Apple
  Events", usually off) **or plain `screencapture`** (screen-recording
  permission). This driver sidesteps both.
- **Page text/DOM scraping:** `evaluate_javascript` with a `JSON.stringify(...)`
  return works fine; `get_page_content` is the blessed alternative for text trees.
- **`get_page_content` textTree mangles relative hrefs.** SSR emits correct
  relative links; extraction renders broken-looking absolutes with segment loss.
  A 404 on a manually-constructed such URL is NOT evidence of a broken link.
  Verify hrefs via `evaluate_javascript` with
  `fetch(path).then(r=>r.text())` + regex over the raw HTML before reporting
  broken-link bugs.
- **Console triage pointer:** when the goal is error triage, pull
  `browser_console_messages` with `level_filter` `error` first, then `warning`;
  clear between page loads with `{"clear":true}` so you only see the current
  page's noise.

## Cleanup

Kill both processes when done — the bridge and its safaridriver child:

```bash
BRIDGE_PID=$(cat "$TMPDIR/opencode/safari-bridge.pid")
kill "$BRIDGE_PID"
pkill -P "$BRIDGE_PID" safaridriver
rm -f "$TMPDIR/opencode/safari-bridge.pid"
```

The bridge forwards SIGTERM to its child and removes its own PID file, so the
`kill` alone is usually enough; the `pkill` covers an orphaned driver (an
orphaned `safaridriver --mcp` also keeps port 4737's automation session alive
and blocks the next bridge). Leaving the bridge running keeps the Safari
automation banner up on the user's screen — that is why cleanup is part of the
workflow, not an afterthought.

## Raw WebDriver (if --mcp disappears)

Secondary, **unverified on this machine** — written from W3C WebDriver spec
knowledge, not a live run. Only reach for it if `--mcp` stops working.

Prerequisites the `--mcp` path does not need: enable **Develop → Allow Remote
Automation** in Safari, and run `sudo safaridriver --enable` once. Then:

```bash
safaridriver --port 4444 &
curl -s -X POST http://127.0.0.1:4444/session \
  -H 'content-type: application/json' \
  -d '{"capabilities":{"alwaysMatch":{}}}'
```

That returns a `sessionId`; all further calls carry it under
`/session/<id>/...`: `POST /url` (navigate), `POST /execute/sync`
(`{"script":..., "args":[]}` — script must use `return`), `POST /element`
(find by CSS/XPath), `GET /window/screenshot` (base64 PNG). Key difference
from the bridge: **only one WebDriver session at a time**, and session state
lives in the driver process, so keep `safaridriver` long-lived for the same
reason as the bridge. Prior art (`TamasNo1/safari-cli`) persists session IDs
to a JSON file and injects JS hooks for console/network capture — the `--mcp`
driver gives you console and network as first-class tools instead.
