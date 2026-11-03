import assert from "node:assert/strict"
import { mkdir, stat, utimes, writeFile } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
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

const [{ serializeMessage, createJournalStore, flushJournal }, { default: memoryPlugin }] = await Promise.all([
  import("../plugins/kindex-compaction/index.js"),
  import("../plugins/kindex-memory/index.js"),
])

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
