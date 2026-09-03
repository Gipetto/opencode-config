/**
 * kindex-compaction.js - offload session knowledge to Kindex, incrementally.
 *
 * Install: ~/.config/opencode/plugin/kindex-compaction.js   (or <project>/.opencode/plugin/)
 * Plain JS, no build step, auto-discovered by OpenCode's {plugin,plugins}/*.{ts,js} glob.
 *
 * IMPORTANT: this file may export ONLY plugin functions. OpenCode's loader walks every
 * module export and throws TypeError on any export that is not a function.
 *
 * All kin config and env is scoped to the processes this plugin spawns:
 *   configPath -> passed as `--config` on every kin subcommand (bypasses layering)
 *   env        -> ANTHROPIC_BASE_URL / key, so Codex and Claude Code are unaffected
 *
 * @typedef {import("@opencode-ai/plugin").Plugin} Plugin
 */

const DEFAULTS = {
  kinBin: "kin",
  configPath: null, // e.g. "/Users/username/.config/kindex/opencode.yaml"
  env: {},          // e.g. { ANTHROPIC_BASE_URL: "http://localhost:8000", OMLX_KEY: "local" }

  // Capture. kin truncates every extraction prompt at text[:4000], so the
  // transcript must be chunked by the caller or only the first chunk is seen.
  chunkChars: 3400,
  chunkTimeoutMs: 120000, // ~60s/chunk at 17 tok/s, plus headroom
  toolOutputChars: 1500,
  dropRecentTurns: 2, // recent turns survive compaction verbatim

  // Incremental capture between turns, off the critical path.
  captureOnIdle: true,
  minCaptureChars: 6000, // batch: skip idle capture until this much is pending
  maxChunks: 8,

  // Flush at compaction. Small if idle capture is keeping up.
  captureOnCompact: true,
  maxFlushChunks: 3,

  // Retrieval injected into the compaction prompt.
  contextLevel: "summarized", // full | abridged | summarized | executive | index
  contextTokens: 800,
  contextTimeoutMs: 8000,
  trustedOnly: false,

  // Session-start priming of the system prompt.
  prime: true,
  primeTokens: 500,
  primeTimeoutMs: 5000,

  debug: false,
}

const configRoot = new URL("../", import.meta.url)
const resolveConfigPath = (configPath) => {
  if (!configPath || configPath.startsWith("/")) return configPath
  return new URL(configPath, configRoot).pathname
}

const truncate = (s, max) => (s.length <= max ? s : `${s.slice(0, max)}\n[truncated]`)

/** Spawn kin, feed stdin, hard-kill on timeout, never throw. */
const run = async (bin, args, input, timeoutMs, cwd, env) => {
  let proc
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdin: input == null ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    return "" // kin not on PATH
  }
  const timer = setTimeout(() => {
    try { proc.kill(9) } catch {}
  }, timeoutMs)
  try {
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.trim()
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

/** Mirror of OpenCode's own compaction serializer, minus reasoning parts. */
const serializeMessage = (msg, toolCap) => {
  const info = msg.info || {}
  const parts = msg.parts || []
  if (info.role === "user") {
    const text = parts
      .filter((p) => p.type === "text" && !p.ignored && p.text)
      .map((p) => p.text)
      .join("\n")
    return text ? `[User]: ${text}` : ""
  }
  const out = []
  for (const p of parts) {
    if (p.type === "text" && p.text) out.push(`[Assistant]: ${p.text}`)
    if (p.type !== "tool") continue
    const st = p.state || {}
    out.push(`[Tool call]: ${p.tool}(${JSON.stringify(st.input ?? {})})`)
    if (st.status === "completed") {
      const body = st.time && st.time.compacted ? "[cleared]" : truncate(st.output || "", toolCap)
      out.push(`[Tool result]: ${body}`)
    } else if (st.status === "error") {
      out.push(`[Tool error]: ${st.error}`)
    }
  }
  return out.join("\n")
}

/**
 * Uncaptured messages, minus the turns compaction keeps verbatim.
 * Resumes from the watermark when we have one; otherwise falls back to the last
 * summary boundary, which is the best guess after an OpenCode restart.
 */
const pendingSlice = (messages, dropRecentTurns, sinceID) => {
  let start = 0
  if (sinceID) {
    const idx = messages.findIndex((m) => (m.info || {}).id === sinceID)
    if (idx >= 0) start = idx + 1
  }
  if (!start) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info || {}
      if (info.role === "assistant" && info.summary) { start = i + 1; break }
    }
  }
  let end = messages.length
  let turns = 0
  for (let i = messages.length - 1; i > start; i--) {
    if ((messages[i].info || {}).role !== "user") continue
    turns++
    end = i
    if (turns >= dropRecentTurns) break
  }
  return start >= end ? [] : messages.slice(start, end)
}

/** kin derives its retrieval topic from the first line of the first 100 chars. */
const topicLine = (slice, fallback) => {
  for (const msg of slice) {
    if ((msg.info || {}).role !== "user") continue
    const text = (msg.parts || []).find((p) => p.type === "text" && p.text)
    if (text) {
      const line = text.text.replace(/\s+/g, " ").trim().slice(0, 90)
      if (line) return line
    }
  }
  return fallback
}

/** Pack paragraphs into chunks that fit under kin's 4000-char extraction window. */
const chunkText = (text, size, maxChunks) => {
  const limit = Math.max(500, size)
  const out = []
  let buf = ""
  for (const para of text.split("\n\n")) {
    let rest = para
    while (rest.length > limit) {
      if (buf) { out.push(buf); buf = "" }
      if (out.length >= maxChunks) return out
      out.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
    if (out.length >= maxChunks) return out
    if (buf.length + rest.length + 2 > limit) {
      if (buf) out.push(buf)
      if (out.length >= maxChunks) return out
      buf = rest
    } else {
      buf = buf ? `${buf}\n\n${rest}` : rest
    }
  }
  if (buf && out.length < maxChunks) out.push(buf)
  return out
}

/**
 * @type {Plugin}
 */
export const KindexCompaction = async ({ client, directory, worktree }, options = {}) => {
  const opt = { ...DEFAULTS, ...options }
  opt.configPath = resolveConfigPath(opt.configPath)
  const primed = new Map()     // sessionID -> Promise<string>
  const watermark = new Map()  // sessionID -> id of last captured message
  const busy = new Set()       // sessionID currently capturing

  const note = (...args) => { if (opt.debug) console.error("[kindex]", ...args) }
  const fallbackTopic = worktree.split("/").filter(Boolean).pop() || "session"

  // --config is a subcommand flag, so it must be appended after the subcommand.
  const kinArgs = (args) => (opt.configPath ? [...args, "--config", opt.configPath] : args)

  /** @returns {Promise<{last: string, topic: string, body: string} | null>} */
  const pending = async (sessionID) => {
    const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
    const messages = (res && res.data) || (Array.isArray(res) ? res : [])
    if (!messages.length) return null
    const slice = pendingSlice(messages, opt.dropRecentTurns, watermark.get(sessionID))
    if (!slice.length) return null
    const body = slice
      .map((m) => serializeMessage(m, opt.toolOutputChars))
      .filter(Boolean)
      .join("\n\n")
    if (!body.trim()) return null
    return {
      last: slice[slice.length - 1].info.id,
      topic: topicLine(slice, `${fallbackTopic} session`),
      body,
    }
  }

  /** Stage capture candidates, one kin call per chunk. Advances the watermark. */
  const capture = async (sessionID, t, maxChunks) => {
    if (!t || busy.has(sessionID)) return 0
    busy.add(sessionID)
    try {
      const chunks = chunkText(t.body, opt.chunkChars - t.topic.length - 4, maxChunks)
      let staged = 0
      for (const c of chunks) {
        const out = await run(
          opt.kinBin, kinArgs(["compact-hook"]), `${t.topic}\n\n${c}`,
          opt.chunkTimeoutMs, worktree, opt.env,
        )
        if (out.includes("staged")) staged++
        note("chunk", `${c.length} chars ->`, out.split("\n")[0] || "(silent)")
      }
      watermark.set(sessionID, t.last)
      note("captured", sessionID, `${staged}/${chunks.length} chunks staged`)
      return staged
    } finally {
      busy.delete(sessionID)
    }
  }

  /** Retrieval block, independent of capture, no LLM call, fast. */
  const contextBlock = async (topic) => {
    const args = [
      "context", "--topic", topic,
      "--level", opt.contextLevel,
      "--tokens", String(opt.contextTokens),
      "--format", "raw",
    ]
    if (opt.trustedOnly) args.push("--trusted-only")
    const out = await run(opt.kinBin, kinArgs(args), null, opt.contextTimeoutMs, worktree, opt.env)
    if (!out || out.includes("No relevant context")) return ""
    return out
  }

  return {
    // Runs immediately before the summary call. Flushes whatever idle capture
    // has not reached yet, then appends durable memory to the compaction prompt.
    "experimental.session.compacting": async ({ sessionID }, output) => {
      try {
        const t = await pending(sessionID)
        if (opt.captureOnCompact) await capture(sessionID, t, opt.maxFlushChunks)
        const block = await contextBlock(t ? t.topic : fallbackTopic)
        if (block) output.context.push(`Durable project memory from Kindex:\n\n${block}`)
      } catch (err) {
        note("compacting hook failed", err)
      }
    },

    // Prime once per session and memoize, so the system prefix stays byte-stable
    // and the oMLX prefix cache is not invalidated on every turn.
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!opt.prime || !sessionID) return
      try {
        if (!primed.has(sessionID)) {
          primed.set(
            sessionID,
            run(
              opt.kinBin,
              kinArgs(["prime", "--for", "hook", "--tokens", String(opt.primeTokens)]),
              null, opt.primeTimeoutMs, worktree, opt.env,
            ),
          )
        }
        const block = await primed.get(sessionID)
        if (block) output.system.push(block)
      } catch (err) {
        note("prime failed", err)
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.compacted") {
          note("compacted", event.properties)
          return
        }
        if (!opt.captureOnIdle || event.type !== "session.idle") return
        const id = event.properties && event.properties.sessionID
        if (!id || busy.has(id)) return
        const t = await pending(id)
        if (!t || t.body.length < opt.minCaptureChars) return
        await capture(id, t, opt.maxChunks)
      } catch (err) {
        note("event hook failed", err)
      }
    },
  }
}
