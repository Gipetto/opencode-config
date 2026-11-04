import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"

import { Plugin } from "@opencode/plugin"

const DEFAULTS = {
  kinBin: "kin", configPath: null, env: {}, chunkChars: 3400,
  chunkTimeoutMs: 120000, compactChunkTimeoutMs: 10000, sweepStaleMs: 43200000,
  toolOutputChars: 1500, dropRecentTurns: 2,
  captureOnIdle: true, minCaptureChars: 6000, maxChunks: 8,
  captureOnCompact: true, maxFlushChunks: 3, contextLevel: "summarized",
  contextTokens: 800, contextTimeoutMs: 8000, trustedOnly: false,
  prime: true, primeTokens: 500, primeTimeoutMs: 5000, debug: false,
}

const projectRoot = new URL("../../", import.meta.url)
const resolveConfigPath = (path) => !path || path.startsWith("/") ? path : new URL(path, projectRoot).pathname
const hash = (value) => createHash("sha256").update(value).digest("hex")
const truncate = (text, max) => text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`

export const matchesLocation = (location, expected) => Boolean(
  location?.directory && expected?.directory &&
  resolvePath(location.directory) === resolvePath(expected.directory) &&
  (location.workspaceID ?? null) === (expected.workspaceID ?? null),
)

export const serializeMessage = (message, toolCap = Infinity) => {
  if (message.type === "user") return message.text ? `[User]: ${message.text}` : ""
  if (message.type === "compaction") {
    return message.status === "completed" && message.summary ? `[Previous summary]: ${message.summary}` : ""
  }
  if (message.type !== "assistant") return ""
  const out = []
  for (const part of message.content || []) {
    if (part.type === "text" && part.text) out.push(`[Assistant]: ${part.text}`)
    if (part.type !== "tool") continue
    const state = part.state || {}
    out.push(`[Tool call]: ${part.name}(${JSON.stringify(state.input ?? {})})`)
    if (state.status === "completed") {
      const body = (state.content || []).map((item) => item.type === "text" ? item.text : item.uri || "[file]").join("\n")
      out.push(`[Tool result]: ${truncate(body, toolCap)}`)
    } else if (state.status === "error") {
      out.push(`[Tool error]: ${state.error?.message || state.error || "unknown error"}`)
    }
  }
  return out.join("\n")
}

export const chunkText = (text, size, maxChunks = Infinity) => {
  const limit = Math.max(500, size)
  const chunks = []
  let rest = text
  while (rest.length > limit && chunks.length < maxChunks) {
    let end = rest.lastIndexOf("\n\n", limit)
    if (end < limit * 0.5) end = limit
    chunks.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest && chunks.length < maxChunks) chunks.push(rest)
  return chunks
}

const emptyJournal = () => ({ version: 1, messages: [] })

// Journals written by this process never need the startup sweep; only files
// left behind by earlier processes do, and they are all written through here.
const liveSessions = new Set()

export const createJournalStore = (root, projectKey) => {
  const dir = join(root, "opencode", "kindex-compaction", hash(projectKey))
  const fileFor = (sessionID) => join(dir, `${hash(sessionID)}.json`)
  return {
    dir,
    async read(sessionID) {
      try {
        const journal = JSON.parse(await readFile(fileFor(sessionID), "utf8"))
        if (journal.version !== 1 || !Array.isArray(journal.messages)) throw new Error("invalid journal")
        return journal
      } catch (error) {
        if (error.code === "ENOENT") return emptyJournal()
        throw error
      }
    },
    async write(sessionID, journal) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      const file = fileFor(sessionID)
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      const handle = await open(temp, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ ...journal, session: sessionID }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, file)
      await chmod(file, 0o600)
      const parent = await open(dirname(file), "r")
      try { await parent.sync() } finally { await parent.close() }
      liveSessions.add(`${hash(projectKey)}:${sessionID}`)
    },
    async list() {
      let names
      try { names = await readdir(dir) } catch (error) {
        if (error.code === "ENOENT") return []
        throw error
      }
      const found = []
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        try {
          const journal = JSON.parse(await readFile(join(dir, name), "utf8"))
          if (journal.version !== 1 || !Array.isArray(journal.messages)) continue
          const sessionID = journal.session
          if (typeof sessionID !== "string" || liveSessions.has(`${hash(projectKey)}:${sessionID}`)) continue
          found.push({ sessionID, mtimeMs: (await stat(join(dir, name))).mtimeMs })
        } catch {}
      }
      return found
    },
    async remove(sessionID) {
      await rm(fileFor(sessionID), { force: true })
    },
  }
}

const latestBoundary = (messages) => {
  let index = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type === "compaction" && messages[i].status === "completed") index = i
  }
  return messages.slice(index + 1)
}

const conversationTopic = (messages, fallback) => {
  const firstUser = latestBoundary(messages).find((message) => message.type === "user" && message.text)
  const topic = firstUser?.text?.replace(/\s+/g, " ").trim().slice(0, 90)
  return topic || fallback
}

const idleMessages = (messages, turnsToKeep) => {
  let userTurns = 0
  let end = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type !== "user") continue
    userTurns++
    if (userTurns > turnsToKeep) break
    end = i
  }
  return messages.slice(0, end)
}

export const messageKey = (message, text) => `${message.id}:${hash(text)}`

export const needsFlush = (messages, journal, options) => {
  if (journal.messages.some((item) => item.chunks.some((chunk) => chunk.state === "pending"))) return true
  const existing = new Set(journal.messages.map((item) => item.key))
  let added = 0
  for (const message of latestBoundary(messages)) {
    const text = serializeMessage(message)
    if (!text || existing.has(messageKey(message, text))) continue
    added += text.length
  }
  return added >= options.minCaptureChars
}

export const flushJournal = async ({ store, sessionID, messages, options, runKin, includeRecent = false, now = Date.now() }) => {
  const journal = await store.read(sessionID)
  for (const item of journal.messages) {
    for (const chunk of item.chunks) {
      if (chunk.state === "inflight") chunk.state = "unknown"
    }
  }
  const existing = new Set(journal.messages.map((item) => item.key))
  const source = latestBoundary(messages)
  const boundaryIds = new Set(source.map((message) => message.id))
  for (const item of journal.messages) {
    if (boundaryIds.has(item.id) || !item.chunks.every((chunk) => chunk.state === "unknown")) continue
    delete item.source
    for (const chunk of item.chunks) delete chunk.body
  }
  const candidates = includeRecent ? source : idleMessages(source, options.dropRecentTurns)
  for (const message of candidates) {
    const text = serializeMessage(message)
    if (!text) continue
    const key = messageKey(message, text)
    if (existing.has(key)) continue
    const topic = source.find((item) => item.type === "user" && item.text)?.text
      ?.replace(/\s+/g, " ").trim().slice(0, 90) || "session"
    journal.messages.push({
      key, id: message.id, source: text, topic,
      chunks: chunkText(text, options.chunkChars - topic.length - 4)
        .map((body) => ({ body, state: "pending", attempts: 0, nextAttemptAt: 0 })),
    })
  }

  await store.write(sessionID, journal)
  const limit = includeRecent ? options.maxFlushChunks : options.maxChunks
  const chunkTimeoutMs = includeRecent
    ? options.compactChunkTimeoutMs ?? options.chunkTimeoutMs
    : options.chunkTimeoutMs
  let attempted = 0
  for (const item of journal.messages) {
    for (const chunk of item.chunks) {
      if (attempted >= limit) return { attempted, failed: false, journal }
      if (chunk.state !== "pending") continue
      if (chunk.nextAttemptAt > now) return { attempted, failed: false, journal }
      chunk.state = "inflight"
      chunk.attempts++
      await store.write(sessionID, journal)
      attempted++
      const result = await runKin(`${item.topic}\n\n${chunk.body}`, chunkTimeoutMs)
      if (result.status === "success") {
        chunk.state = "unknown"
        chunk.lastAttemptAt = now
      } else {
        chunk.state = "pending"
        chunk.lastError = result.error || result.status
        chunk.nextAttemptAt = now + Math.min(3600000, 1000 * 2 ** Math.min(chunk.attempts, 12))
        await store.write(sessionID, journal)
        return { attempted, failed: true, journal }
      }
      await store.write(sessionID, journal)
    }
  }
  return { attempted, failed: false, journal }
}

export const flushStoredJournal = async ({ store, sessionID, options, runKin, now = Date.now() }) => {
  const journal = await store.read(sessionID)
  if (!journal) return { attempted: 0, failed: false }
  for (const item of journal.messages) {
    for (const chunk of item.chunks) {
      if (chunk.state === "inflight") chunk.state = "unknown"
    }
  }
  let attempted = 0
  for (const item of journal.messages) {
    for (const chunk of item.chunks) {
      if (chunk.state !== "pending") continue
      chunk.state = "inflight"
      chunk.attempts++
      await store.write(sessionID, journal)
      attempted++
      const result = await runKin(`${item.topic}\n\n${chunk.body}`,
        options.compactChunkTimeoutMs ?? options.chunkTimeoutMs)
      if (result.status === "success") {
        chunk.state = "unknown"
        chunk.lastAttemptAt = now
      } else {
        chunk.state = "pending"
        chunk.lastError = result.error || result.status
        chunk.nextAttemptAt = now + Math.min(3600000, 1000 * 2 ** Math.min(chunk.attempts, 12))
        await store.write(sessionID, journal)
        return { attempted, failed: true }
      }
      await store.write(sessionID, journal)
    }
  }
  return { attempted, failed: false }
}

const run = async (bin, args, input, timeoutMs, cwd, env) => {
  let proc
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd, env: { ...process.env, ...(env || {}) },
      stdin: input == null ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe", stderr: "pipe",
    })
  } catch (error) {
    return { status: "failure", error: error.message }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill(9) } catch {}
  }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    return {
      status: !timedOut && code === 0 ? "success" : "failure",
      stdout: stdout.trim(),
      error: timedOut ? "timed out" : code !== 0 ? stderr.trim() || `exit ${code}` : "",
    }
  } catch (error) {
    return { status: "failure", error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

export default Plugin.define({
  id: "kindex-compaction",
  async setup(ctx) {
    const opt = { ...DEFAULTS, ...ctx.options }
    opt.configPath = resolveConfigPath(opt.configPath)
    const directory = ctx.location.project?.directory || ctx.location.directory
    const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
    const store = createJournalStore(stateRoot, directory)
    const primed = new Map()
    const queues = new Map()
    const fallbackTopic = directory.split("/").filter(Boolean).pop() || "session"
    const note = (...args) => { if (opt.debug) console.error("[kindex]", ...args) }
    const kinArgs = (args) => opt.configPath ? [...args, "--config", opt.configPath] : args
    const runKin = (input, timeoutMs = opt.chunkTimeoutMs) => run(opt.kinBin, kinArgs(["compact-hook"]), input, timeoutMs, directory, opt.env)
    const serialize = (sessionID) => ctx.session.context({ sessionID })
    const enqueue = (sessionID, task) => {
      const previous = queues.get(sessionID) || Promise.resolve()
      const current = previous.catch(() => {}).then(task)
      queues.set(sessionID, current)
      return current.finally(() => { if (queues.get(sessionID) === current) queues.delete(sessionID) })
    }
    const capture = (sessionID, includeRecent) => enqueue(sessionID, async () => {
      const messages = await serialize(sessionID)
      const result = await flushJournal({ store, sessionID, messages, options: opt, runKin, includeRecent })
      if (result.failed) console.warn(`[kindex] capture failed for session ${sessionID}; source remains in the private journal`)
      note("capture", sessionID, result.attempted, result.failed ? "failed" : "attempted")
      return { messages, failed: result.failed }
    })
    const contextBlock = async (topic) => {
      const args = ["context", "--topic", topic, "--level", opt.contextLevel, "--tokens", String(opt.contextTokens), "--format", "raw"]
      if (opt.trustedOnly) args.push("--trusted-only")
      const result = await run(opt.kinBin, kinArgs(args), null, opt.contextTimeoutMs, directory, opt.env)
      return result.status === "success" && result.stdout && !result.stdout.includes("No relevant context") ? result.stdout : ""
    }
    const eventMatchesLocation = async (event) => {
      let location = event.location
      const wrongDirectory = location?.directory && ctx.location.directory &&
        resolvePath(location.directory) !== resolvePath(ctx.location.directory)
      const wrongWorkspace = location?.workspaceID && ctx.location.workspaceID &&
        location.workspaceID !== ctx.location.workspaceID
      if (wrongDirectory || wrongWorkspace) {
        note("skipping event from another location", location.directory)
        return false
      }
      if (!location?.directory || (ctx.location.workspaceID && !location.workspaceID)) {
        const session = await ctx.session.get({ sessionID: event.data.sessionID })
        location = session?.location
      }
      if (!matchesLocation(location, ctx.location)) {
        note("skipping event with unresolved location", event.data.sessionID)
        return false
      }
      return true
    }

    await ctx.session.hook("context", async (event) => {
      if (!opt.prime || !event.sessionID) return
      if (!primed.has(event.sessionID)) {
        primed.set(event.sessionID, run(
          opt.kinBin, kinArgs(["prime", "--for", "hook", "--tokens", String(opt.primeTokens)]),
          null, opt.primeTimeoutMs, directory, opt.env,
        ))
      }
      const result = await primed.get(event.sessionID)
      if (result.status === "success" && result.stdout) event.system.push({ type: "text", text: result.stdout })
    })

    await ctx.session.hook("compaction", async (event) => {
      const { messages } = opt.captureOnCompact
        ? await capture(event.sessionID, true)
        : { messages: await serialize(event.sessionID) }
      const block = await contextBlock(conversationTopic(messages, fallbackTopic))
      if (block) event.system.push({ type: "text", text: `Durable project memory from Kindex:\n\n${block}` })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const { type, data } = event
          if (type === "session.compaction.ended") {
            if (!await eventMatchesLocation(event)) continue
            note("compacted", data.sessionID)
            continue
          }
          if (type === "session.deleted") {
            const { sessionID } = data
            if (!sessionID) continue
            // Real session.deleted events carry no location; the per-project
            // journal store is the ownership scope in that case.
            const location = event.location
            if (location?.directory && ctx.location.directory &&
              resolvePath(location.directory) !== resolvePath(ctx.location.directory)) continue
            if (location?.workspaceID && ctx.location.workspaceID &&
              location.workspaceID !== ctx.location.workspaceID) continue
            try {
              const { failed } = await enqueue(sessionID, () =>
                flushStoredJournal({ store, sessionID, options: opt, runKin }))
              if (failed) {
                console.warn(`[kindex] tail capture failed for deleted session ${sessionID}; journal retained`)
                continue
              }
              await store.remove(sessionID)
              note("journal removed", sessionID)
            } catch (error) {
              console.warn(`[kindex] tail capture failed for deleted session ${data.sessionID}; journal retained`, error.message)
            }
            continue
          }
          if (!opt.captureOnIdle || type !== "session.idle" || !data.sessionID) continue
          if (!await eventMatchesLocation(event)) continue
          const messages = await serialize(data.sessionID)
          const journal = await store.read(data.sessionID)
          if (!needsFlush(messages, journal, opt)) {
            note("idle gate closed", data.sessionID)
            continue
          }
          await capture(data.sessionID, false)
        } catch (error) {
          console.error("[kindex] event processing failed", error)
        }
      }
    })().catch((error) => { if (!controller.signal.aborted) console.error("[kindex] event subscription failed", error) })
    void (async () => {
      const staleBefore = Date.now() - opt.sweepStaleMs
      const journals = (await store.list()).sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, 50)
      for (const { sessionID, mtimeMs } of journals) {
        if (controller.signal.aborted) return
        try { await capture(sessionID, mtimeMs < staleBefore) }
        catch (error) { note("sweep skipped", sessionID, error.message) }
      }
    })().catch((error) => { if (!controller.signal.aborted) console.error("[kindex] startup sweep failed", error) })
    return () => controller.abort()
  },
})
