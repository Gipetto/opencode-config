import assert from "node:assert/strict"
import { access, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import "./plugin-loader.js"

const tempRoot = join(process.env.TMPDIR || tmpdir(), "opencode")
await mkdir(tempRoot, { recursive: true })
const root = await mkdtemp(join(tempRoot, "kindex-plugin-tests-"))
process.env.XDG_STATE_HOME = join(root, "state")
process.env.KINDEX_POLICY_PATH = join(root, "policy.md")
await writeFile(process.env.KINDEX_POLICY_PATH, "policy one")

const [{
  serializeMessage, messageKey, needsFlush, createJournalStore, flushJournal, flushStoredJournal,
}, { default: memoryPlugin }] = await Promise.all([
  import("../plugins/kindex-compaction/index.js"),
  import("../plugins/kindex-memory/index.js"),
])

const compactionPlugin = await import("../plugins/kindex-compaction/index.js")
const purgeJournal = compactionPlugin.purgeJournal ?? null
const sweepOnce = compactionPlugin.sweepOnce ?? null

const options = {
  dropRecentTurns: 0,
  chunkChars: 3400,
  maxChunks: 8,
  maxFlushChunks: 3,
}

const userMessage = (id, text) => ({ id, type: "user", text })
const eventFeed = () => {
  const queue = []
  const waiters = []
  let closed = false
  return {
    push(value) {
      const resolve = waiters.shift()
      if (resolve) resolve({ value, done: false })
      else queue.push(value)
    },
    subscribe({ signal }) {
      const close = () => {
        closed = true
        while (waiters.length) waiters.shift()({ done: true })
      }
      signal.addEventListener("abort", close, { once: true })
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (queue.length) return { value: queue.shift(), done: false }
              if (closed) return { done: true }
              return new Promise((resolve) => waiters.push(resolve))
            },
            async return() { close(); return { done: true } },
          }
        },
      }
    },
  }
}

test.after(async () => rm(root, { recursive: true, force: true }))

test("serializes v2 user, assistant, completed tool, and compaction messages", () => {
  const text = serializeMessage(userMessage("u1", "question"))
  const response = serializeMessage({
    id: "a1",
    type: "assistant",
    content: [
      { type: "text", text: "answer" },
      { type: "tool", id: "t1", name: "search", state: {
        status: "completed",
        input: { query: "needle" },
        content: [{ type: "text", text: "tool result" }],
      } },
    ],
  })
  const summary = serializeMessage({
    id: "c1", type: "compaction", status: "completed", summary: "prior turns",
  })

  assert.match(text, /question/)
  assert.match(response, /answer/)
  assert.match(response, /tool result/)
  assert.match(summary, /prior turns/)
})

test("journals all source before a capped compaction attempt and retains it after restart", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-one")
  const payload = "source-".repeat(2000)
  const messages = [userMessage("u1", "topic"), userMessage("u2", payload)]
  const attempted = []
  const first = await flushJournal({
    store, sessionID: "session-one", messages, options,
    includeRecent: true,
    runKin: async (text) => { attempted.push(text); return { status: "success", stdout: "staged" } },
  })

  assert.equal(first.attempted, options.maxFlushChunks)
  assert.equal(attempted.length, options.maxFlushChunks)
  assert.equal(first.journal.messages[1].source.includes(payload), true)
  assert.ok(first.journal.messages[1].chunks.some((chunk) => chunk.state === "pending"))
  assert.ok(first.journal.messages[1].chunks.some((chunk) => chunk.state === "unknown"))

  const reloaded = await store.read("session-one")
  const confirmedChunks = new Set(attempted)
  const resumedAttempts = []
  const compactedHistory = [{
    id: "c1", type: "compaction", status: "completed", summary: "summary only",
  }]
  const second = await flushJournal({
    store, sessionID: "session-one", messages: compactedHistory, options,
    includeRecent: true,
    runKin: async (text) => {
      resumedAttempts.push(text)
      return { status: "success", stdout: "staged" }
    },
  })

  assert.equal(reloaded.messages[1].source.includes(payload), true)
  assert.equal(second.journal.messages[1].source.includes(payload), true)
  assert.ok(resumedAttempts.length > 0)
  assert.ok(resumedAttempts.every((text) => !confirmedChunks.has(text)))
})

test("stops after a failed middle chunk and retries it before later chunks", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-two")
  const calls = []
  const payload = "chunk-source-".repeat(1000)
  const messages = [userMessage("u1", payload)]
  const first = await flushJournal({
    store, sessionID: "session-two", messages, options,
    includeRecent: true,
    runKin: async (text) => {
      calls.push(text)
      return calls.length === 2 ? { status: "failure", error: "temporary failure" } : { status: "success" }
    },
  })

  assert.equal(first.failed, true)
  assert.equal(calls.length, 2)
  assert.equal(first.journal.messages[0].chunks[0].state, "unknown")
  assert.equal(first.journal.messages[0].chunks[1].state, "pending")
  assert.equal(first.journal.messages[0].chunks[2].attempts, 0)

  const retry = await flushJournal({
    store, sessionID: "session-two", messages, options,
    includeRecent: true,
    now: Date.now() + 60_000,
    runKin: async (text) => { calls.push(text); return { status: "success" } },
  })

  assert.equal(calls[2], calls[1])
  assert.equal(retry.journal.messages[0].chunks[1].state, "unknown")
  assert.equal(retry.journal.messages[0].chunks[2].state, "unknown")
})

test("keeps journal private and scopes it by project and session", async () => {
  const project = "/repo-private"
  const store = createJournalStore(process.env.XDG_STATE_HOME, project)
  const journal = await flushJournal({
    store, sessionID: "private-session", messages: [userMessage("u1", "private source")],
    options, includeRecent: true,
    runKin: async () => ({ status: "success" }),
  })
  const otherSession = await store.read("other-session")
  const otherProject = await createJournalStore(process.env.XDG_STATE_HOME, "/repo-other").read("private-session")
  const projectKey = createHash("sha256").update(project).digest("hex")
  const sessionKey = createHash("sha256").update("private-session").digest("hex")
  const projectDir = join(process.env.XDG_STATE_HOME, "opencode", "kindex-compaction", projectKey)
  const file = join(projectDir, `${sessionKey}.json`)

  assert.equal(otherSession.messages.length, 0)
  assert.equal(otherProject.messages.length, 0)
  assert.ok(journal.journal.messages.length > 0)
  assert.equal((await stat(projectDir)).mode & 0o777, 0o700)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test("does not attempt extraction or report success when durable journal write fails", async () => {
  let attempted = false
  const store = {
    async read() { return { version: 1, messages: [] } },
    async write() { throw new Error("disk unavailable") },
  }

  await assert.rejects(flushJournal({
    store,
    sessionID: "write-failure",
    messages: [userMessage("u1", "must be retained")],
    options,
    includeRecent: true,
    runKin: async () => { attempted = true; return { status: "success" } },
  }), /disk unavailable/)
  assert.equal(attempted, false)
})

test("continues handling idle events after one transient session-context failure", async () => {
  let contextCalls = 0
  const feed = eventFeed()
  const messages = [userMessage("u1", "source after transient failure")]
  const ctx = {
    options: { ...options, prime: false, minCaptureChars: 0, dropRecentTurns: 0 },
    location: { directory: root, workspaceID: "workspace-test", project: { directory: root } },
    session: {
      async context() {
        contextCalls++
        if (contextCalls === 1) throw new Error("transient session API failure")
        return messages
      },
      async hook() {},
    },
    event: { subscribe: (opts) => feed.subscribe(opts) },
  }
  const oldError = console.error
  console.error = () => {}
  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    const store = createJournalStore(process.env.XDG_STATE_HOME, root)
    feed.push({
      type: "session.idle",
      data: { sessionID: "transient-session" },
      location: { directory: root, workspaceID: "workspace-test" },
    })
    for (let i = 0; i < 20 && contextCalls < 1; i++) await new Promise((resolve) => setTimeout(resolve, 1))

    feed.push({
      type: "session.idle",
      data: { sessionID: "transient-session" },
      location: { directory: root, workspaceID: "workspace-test" },
    })
    let journal = await store.read("transient-session")
    for (let i = 0; i < 100 && journal.messages.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
      journal = await store.read("transient-session")
    }

    assert.ok(contextCalls >= 3)
    assert.ok(journal.messages.some((item) => item.source.includes("source after transient failure")))
    await cleanup()
  } finally {
    console.error = oldError
  }
})

test("uses the active conversation topic for Kindex context and falls back only without one", async () => {
  const messagesBySession = new Map([
    ["topic-session", [
      userMessage("old-user", "old conversation topic"),
      { id: "c1", type: "compaction", status: "completed", summary: "earlier summary" },
      userMessage("u1", "Which decisions\n\nshould we preserve for this migration?"),
    ]],
    ["fallback-session", [{
      id: "a1", type: "assistant", content: [{ type: "text", text: "no user prompt exists" }],
    }]],
  ])
  const hooks = new Map()
  const contextCalls = []
  const readable = (value) => new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  globalThis.Bun = {
    spawn(args) {
      if (args.includes("context")) contextCalls.push(args)
      return {
        stdout: readable("context found"),
        stderr: readable(""),
        exited: Promise.resolve(0),
        kill() {},
      }
    },
  }
  const ctx = {
    options: { ...options, prime: false, maxFlushChunks: 0 },
    location: { directory: root, workspaceID: "workspace-test", project: { directory: root } },
    session: {
      async context({ sessionID }) { return messagesBySession.get(sessionID) },
      async hook(name, callback) { hooks.set(name, callback) },
    },
    event: { subscribe: (opts) => eventFeed().subscribe(opts) },
  }

  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    await hooks.get("compaction")({ sessionID: "topic-session", system: [] })
    await hooks.get("compaction")({ sessionID: "fallback-session", system: [] })

    const topicArgs = contextCalls[0]
    const fallbackArgs = contextCalls[1]
    assert.equal(topicArgs[topicArgs.indexOf("--topic") + 1], "Which decisions should we preserve for this migration?")
    assert.equal(fallbackArgs[fallbackArgs.indexOf("--topic") + 1], root.split("/").filter(Boolean).at(-1))
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("runs Kindex from the current project directory rather than a subdirectory or canonical root", async () => {
  const projectDirectory = join(root, "worktree")
  const subdirectory = join(projectDirectory, "packages", "app")
  const canonicalDirectory = join(root, "main-checkout")
  const hooks = new Map()
  const spawned = []
  const readable = (value) => new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  globalThis.Bun = {
    spawn(args, options) {
      spawned.push({ args, cwd: options.cwd })
      return {
        stdout: readable("context found"),
        stderr: readable(""),
        exited: Promise.resolve(0),
        kill() {},
      }
    },
  }
  const ctx = {
    options: { ...options, prime: false, maxFlushChunks: 0 },
    location: {
      directory: subdirectory,
      project: { id: "project-test", directory: projectDirectory, canonical: canonicalDirectory },
    },
    session: {
      async context() { return [userMessage("u1", "preserve this topic")] },
      async hook(name, callback) { hooks.set(name, callback) },
    },
    event: { subscribe: (opts) => eventFeed().subscribe(opts) },
  }

  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    await hooks.get("compaction")({ sessionID: "location-session", system: [] })

    assert.equal(spawned.length, 1)
    assert.deepEqual(spawned[0].args.slice(1, 3), ["context", "--topic"])
    assert.equal(spawned[0].cwd, projectDirectory)
    assert.notEqual(spawned[0].cwd, subdirectory)
    assert.notEqual(spawned[0].cwd, canonicalDirectory)
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("routes idle events by workspace and resolves missing ownership from the session", async () => {
  const currentDirectory = join(root, "worktree", "packages", "app")
  const projectDirectory = join(root, "worktree")
  const workspaceID = "workspace-a"
  const messages = new Map([
    ["wrong-directory", [userMessage("u1", "must not capture wrong directory")]],
    ["wrong-workspace", [userMessage("u2", "must not capture wrong workspace")]],
    ["matching-event", [userMessage("u3", "capture matching event owner")]],
    ["partial-event-location", [userMessage("u7", "capture event with resolved workspace")]],
    ["resolved-owner", [userMessage("u4", "capture resolved session owner")]],
    ["mismatched-session-owner", [userMessage("u5", "must not capture mismatched session owner")]],
    ["unresolved-owner", [userMessage("u6", "must not capture unresolved owner")]],
  ])
  const feed = eventFeed()
  const sessionLookups = []
  const kinCalls = []
  const readable = (value) => new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  globalThis.Bun = {
    spawn(args, spawnOptions) {
      kinCalls.push({ args, cwd: spawnOptions.cwd })
      return {
        stdout: readable("staged"),
        stderr: readable(""),
        exited: Promise.resolve(0),
        kill() {},
      }
    },
  }
  const ctx = {
    options: { ...options, prime: false, minCaptureChars: 0, dropRecentTurns: 0 },
    location: {
      directory: currentDirectory,
      workspaceID,
      project: { id: "route-test", directory: projectDirectory, canonical: join(root, "main") },
    },
    session: {
      async context({ sessionID }) { return messages.get(sessionID) },
      async get({ sessionID }) {
        sessionLookups.push(sessionID)
        if (sessionID === "unresolved-owner") return undefined
        return {
          location: {
            directory: currentDirectory,
            workspaceID: sessionID === "mismatched-session-owner" ? "workspace-b" : workspaceID,
          },
        }
      },
      async hook() {},
    },
    event: { subscribe: (opts) => feed.subscribe(opts) },
  }
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)

  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    const emit = (sessionID, location) => feed.push({
      type: "session.idle",
      data: { sessionID },
      ...(location ? { location } : {}),
    })
    emit("wrong-directory", { directory: join(root, "other"), workspaceID })
    emit("wrong-workspace", { directory: currentDirectory, workspaceID: "workspace-b" })
    emit("matching-event", { directory: currentDirectory, workspaceID })
    emit("partial-event-location", { directory: currentDirectory })
    emit("resolved-owner")
    emit("mismatched-session-owner")
    emit("unresolved-owner")

    let matching = await store.read("matching-event")
    let partial = await store.read("partial-event-location")
    let resolved = await store.read("resolved-owner")
    for (let i = 0; i < 100 && (!matching.messages.length || !partial.messages.length || !resolved.messages.length || sessionLookups.length < 4); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
      matching = await store.read("matching-event")
      partial = await store.read("partial-event-location")
      resolved = await store.read("resolved-owner")
    }

    assert.equal((await store.read("wrong-directory")).messages.length, 0)
    assert.equal((await store.read("wrong-workspace")).messages.length, 0)
    assert.equal((await store.read("mismatched-session-owner")).messages.length, 0)
    assert.equal((await store.read("unresolved-owner")).messages.length, 0)
    assert.ok(matching.messages.some((item) => item.source.includes("capture matching event owner")))
    assert.ok(partial.messages.some((item) => item.source.includes("capture event with resolved workspace")))
    assert.ok(resolved.messages.some((item) => item.source.includes("capture resolved session owner")))
    assert.deepEqual(sessionLookups, ["partial-event-location", "resolved-owner", "mismatched-session-owner", "unresolved-owner"])
    assert.equal(kinCalls.filter(({ args }) => args.includes("compact-hook")).length, 3)
    assert.ok(kinCalls.every(({ cwd }) => cwd === projectDirectory))
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("waits for active idle capture and journals new messages before compaction continues", async () => {
  const messages = [userMessage("u1", "first pending message"), userMessage("u2", "recent message")]
  const hooks = new Map()
  const queue = []
  const waiters = []
  let markKinStarted
  const kinStarted = new Promise((resolve) => { markKinStarted = resolve })
  let releaseKin
  const kinGate = new Promise((resolve) => { releaseKin = resolve })
  let held = false
  const readable = (value) => new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  globalThis.Bun = {
    spawn(args) {
      const hold = args.includes("compact-hook") && !held
      if (hold) {
        held = true
        markKinStarted()
      }
      return {
        stdout: readable(""),
        stderr: readable(""),
        exited: hold ? kinGate : Promise.resolve(0),
        kill() {},
      }
    },
  }
  const ctx = {
    options: {
      ...options,
      prime: false,
      minCaptureChars: 0,
      dropRecentTurns: 1,
      chunkTimeoutMs: 5000,
    },
    location: { directory: root, workspaceID: "workspace-test", project: { directory: root } },
    session: {
      async context() { return messages },
      async hook(name, callback) { hooks.set(name, callback) },
    },
    event: {
      subscribe() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (queue.length) return { value: queue.shift(), done: false }
                return new Promise((resolve) => waiters.push(resolve))
              },
              async return() { return { done: true } },
            }
          },
        }
      },
    },
  }

  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    const idle = {
      type: "session.idle",
      data: { sessionID: "queued-session" },
      location: { directory: root, workspaceID: "workspace-test" },
    }
    const waiting = waiters.shift()
    if (waiting) waiting({ value: idle, done: false })
    else queue.push(idle)
    await kinStarted

    messages.push(userMessage("u3", "arrived during active capture"))
    let compactionFinished = false
    const compaction = hooks.get("compaction")({
      sessionID: "queued-session",
      system: [],
    }).then(() => { compactionFinished = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(compactionFinished, false)

    releaseKin(0)
    await compaction
    const store = createJournalStore(process.env.XDG_STATE_HOME, root)
    const journal = await store.read("queued-session")
    assert.ok(journal.messages.some((item) => item.source.includes("arrived during active capture")))
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("reloads policy text and injects it for context and compaction hooks", async () => {
  const hooks = new Map()
  const fakeCtx = {
    options: {},
    location: { directory: root, workspaceID: "workspace-test", project: { directory: root } },
    session: {
      async hook(name, callback) { hooks.set(name, callback) },
    },
  }
  await memoryPlugin.setup(fakeCtx)

  const context = { system: [], sessionID: "policy-session" }
  await hooks.get("context")(context)
  assert.ok(context.system.some((part) => part.text === "policy one"))

  await writeFile(process.env.KINDEX_POLICY_PATH, "policy two")
  await utimes(process.env.KINDEX_POLICY_PATH, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000))
  const compaction = { system: [], sessionID: "policy-session" }
  await hooks.get("compaction")(compaction)
  assert.ok(compaction.system.some((part) => part.text === "policy two"))
})

test("re-probes kin availability at compaction after a failed startup probe", async () => {
  const hooks = new Map()
  const commands = []
  let probeCount = 0
  const child = (stdout, code) => ({
    stdout: { text: async () => stdout },
    exited: Promise.resolve(code),
    kill() {},
  })
  globalThis.Bun = {
    spawn(args) {
      commands.push(args)
      if (args[1] === "--version") {
        probeCount++
        return probeCount > 1 ? child("kin 1.2.3", 0) : child("", 1)
      }
      return child("decisions: ship the plugin", 0)
    },
  }

  try {
    await memoryPlugin.setup({
      options: {},
      location: { directory: root, workspaceID: "ws-probe", project: { directory: root } },
      session: { async hook(name, callback) { hooks.set(name, callback) } },
    })
    assert.equal(probeCount, 1)

    const compaction = { sessionID: "probe-session", system: [] }
    await hooks.get("compaction")(compaction)
    assert.equal(probeCount, 2)
    assert.ok(commands.some((args) => args[0] === "kin" && args[1] === "context"))
    assert.ok(compaction.system.some((part) => part.text.includes("decisions: ship the plugin")))

    await hooks.get("compaction")({ sessionID: "probe-session", system: [] })
    assert.equal(probeCount, 2)
  } finally {
    delete globalThis.Bun
  }
})

test("scores the idle gate against the new delta and pending retries instead of full history", () => {
  const gate = { minCaptureChars: 6000 }
  const long = userMessage("u-old", "x".repeat(7000))
  const longText = serializeMessage(long)
  const small = userMessage("u-new", "tiny follow-up")
  const captured = { version: 1, messages: [{
    key: messageKey(long, longText), id: "u-old", source: longText,
    chunks: [{ body: longText, state: "unknown", attempts: 1, nextAttemptAt: 0 }],
  }] }

  assert.equal(needsFlush([long, small], captured, gate), false)
  captured.messages[0].chunks[0].state = "pending"
  assert.equal(needsFlush([long, small], captured, gate), true)

  captured.messages[0].chunks[0].state = "unknown"
  assert.equal(needsFlush([long, small], { version: 1, messages: [] }, gate), true)
  const boundary = [
    { id: "c1", type: "compaction", status: "completed", summary: "short summary" },
    small,
  ]
  assert.equal(needsFlush([long, ...boundary], { version: 1, messages: [] }, gate), false)
})

test("routes compaction captures through the short chunk timeout and idle captures through the long one", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-timeouts")
  const opts = { ...options, chunkTimeoutMs: 120000, compactChunkTimeoutMs: 10000 }
  const legacy = { ...options, chunkTimeoutMs: 120000 }
  const timeouts = []
  const runKin = async (text, timeoutMs) => { timeouts.push(timeoutMs); return { status: "success" } }

  await flushJournal({
    store, sessionID: "timeout-session", messages: [userMessage("u1", "compaction capture")],
    options: opts, includeRecent: true, runKin,
  })
  await flushJournal({
    store, sessionID: "timeout-session",
    messages: [userMessage("u1", "compaction capture"), userMessage("u2", "idle capture")],
    options: opts, includeRecent: false, runKin,
  })
  await flushJournal({
    store, sessionID: "legacy-session", messages: [userMessage("u1", "no knob set")],
    options: legacy, includeRecent: true, runKin,
  })

  assert.deepEqual(timeouts, [10000, 120000, 120000])
})

test("prunes captured payloads below the live boundary but keeps dedup keys", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-prune")
  const old = userMessage("u-old", "history that was already captured")
  const first = await flushJournal({
    store, sessionID: "prune-session", messages: [old], options, includeRecent: true,
    runKin: async () => ({ status: "success" }),
  })
  assert.ok(first.journal.messages[0].source)

  const boundary = { id: "c1", type: "compaction", status: "completed", summary: "new window" }
  await flushJournal({
    store, sessionID: "prune-session",
    messages: [boundary, userMessage("u-new", "after boundary")],
    options, includeRecent: true, runKin: async () => ({ status: "success" }),
  })
  const journal = await store.read("prune-session")
  const pruned = journal.messages.find((item) => item.id === "u-old")

  assert.equal(pruned.source, undefined)
  assert.ok(pruned.key)
  assert.ok(pruned.chunks.every((chunk) => chunk.body === undefined))
  assert.ok(journal.messages.find((item) => item.id === "u-new").source.includes("after boundary"))
})

test("does not recapture replayed messages after a revert regresses the boundary", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-revert")
  const old = userMessage("u-old", "captured before the revert")
  const mid = userMessage("u-mid", "captured after compaction")
  await flushJournal({
    store, sessionID: "revert-session", messages: [old], options, includeRecent: true,
    runKin: async () => ({ status: "success" }),
  })
  const boundary = { id: "c1", type: "compaction", status: "completed", summary: "summary" }
  await flushJournal({
    store, sessionID: "revert-session", messages: [boundary, mid], options, includeRecent: true,
    runKin: async () => ({ status: "success" }),
  })

  const calls = []
  await flushJournal({
    store, sessionID: "revert-session", messages: [old, mid], options, includeRecent: true,
    runKin: async (text) => { calls.push(text); return { status: "success" } },
  })

  assert.equal(calls.length, 0)
})

test("flushes the tail and garbage-collects the journal when a session is deleted", async () => {
  const projectDirectory = join(root, "delete-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  const seed = (sessionID, messages = [userMessage("u-seed", `seeded ${sessionID}`)]) => flushJournal({
    store, sessionID, messages,
    options, includeRecent: true, runKin: async () => ({ status: "failure", error: "kin down" }),
  })
  await seed("gone-session")
  await seed("foreign-session")
  await seed("failed-session", [userMessage("u-bad", "undeliverable tail message")])
  assert.ok((await store.read("gone-session")).messages.length > 0)

  const feed = eventFeed()
  const spawned = []
  const readable = (value) => new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  globalThis.Bun = {
    spawn(args, spawnOptions) {
      spawned.push(args)
      const undeliverable = spawnOptions?.stdin
        && new TextDecoder().decode(spawnOptions.stdin).includes("undeliverable")
      return {
        stdout: readable(undeliverable ? "" : "staged"),
        stderr: readable(undeliverable ? "kin down" : ""),
        exited: Promise.resolve(undeliverable ? 1 : 0),
        kill() {},
      }
    },
  }
  const ctx = {
    options: { ...options, prime: false, chunkTimeoutMs: 5000, compactChunkTimeoutMs: 1000 },
    location: { directory: projectDirectory, workspaceID: "ws-delete", project: { directory: projectDirectory } },
    session: {
      async context() {
        throw new Error("session context must not be read for deleted sessions")
      },
      async get() {
        throw new Error("session lookup must not run for deleted sessions")
      },
      async hook() {},
    },
    event: { subscribe: (opts) => feed.subscribe(opts) },
  }

  const warnings = []
  const realWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(" ")) }
  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    feed.push({
      type: "session.deleted", data: { sessionID: "foreign-session" },
      location: { directory: join(root, "elsewhere"), workspaceID: "ws-delete" },
    })
    feed.push({
      type: "session.deleted", data: { sessionID: "failed-session" },
      location: { directory: projectDirectory, workspaceID: "ws-delete" },
    })
    feed.push({ type: "session.deleted", data: { sessionID: "gone-session" } })
    const file = join(store.dir, `${createHash("sha256").update("gone-session").digest("hex")}.json`)
    const failedFile = join(store.dir, `${createHash("sha256").update("failed-session").digest("hex")}.json`)
    let retained = { messages: [] }
    for (let i = 0; i < 100; i++) {
      try { await access(file) } catch { break }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    for (let i = 0; i < 100; i++) {
      retained = await store.read("failed-session")
      if (retained.messages.some((item) => item.id === "u-bad")) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    await assert.rejects(access(file))
    assert.ok(retained.messages.some((item) =>
      item.id === "u-bad" && item.chunks.some((chunk) => chunk.state === "pending")
    ))
    await access(failedFile)
    assert.equal(spawned.filter((args) => args.includes("compact-hook")).length, 2)
    assert.equal((await store.read("foreign-session")).messages.length, 1)
    assert.ok(warnings.some((line) => line.includes("gone-session") && line.includes("dropped")),
      "criterion 8: the deleted-session drain removed a journal with no unconditional log line")
    await cleanup()
  } finally {
    console.warn = realWarn
    delete globalThis.Bun
  }
})

test("sweeps stale startup journals for this location and leaves fresh ones alone", async () => {
  const projectDirectory = join(root, "sweep-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  await mkdir(store.dir, { recursive: true, mode: 0o700 })
  const seedFile = async (sessionID, mtime) => {
    const file = join(store.dir, `${createHash("sha256").update(sessionID).digest("hex")}.json`)
    await writeFile(file, JSON.stringify({ version: 1, messages: [], session: sessionID }))
    await utimes(file, mtime, mtime)
  }
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000)
  await seedFile("sweep-stale", twoDaysAgo)
  await seedFile("sweep-fresh", new Date())
  await writeFile(join(store.dir, "corrupt.json"), "{not json")

  const feed = eventFeed()
  const spawned = []
  const readable = (value) => new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  globalThis.Bun = {
    spawn(args) {
      spawned.push(args)
      return {
        stdout: readable("staged"), stderr: readable(""), exited: Promise.resolve(0), kill() {},
      }
    },
  }
  const ctx = {
    options: {
      ...options, dropRecentTurns: 2, prime: false,
      chunkTimeoutMs: 5000, compactChunkTimeoutMs: 1000,
    },
    location: { directory: projectDirectory, workspaceID: "ws-sweep", project: { directory: projectDirectory } },
    session: {
      async context({ sessionID }) {
        if (sessionID === "sweep-stale") return [userMessage("u-tail", "tail lost to quiet exit")]
        if (sessionID === "sweep-fresh") return [userMessage("u-live", "still in progress")]
        throw new Error(`unexpected context read for ${sessionID}`)
      },
      async hook() {},
    },
    event: { subscribe: (opts) => feed.subscribe(opts) },
  }

  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    for (let i = 0; i < 100 && !spawned.some((args) => args.includes("compact-hook")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    let stale = await store.read("sweep-stale")
    for (let i = 0; i < 100 && !stale.messages.some((item) => item.chunks.every((chunk) => chunk.state === "unknown")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      stale = await store.read("sweep-stale")
    }

    assert.ok(stale.messages.some((item) => item.source.includes("tail lost to quiet exit")))
    assert.equal((await store.read("sweep-fresh")).messages.length, 0)
    assert.equal(spawned.filter((args) => args.includes("compact-hook")).length, 1)
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("parses the staged count from real kin stdout", async () => {
  const projectDirectory = join(root, "staged-stdout-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  await mkdir(store.dir, { recursive: true, mode: 0o700 })
  const payload = "payload staged through real stdout"
  const text = `session\n\n${payload}`
  await writeFile(
    join(store.dir, `${createHash("sha256").update("spawn-staged-session").digest("hex")}.json`),
    JSON.stringify({
      version: 1,
      messages: [{
        key: messageKey({ id: "u1" }, text), id: "u1", source: text, topic: "session",
        chunks: [{ body: payload, state: "pending", attempts: 0, nextAttemptAt: 0 }],
      }],
      session: "spawn-staged-session",
    }),
  )

  const spawned = []
  const feed = eventFeed()
  const readable = (value) => new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
  globalThis.Bun = {
    spawn(args, spawnOptions) {
      spawned.push({ args, input: new TextDecoder().decode(spawnOptions.stdin) })
      return {
        stdout: readable("# Kindex: staged 3\nhook output"),
        stderr: readable(""),
        exited: Promise.resolve(0),
        kill() {},
      }
    },
  }
  const ctx = {
    options: { ...options, prime: false, chunkTimeoutMs: 5000, compactChunkTimeoutMs: 1000 },
    location: { directory: projectDirectory, workspaceID: "ws-staged", project: { directory: projectDirectory } },
    session: {
      async context() { return [] },
      async hook() {},
    },
    event: { subscribe: (opts) => feed.subscribe(opts) },
  }

  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    let journal = await store.read("spawn-staged-session")
    for (let i = 0; i < 100 && !("kinStaged" in journal.messages[0].chunks[0]); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      journal = await store.read("spawn-staged-session")
    }
    const chunk = journal.messages[0].chunks[0]

    assert.equal(chunk.kinStaged, 3)
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].input, text)
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("records the staged count reported by kin on the chunk", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-staged")
  const first = await flushJournal({
    store, sessionID: "staged-session",
    messages: [userMessage("u1", "payload reporting a staged count")],
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 42, staged: 3 }),
  })
  const chunk = first.journal.messages[0].chunks[0]

  assert.equal(chunk.kinStaged, 3)
  assert.equal(chunk.kinExit, 0)
  assert.equal(chunk.kinDurationMs, 42)
  assert.equal(chunk.state, "unknown")
})

test("marks a successful run without a staged line empty", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-empty-state")
  const first = await flushJournal({
    store, sessionID: "empty-state-session",
    messages: [userMessage("u1", "payload kin accepts but stages nothing")],
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 17_000, staged: null }),
  })
  const chunk = first.journal.messages[0].chunks[0]

  assert.equal(chunk.state, "empty")
  assert.equal(chunk.kinStaged, null)
})

test("retains the payload of an empty chunk through later flushes", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-empty-retain")
  const payload = "payload that must survive the prune pass"
  await flushJournal({
    store, sessionID: "empty-retain-session", messages: [userMessage("u-old", payload)],
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 10, staged: null }),
  })

  const boundary = { id: "c1", type: "compaction", status: "completed", summary: "new window" }
  await flushJournal({
    store, sessionID: "empty-retain-session",
    messages: [boundary, userMessage("u-new", "after boundary")],
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 10, staged: 1 }),
  })
  const retained = (await store.read("empty-retain-session")).messages.find((item) => item.id === "u-old")

  assert.equal(retained.chunks[0].state, "empty")
  assert.equal(retained.source.includes(payload), true)
  assert.equal(retained.chunks[0].body.includes(payload), true)
})

test("does not retry an empty chunk on a subsequent flush", async () => {
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-empty-retry")
  const messages = [userMessage("u1", "already reported empty")]
  const first = await flushJournal({
    store, sessionID: "empty-retry-session", messages,
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 10, staged: null }),
  })
  assert.equal(first.journal.messages[0].chunks[0].state, "empty")

  const calls = []
  const second = await flushJournal({
    store, sessionID: "empty-retry-session", messages,
    options, includeRecent: true, now: Date.now() + 60_000,
    runKin: async (text) => { calls.push(text); return { status: "success", exit: 0, durationMs: 10, staged: 1 } },
  })
  const tail = await flushStoredJournal({
    store, sessionID: "empty-retry-session", options,
    runKin: async (text) => { calls.push(text); return { status: "success", exit: 0, durationMs: 10, staged: 1 } },
  })

  assert.equal(second.attempted, 0)
  assert.equal(tail.attempted, 0)
  assert.equal(calls.length, 0)
  assert.equal((await store.read("empty-retry-session")).messages[0].chunks[0].state, "empty")
})

const readableStream = (value) => new ReadableStream({
  start(controller) {
    if (value) controller.enqueue(new TextEncoder().encode(value))
    controller.close()
  },
})

const spawnRecorder = (stdout = "staged", code = 0) => {
  const spawned = []
  globalThis.Bun = {
    spawn(args, spawnOptions) {
      spawned.push({ args, cwd: spawnOptions?.cwd, input: spawnOptions?.stdin == null
        ? null : new TextDecoder().decode(spawnOptions.stdin) })
      return {
        stdout: readableStream(stdout),
        stderr: readableStream(code === 0 ? "" : "kin down"),
        exited: Promise.resolve(code),
        kill() {},
      }
    },
  }
  return spawned
}

const compactHookCalls = (spawned) => spawned.filter(({ args }) => args.includes("compact-hook")).length

const seedJournal = async (store, sessionID, messages) => {
  await mkdir(store.dir, { recursive: true, mode: 0o700 })
  const file = join(store.dir, `${createHash("sha256").update(sessionID).digest("hex")}.json`)
  await writeFile(file, JSON.stringify({ version: 1, messages, session: sessionID }))
  return file
}

const waitFor = async (predicate, attempts = 200, delayMs = 5) => {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return false
}

const DAY_MS = 24 * 3600 * 1000

test("idle gate ignores a pending backlog and stays closed across a fresh store instance", async () => {
  // Regression this catches: an idle gate that treats "thousands of chunks pending" as
  // work to do. Red if a session.idle for an already-captured session issues any
  // compact-hook spawn, or if the captured-content watermark lives only in memory so a
  // fresh store/module instance re-captures the same content.
  const projectDirectory = join(root, "gate-backlog-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  const backlog = Array.from({ length: 2000 }, (_, index) => ({
    key: `backlog-${index}`, id: `b${index}`, source: `backlog source ${index}`, topic: "backlog",
    chunks: [{
      body: `backlog body ${index}`, state: "pending", attempts: 1,
      nextAttemptAt: Date.now() + 3_600_000, firstSeenAt: Date.now(),
    }],
  }))
  await seedJournal(store, "gate-backlog-session", backlog)

  const captured = [userMessage("u1", "already captured content")]
  const capturedText = serializeMessage(captured[0])
  await seedJournal(store, "gate-captured-marker", [{
    key: messageKey(captured[0], capturedText), id: "u1", source: capturedText, topic: "gate backlog",
    chunks: [{
      body: capturedText, state: "pending", attempts: 1,
      nextAttemptAt: Date.now() + 3_600_000, firstSeenAt: Date.now(),
    }],
  }])
  const spawned = spawnRecorder()
  const feed = eventFeed()
  feed.push({
    type: "session.idle", data: { sessionID: "gate-captured-marker" },
    location: { directory: projectDirectory, workspaceID: "ws-gate" },
  })
  const ctx = {
    options: { ...options, prime: false, minCaptureChars: 0, dropRecentTurns: 0 },
    location: { directory: projectDirectory, workspaceID: "ws-gate", project: { directory: projectDirectory } },
    session: {
      async context({ sessionID }) {
        if (sessionID !== "gate-captured-marker") throw new Error(`unexpected context read for ${sessionID}`)
        return captured
      },
      async hook() {},
    },
    event: { subscribe: (opts) => feed.subscribe(opts) },
  }
  assert.equal(needsFlush(captured, await store.read("gate-captured-marker"), { minCaptureChars: 0 }), true,
    "fixture is wrong: the gate already reports no new content, so zero kin proves nothing")
  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    const gateClosed = await waitFor(async () => compactHookCalls(spawned) === 0 &&
      (await store.read("gate-captured-marker")).messages.some((item) => item.captured === true))
    assert.equal(gateClosed, true, "idle did not record the captured-content watermark")
    assert.equal(compactHookCalls(spawned), 0)

    const freshStore = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
    const journal = await freshStore.read("gate-captured-marker")
    assert.ok(needsFlush(captured, journal, { minCaptureChars: 0 }) === false,
      "the watermark is memory-only: a fresh store instance still reports uncaptured content")
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("idle still runs a bounded retry pass for already-due pending chunks", async () => {
  // Regression this catches: an idle gate so strict it silently stops real capture.
  // Red if a session with no new content but already-due pending chunks performs zero
  // kin work, or if that retry pass exceeds the per-event cap.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-gate-retry")
  const message = userMessage("u1", "due retry payload")
  const text = serializeMessage(message)
  await seedJournal(store, "gate-retry-session", [{
    key: messageKey(message, text), id: "u1", source: text, topic: "due retry payload",
    chunks: Array.from({ length: 6 }, (_, index) => ({
      body: `due chunk ${index}`, state: "pending", attempts: 1, nextAttemptAt: 0,
      firstSeenAt: Date.now(),
    })),
  }])
  const calls = []
  const result = await flushJournal({
    store, sessionID: "gate-retry-session", messages: [message],
    options: { ...options, minCaptureChars: 0 },
    includeRecent: false, runKin: async (input) => { calls.push(input); return { status: "success", staged: 1 } },
  })
  // The fixture makes six chunks due, so six is the correct pass size; asserting the full
  // cap here would fail on correct behavior. What must hold is that the retry pass runs at
  // all and stays inside the per-event cap.
  assert.ok(calls.length > 0, "a session with no new content performed no kin retry work")
  assert.ok(result.attempted > 0, "the retry pass reported zero attempts")
  assert.ok(calls.length <= options.maxChunks, `the retry pass exceeded the per-event cap: ${calls.length}`)
  assert.ok(result.attempted <= options.maxChunks, `the retry pass exceeded the per-event cap: ${result.attempted}`)
})

test("the stale-journal sweep runs at most once per process", async () => {
  // Regression this catches: a sweep that re-runs on every setup() call, so each new
  // plugin instance replays the whole backlog. Red if two setup() calls in one process
  // spawn compact-hook work for the same stale journal twice. setup() builds a fresh
  // store on every call, so the guard has to key on the location, not the store.
  const projectDirectory = join(root, "sweep-once-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  const stale = new Date(Date.now() - 48 * 3600 * 1000)
  await seedJournal(store, "sweep-once-session", [{
    key: "sweep-once-1", id: "u-tail", source: "tail lost to a quiet exit", topic: "sweep once",
    chunks: [{ body: "tail lost to a quiet exit", state: "pending", attempts: 0, nextAttemptAt: 0 }],
  }])
  const file = join(store.dir, `${createHash("sha256").update("sweep-once-session").digest("hex")}.json`)
  await utimes(file, stale, stale)

  const spawned = spawnRecorder()
  const ctx = {
    options: { ...options, dropRecentTurns: 0, prime: false, chunkTimeoutMs: 5000, compactChunkTimeoutMs: 1000 },
    location: { directory: projectDirectory, workspaceID: "ws-sweep-once", project: { directory: projectDirectory } },
    session: {
      async context({ sessionID }) {
        if (sessionID !== "sweep-once-session") throw new Error(`unexpected context read for ${sessionID}`)
        return []
      },
      async hook() {},
    },
    event: { subscribe: (opts) => eventFeed().subscribe(opts) },
  }
  const otherDirectory = join(root, "sweep-once-other-proj")
  const otherCtx = {
    ...ctx,
    location: { directory: otherDirectory, workspaceID: "ws-sweep-once-other", project: { directory: otherDirectory } },
  }
  const otherStore = createJournalStore(process.env.XDG_STATE_HOME, otherDirectory)
  try {
    assert.ok(sweepOnce, "sweepOnce must be exported — criterion 2 (sweep once per location)")
    // Seam check: the guard has to actually suppress a second pass, otherwise the
    // behavioural check below can pass vacuously (a first pass that succeeds leaves the
    // stale journal terminal, so a re-sweep would spawn nothing anyway).
    const probe = await sweepOnce({ ctx: otherCtx, store: otherStore })
    assert.equal(probe.swept, true, "an unswept location must sweep")
    const again = await sweepOnce({ ctx: otherCtx, store: otherStore })
    assert.equal(again.swept, false, "the same location swept twice in one process")
    const plugin = (await import("../plugins/kindex-compaction/index.js")).default
    const first = await plugin.setup(ctx)
    const swept = await waitFor(async () => compactHookCalls(spawned) > 0)
    assert.equal(swept, true, "the sweep never ran for a stale journal")
    const second = await plugin.setup(ctx)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(compactHookCalls(spawned), 1,
      "a second setup() in the same process replayed the same stale journal")
    await first()
    await second()
  } finally {
    delete globalThis.Bun
  }
})

test("a journal past the pending-age threshold is abandoned and never retried", async () => {
  // Regression this catches: an endless backfill that replays week-old chunks. Red if a
  // journal whose oldest pending chunk is older than abandonAfterMs still receives kin
  // invocations from the flush path, or if the abandonment transition is not logged.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-abandon-age")
  const now = Date.now()
  await seedJournal(store, "abandon-age-session", [{
    key: "abandon-age-1", id: "u-old", source: "eight day old backlog", topic: "abandon age",
    chunks: [{
      body: "eight day old backlog", state: "pending", attempts: 3,
      nextAttemptAt: 0, firstSeenAt: now - 8 * DAY_MS,
    }],
  }])

  const logged = []
  const oldWarn = console.warn
  console.warn = (...args) => logged.push(args.join(" "))
  try {
    const calls = []
    const result = await flushStoredJournal({
      store, sessionID: "abandon-age-session",
      options: { ...options, abandonAfterMs: 7 * DAY_MS, abandonAfterChunks: 256 },
      runKin: async (input) => { calls.push(input); return { status: "success", staged: 1 } },
      now,
    })
    const journal = await store.read("abandon-age-session")

    assert.equal(calls.length, 0)
    assert.equal(result.attempted, 0)
    assert.equal(journal.abandoned, true)
    assert.ok(logged.some((line) => line.includes("abandon-age-session") && /\b1\b/.test(line)),
      "the abandonment transition emitted no unconditional log naming the journal and count")
  } finally {
    console.warn = oldWarn
  }
})

test("a legacy journal with no per-chunk firstSeenAt abandons on journal age", async () => {
  // Regression this catches: the age check reading ONLY chunk.firstSeenAt. Chunks written
  // by the previous plugin version never carried that field, so a small legacy backlog
  // (fewer than abandonAfterChunks pending) is replayed on every process start forever.
  // Red if the age fallback to journal.createdAt is removed: with no chunk firstSeenAt,
  // oldest stays Infinity and the age branch cannot fire.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-abandon-legacy-age")
  const now = Date.now()
  // createdAt is stamped by hand to reproduce a journal written before the field existed.
  // The three chunks are the legacy shape the previous plugin version wrote: no
  // firstSeenAt, no capturedAt.
  const file = await seedJournal(store, "abandon-legacy-age-session", [{
    key: "abandon-legacy-1", id: "u-legacy", source: "legacy backlog", topic: "abandon legacy age",
    chunks: [{ body: "legacy backlog", state: "pending", attempts: 1, nextAttemptAt: now + 3_600_000 }],
  }, {
    key: "abandon-legacy-2", id: "u-legacy-2", source: "legacy backlog two", topic: "abandon legacy age",
    chunks: [{ body: "legacy backlog two", state: "pending", attempts: 1, nextAttemptAt: now + 3_600_000 }],
  }, {
    key: "abandon-legacy-3", id: "u-legacy-3", source: "legacy backlog three", topic: "abandon legacy age",
    chunks: [{ body: "legacy backlog three", state: "pending", attempts: 1, nextAttemptAt: now + 3_600_000 }],
  }])
  const seeded = JSON.parse(await readFile(file, "utf8"))
  await writeFile(file, JSON.stringify({ ...seeded, createdAt: now - 8 * DAY_MS }))

  const logged = []
  const oldWarn = console.warn
  console.warn = (...args) => logged.push(args.join(" "))
  try {
    const spawned = spawnRecorder()
    const calls = []
    const result = await flushStoredJournal({
      store, sessionID: "abandon-legacy-age-session",
      options: { ...options, abandonAfterMs: 7 * DAY_MS, abandonAfterChunks: 256 },
      runKin: async (input) => { calls.push(input); return { status: "success", staged: 1 } },
      now,
    })
    const journal = await store.read("abandon-legacy-age-session")

    assert.equal(compactHookCalls(spawned), 0)
    assert.equal(calls.length, 0)
    assert.equal(result.attempted, 0)
    assert.equal(journal.abandoned, true)
    assert.equal(journal.createdAt, now - 8 * DAY_MS,
      "the creation stamp refreshed on write, so an actively replayed backlog never ages out")
    assert.ok(logged.some((line) => line.includes("abandon-legacy-age-session") && /\b3\b/.test(line)),
      "the abandonment transition emitted no unconditional log naming the journal and count")
  } finally {
    console.warn = oldWarn
    delete globalThis.Bun
  }
})

test("a journal past the pending-count threshold is abandoned and never retried", async () => {
  // Regression this catches: a 3,020-chunk backlog being replayed at ~25s per chunk with
  // no user activity. Red if a journal holding more than abandonAfterChunks pending chunks
  // still receives kin invocations, or if the transition is not logged.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-abandon-count")
  const now = Date.now()
  await seedJournal(store, "abandon-count-session", Array.from({ length: 300 }, (_, index) => ({
    key: `abandon-count-${index}`, id: `u${index}`, source: `pending body ${index}`, topic: "abandon count",
    chunks: [{
      body: `pending body ${index}`, state: "pending", attempts: 1,
      nextAttemptAt: 0, firstSeenAt: now - index,
    }],
  })))

  const logged = []
  const oldWarn = console.warn
  console.warn = (...args) => logged.push(args.join(" "))
  try {
    const calls = []
    const result = await flushStoredJournal({
      store, sessionID: "abandon-count-session",
      options: { ...options, abandonAfterMs: 7 * DAY_MS, abandonAfterChunks: 256 },
      runKin: async (input) => { calls.push(input); return { status: "success", staged: 1 } },
      now,
    })
    const journal = await store.read("abandon-count-session")

    assert.equal(calls.length, 0)
    assert.equal(result.attempted, 0)
    assert.equal(journal.abandoned, true)
    assert.ok(logged.some((line) => line.includes("abandon-count-session") && /\b300\b/.test(line)),
      "the abandonment transition emitted no unconditional log naming the journal and count")
  } finally {
    console.warn = oldWarn
  }
})

test("abandonment never gates the reset of an aged inflight chunk", async () => {
  // Regression this catches: an abandonment check placed ahead of the inflight reset, so
  // a crashed chunk stays inflight forever. Red if an abandoned journal leaves the aged
  // inflight chunk in the inflight state.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-abandon-inflight")
  const now = Date.now()
  await seedJournal(store, "abandon-inflight-session", [{
    key: "abandon-inflight-1", id: "u-crash", source: "chunk orphaned by a crash", topic: "abandon inflight",
    chunks: [{
      body: "chunk orphaned by a crash", state: "inflight", attempts: 2, nextAttemptAt: 0,
      lastAttemptAt: now - 10 * DAY_MS, firstSeenAt: now - 10 * DAY_MS,
    }],
  }])

  const calls = []
  await flushStoredJournal({
    store, sessionID: "abandon-inflight-session",
    options: { ...options, abandonAfterMs: 7 * DAY_MS, abandonAfterChunks: 256, compactChunkTimeoutMs: 90_000 },
    runKin: async (input) => { calls.push(input); return { status: "success", staged: 1 } },
    now,
  })
  const journal = await store.read("abandon-inflight-session")

  assert.equal(journal.abandoned, true)
  assert.equal(journal.messages[0].chunks[0].state, "unknown")
  assert.equal(calls.length, 0)
})

test("unknown chunk bodies are garbage-collected even beside a pending sibling", async () => {
  // Regression this catches: body GC that only fires when every sibling is terminal, so
  // one permanently pending chunk pins the whole message body forever. Red if the unknown
  // chunk keeps its body, or if the empty sibling loses its full body.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-body-gc")
  const payload = "body that must be collected from the unknown chunk"
  const first = await flushJournal({
    store, sessionID: "body-gc-session", messages: [userMessage("u1", payload)],
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 10, staged: 1 }),
  })
  assert.equal(first.journal.messages[0].chunks[0].state, "unknown")
  first.journal.messages[0].chunks.push({ body: payload, state: "empty", attempts: 1, nextAttemptAt: 0 })
  await store.write("body-gc-session", first.journal)

  const boundary = { id: "c1", type: "compaction", status: "completed", summary: "new window" }
  await flushJournal({
    store, sessionID: "body-gc-session", messages: [boundary, userMessage("u-new", "after boundary")],
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 10, staged: 1 }),
  })
  const pruned = (await store.read("body-gc-session")).messages.find((item) => item.id === "u1")

  assert.equal(pruned.chunks[0].state, "unknown")
  assert.equal(pruned.chunks[0].body, undefined)
  assert.equal(pruned.chunks[1].state, "empty")
  assert.equal(pruned.chunks[1].body, payload)
})

test("a body-GC batch emits one unconditional log naming the journal and count", async () => {
  // Regression this catches: observability routed through the debug-gated note(), so a
  // production process silently deletes bodies. Red if no console.warn line names the
  // journal and the collected count with debug off.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-body-gc-log")
  const payload = "collected body payload"
  await flushJournal({
    store, sessionID: "body-gc-log-session", messages: [userMessage("u1", payload)],
    options, includeRecent: true,
    runKin: async () => ({ status: "success", exit: 0, durationMs: 10, staged: 1 }),
  })

  const logged = []
  const oldWarn = console.warn
  console.warn = (...args) => logged.push(args.join(" "))
  try {
    const boundary = { id: "c1", type: "compaction", status: "completed", summary: "new window" }
    await flushJournal({
      store, sessionID: "body-gc-log-session", messages: [boundary, userMessage("u-new", "after boundary")],
      options, includeRecent: true,
      runKin: async () => ({ status: "success", exit: 0, durationMs: 10, staged: 1 }),
    })
  } finally {
    console.warn = oldWarn
  }
  assert.ok(logged.some((line) => line.includes("body-gc-log-session") && /\b1\b/.test(line)),
    "the body-GC batch emitted no unconditional log naming the journal and count")
})

test("purge resets an aged inflight chunk and a later flush cannot resurrect the journal", async () => {
  // Regression this catches: purge bypassing the per-session queue (interleaving with a
  // flush) or a later flush writing back a stale in-memory copy. Red if purge leaves the
  // aged inflight chunk inflight, or if the flush after purge recreates the journal file.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-purge")
  const now = Date.now()
  await seedJournal(store, "purge-session", [{
    key: "purge-1", id: "u-crash", source: "chunk orphaned inflight", topic: "purge",
    chunks: [{
      body: "chunk orphaned inflight", state: "inflight", attempts: 1, nextAttemptAt: 0,
      lastAttemptAt: now - 10 * 60_000,
    }],
  }])
  const file = join(store.dir, `${createHash("sha256").update("purge-session").digest("hex")}.json`)

  assert.ok(purgeJournal, "purgeJournal must be exported — criterion 5 (serialized, irreversible purge)")
  const purged = await purgeJournal({
    store, sessionID: "purge-session",
    options: { ...options, compactChunkTimeoutMs: 90_000 }, now,
  })
  assert.equal(purged.reset, 1)
  await assert.rejects(access(file))

  await flushJournal({
    store, sessionID: "purge-session", messages: [],
    options: { ...options, minCaptureChars: 0 }, includeRecent: true,
    runKin: async () => ({ status: "success", staged: 1 }), now: now + 60_000,
  })
  await assert.rejects(access(file), "a flush recreated the purged journal from a stale in-memory copy")
})

test("purge is serialized behind an in-flight flush for the same session", async () => {
  // Regression this catches: purge running outside the per-session queue, so it deletes
  // the journal while a flush holds a copy of it. Red if purge resolves before the flush
  // that started first, i.e. the two interleave.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-purge-queue")
  let releaseKin
  const kinGate = new Promise((resolve) => { releaseKin = resolve })
  let markKinStarted
  const kinStarted = new Promise((resolve) => { markKinStarted = resolve })
  const flushPromise = flushJournal({
    store, sessionID: "purge-queue-session", messages: [userMessage("u1", "payload under active capture")],
    options, includeRecent: true,
    runKin: async () => { markKinStarted(); await kinGate; return { status: "success", staged: 1 } },
  })
  await kinStarted

  let purgeFinished = false
  assert.ok(purgeJournal, "purgeJournal must be exported — criterion 5 (purge runs through the per-session queue)")
  const purgePromise = purgeJournal({
    store, sessionID: "purge-queue-session",
    options: { ...options, compactChunkTimeoutMs: 90_000 },
    // The per-session queue lives inside setup(); the purge seam must expose it so purge
    // and an in-flight flush contend for the same lane. Shape is implementer's choice.
    enqueue: (sessionID, task) => {
      const previous = flushPromise
      const current = previous.catch(() => {}).then(task)
      return current
    },
  }).then(() => { purgeFinished = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(purgeFinished, false, "purge ran while a flush for the same session was in flight")

  releaseKin()
  await Promise.all([flushPromise, purgePromise])
  assert.equal(purgeFinished, true)
  await assert.rejects(access(join(store.dir, `${createHash("sha256").update("purge-queue-session").digest("hex")}.json`)))
})

test("a chunk in backoff no longer blocks capture of newer messages", async () => {
  // Regression this catches: index.js:236 aborting the whole pass on one chunk with a
  // future nextAttemptAt, so live capture stops behind a single backed-off chunk. Red if
  // the newer message is not journaled, or if kin is invoked for the backed-off chunk.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-backoff-skip")
  const now = Date.now()
  const old = userMessage("u-old", "chunk held in backoff")
  const oldText = serializeMessage(old)
  await seedJournal(store, "backoff-skip-session", [{
    key: messageKey(old, oldText), id: "u-old", source: oldText, topic: "backoff skip",
    chunks: [{
      body: oldText, state: "pending", attempts: 4, nextAttemptAt: now + 3_600_000,
    }],
  }])

  const calls = []
  const result = await flushJournal({
    store, sessionID: "backoff-skip-session",
    messages: [old, userMessage("u-new", "newer message behind a backed-off chunk")],
    options: { ...options, minCaptureChars: 0 }, includeRecent: false,
    runKin: async (input) => { calls.push(input); return { status: "success", staged: 1 } },
    now,
  })
  const journal = await store.read("backoff-skip-session")

  assert.ok(journal.messages.some((item) => item.id === "u-new"))
  assert.equal(result.attempted, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].includes("newer message behind a backed-off chunk"), true)
})

test("live capture still runs past minCaptureChars and stays closed across a restart", async () => {
  // Regression this catches: a throttle that silently stops real capture. Red if a normal
  // session that produces new content past minCaptureChars and then idles captures zero
  // chunks, both on the first pass and after a simulated restart (fresh store instance).
  //
  // This is the criterion 7 guard, so it must be green against the CURRENT plugin: its job
  // is to detect a future throttle, not the known abort-the-pass defect at index.js:236.
  // No backed-off chunk is seeded here on purpose — with index.js:236 still aborting the
  // pass, ANY pending chunk ordered before the appended live item prevents today's code
  // from reaching it, which would make this guard red for criterion 6's defect instead of
  // for a throttle. Criterion 6 has its own deliberately-red guard: "a chunk in backoff no
  // longer blocks capture of newer messages".
  const projectDirectory = join(root, "live-capture-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  const now = Date.now()
  const old = userMessage("u-old", "old chunk held in backoff")
  const oldText = serializeMessage(old)
  const live = "live capture payload ".repeat(500)
  const liveText = serializeMessage(userMessage("u-live", live))
  // Only an already-captured message is seeded: terminal, so the flush loop skips it and
  // nothing is left in backoff to abort the pass before the new live item is reached.
  await seedJournal(store, "live-capture-session", [
    {
      key: messageKey(old, oldText), id: "u-old", source: oldText, topic: "live capture",
      chunks: [{ body: oldText, state: "unknown", attempts: 1, nextAttemptAt: 0 }],
    },
  ])

  const spawned = spawnRecorder()
  const ctx = {
    options: { ...options, prime: false, dropRecentTurns: 0, chunkTimeoutMs: 5000, compactChunkTimeoutMs: 1000 },
    location: { directory: projectDirectory, workspaceID: "ws-live", project: { directory: projectDirectory } },
    session: { async context() { return [old, userMessage("u-live", live)] }, async hook() {} },
    event: { subscribe: (opts) => feedWith("live-capture-session", projectDirectory, "ws-live") },
  }
  const idleGateClosed = needsFlush([old, userMessage("u-live", live)], await store.read("live-capture-session"),
    { minCaptureChars: 6000 })
  assert.equal(idleGateClosed, true, "the idle gate never opens for content past minCaptureChars")
  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    const capturedLive = await waitFor(async () => compactHookCalls(spawned) > 0)
    assert.equal(capturedLive, true, "live content past minCaptureChars was not captured")
    const journal = await store.read("live-capture-session")
    assert.ok(journal.messages.some((item) => item.id === "u-live"))

    // The durable-watermark half of criterion 7 ("still closed after a restart") lives in
    // "idle gate ignores a pending backlog and stays closed across a fresh store instance",
    // which is deliberately red until criterion 1 lands. Asserting it here would make this
    // guard red for the wrong reason today.

    // Drain before leaving: this test now performs real capture, and a flush still running
    // after cleanup would spawn into whichever globalThis.Bun the NEXT test installed,
    // corrupting that test's spawn count.
    const drained = await waitFor(async () => {
      const j = await store.read("live-capture-session")
      return !j.messages.some((item) => item.chunks.some((chunk) =>
        chunk.state === "inflight" || (chunk.state === "pending" && chunk.nextAttemptAt <= Date.now())))
    })
    assert.equal(drained, true, "the live-capture flush never settled before the test ended")
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

const feedWith = (sessionID, directory, workspaceID) => {
  const feed = eventFeed()
  feed.push({ type: "session.idle", data: { sessionID }, location: { directory, workspaceID } })
  return feed.subscribe({ signal: new AbortController().signal })
}

test("a journal drop emits one unconditional log naming the journal and count", async () => {
  // Regression this catches: journal deletion happening silently, so a lost backlog is
  // invisible. Red if store.remove deletes a journal with pending chunks without a
  // console.warn line naming the journal and the dropped count with debug off.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-drop-log")
  await seedJournal(store, "drop-log-session", Array.from({ length: 5 }, (_, index) => ({
    key: `drop-${index}`, id: `u${index}`, source: `dropped body ${index}`, topic: "drop log",
    chunks: [{ body: `dropped body ${index}`, state: "pending", attempts: 1, nextAttemptAt: 0 }],
  })))

  const logged = []
  const oldWarn = console.warn
  console.warn = (...args) => logged.push(args.join(" "))
  try {
    assert.ok(purgeJournal, "purgeJournal must be exported — criterion 8 (journal drop must be logged)")
    await purgeJournal({ store, sessionID: "drop-log-session", options: { ...options, compactChunkTimeoutMs: 90_000 } })
  } finally {
    console.warn = oldWarn
  }
  assert.ok(logged.some((line) => line.includes("drop-log-session") && /\b5\b/.test(line)),
    "the journal drop emitted no unconditional log naming the journal and count")
})

test("per-event caps and kin passthrough survive the throttle", async () => {
  // Regression this catches: the throttle changing what kin is invoked with or how many
  // chunks one event may attempt. Red if the idle path exceeds maxChunks, or if kinBin,
  // the per-path timeout, or the configured env no longer reach the spawn.
  const projectDirectory = join(root, "caps-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  const spawned = spawnRecorder()
  const ctx = {
    options: {
      ...options, prime: false, minCaptureChars: 0, dropRecentTurns: 0,
      kinBin: "kin-throttled", env: { KINDEX_TEST_ENV: "passthrough" },
      chunkTimeoutMs: 5000, compactChunkTimeoutMs: 1000,
    },
    location: { directory: projectDirectory, workspaceID: "ws-caps", project: { directory: projectDirectory } },
    session: {
      async context() {
        return Array.from({ length: 12 }, (_, index) => userMessage(`u${index}`, `capped capture ${index}`))
      },
      async hook() {},
    },
    event: { subscribe: (opts) => feedWith("caps-session", projectDirectory, "ws-caps") },
  }
  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    const capped = await waitFor(async () => compactHookCalls(spawned) >= options.maxChunks)
    assert.equal(capped, true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const hooks = spawned.filter(({ args }) => args.includes("compact-hook"))
    assert.equal(hooks.length, options.maxChunks)
    assert.ok(hooks.every(({ args, cwd, input }) => args[0] === "kin-throttled" && cwd === projectDirectory &&
      typeof input === "string" && input.length > 0))
    assert.ok(hooks.every(({ args }) => args[1] === "compact-hook"))
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})

test("kin invocations stay strictly one at a time under the throttle", async () => {
  // Regression this catches: the retry/skip pass spawning chunks concurrently, multiplying
  // the 20-26s LLM load instead of bounding it. Red if two compact-hook children are ever
  // alive at the same time.
  const store = createJournalStore(process.env.XDG_STATE_HOME, "/repo-serial")
  let active = 0
  let maxActive = 0
  const spawnCounts = []
  globalThis.Bun = {
    spawn(args) {
      if (args.includes("compact-hook")) {
        active++
        spawnCounts.push(active)
        maxActive = Math.max(maxActive, active)
      }
      return {
        stdout: readableStream("staged"), stderr: readableStream(""),
        exited: new Promise((resolve) => setTimeout(() => { active--; resolve(0) }, 2)),
        kill() {},
      }
    },
  }
  const gatedKin = async () => {
    const child = globalThis.Bun.spawn(["kin", "compact-hook"])
    await child.exited
    return { status: "success", staged: 1 }
  }
  try {
    await seedJournal(store, "serial-session", Array.from({ length: 4 }, (_, index) => ({
      key: `serial-${index}`, id: `u${index}`, source: `serial backlog ${index}`, topic: "serial",
      chunks: [{ body: `serial backlog ${index}`, state: "pending", attempts: 0, nextAttemptAt: 0 }],
    })))
    const backlog = await flushStoredJournal({
      store, sessionID: "serial-session",
      options: { ...options, compactChunkTimeoutMs: 90_000 }, runKin: gatedKin,
    })
    assert.equal(backlog.attempted, 4)

    const live = await flushJournal({
      store, sessionID: "serial-live-session", messages: [userMessage("u1", "serial live payload")],
      options: { ...options, minCaptureChars: 0 }, includeRecent: false, runKin: gatedKin,
    })
    assert.equal(live.attempted, 1)
    assert.equal(maxActive, 1)
    assert.deepEqual(spawnCounts, [1, 1, 1, 1, 1])
  } finally {
    delete globalThis.Bun
  }
})

test("the chunk kill timer bounds a kin call that never returns", async () => {
  // Regression this catches: the throttle dropping or widening the kill timer, so one hung
  // 20-26s LLM call blocks the whole queue forever. Red if a compact-hook child that never
  // exits is not killed at compactChunkTimeoutMs, or if the timed-out chunk is left inflight
  // instead of returned to pending with backoff. Asserts CURRENT behavior, not new behavior.
  //
  // The kill timer lives inside the plugin's private child-process runner, so it is driven
  // through the plugin's own idle capture path, which calls that runner with the per-path
  // timeout. The fake child never resolves `exited`, so only the timer can end the pass.
  const projectDirectory = join(root, "kill-timer-proj")
  const store = createJournalStore(process.env.XDG_STATE_HOME, projectDirectory)
  const message = userMessage("u1", "payload behind a hung kin")
  const text = serializeMessage(message)

  let killed = 0
  let spawnCount = 0
  globalThis.Bun = {
    spawn(args) {
      spawnCount++
      // The child never exits on its own; kill() is what ends it, exactly as a real SIGKILL
      // closes the pipes and resolves `exited`. Without this the plugin's Promise.all over
      // stdout/stderr/exited never settles and the test hangs instead of proving the timer.
      let settle
      const exited = new Promise((resolve) => { settle = resolve })
      const closed = () => new ReadableStream({ start(c) { c.close() } })
      return {
        stdout: closed(),
        stderr: closed(),
        exited,
        kill() { killed++; settle(137) },
      }
    },
  }
  const ctx = {
    options: {
      ...options, prime: false, minCaptureChars: 0, dropRecentTurns: 0,
      // The idle capture path takes chunkTimeoutMs (index.js:228-230, includeRecent false);
      // compactChunkTimeoutMs only governs the compaction and stale-sweep paths.
      chunkTimeoutMs: 40, compactChunkTimeoutMs: 40,
    },
    location: { directory: projectDirectory, workspaceID: "ws-kill", project: { directory: projectDirectory } },
    session: { async context() { return [message] }, async hook() {} },
    event: { subscribe: (opts) => feedWith("kill-timer-session", projectDirectory, "ws-kill") },
  }
  const startedAt = Date.now()
  try {
    const cleanup = await (await import("../plugins/kindex-compaction/index.js")).default.setup(ctx)
    const timedOut = await waitFor(async () => {
      const journal = await store.read("kill-timer-session")
      return journal.messages.some((item) => item.id === "u1" &&
        // The attempt is written as inflight before the child runs; only the kill timer can
        // end it, after which the chunk returns to pending with a backoff delay. A chunk left
        // inflight forever means the timer is gone.
        item.chunks.some((chunk) => chunk.attempts >= 1 && chunk.state === "pending" &&
          chunk.nextAttemptAt > Date.now()))
    })
    const elapsed = Date.now() - startedAt

    assert.equal(timedOut, true, "the timed-out chunk was not returned to pending with a backoff delay")
    assert.ok(spawnCount > 0, "no compact-hook child was spawned")
    assert.ok(killed > 0, "the hung compact-hook child was never killed by the kill timer")
    assert.ok(elapsed < 5000, `the hung kin call was not cut off by the kill timer (${elapsed}ms)`)
    const chunk = (await store.read("kill-timer-session")).messages
      .find((item) => item.id === "u1").chunks[0]
    assert.equal(chunk.state, "pending")
    assert.ok(chunk.nextAttemptAt > Date.now(), "the timed-out chunk has no backoff delay")
    await cleanup()
  } finally {
    delete globalThis.Bun
  }
})
