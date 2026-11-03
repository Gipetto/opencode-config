import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { Plugin } from "@opencode/plugin"

// ---------------------------------------------------------------- tunables

const POLICY_PATH =
  process.env.KINDEX_POLICY_PATH ||
  join(homedir(), ".config", "opencode", "kindex-policy.md")

const MAX_ORIENTATION_CHARS = 4000
const KIN_TIMEOUT_MS = 5000

// ----------------------------------------------------------------- policy

let policyCache = { mtimeMs: -1, text: "" }

function getPolicy() {
  try {
    const { mtimeMs } = statSync(POLICY_PATH)
    if (mtimeMs !== policyCache.mtimeMs) {
      policyCache = { mtimeMs, text: readFileSync(POLICY_PATH, "utf8").trim() }
    }
  } catch {
    policyCache = { mtimeMs: -1, text: "" }
  }
  return policyCache.text
}

// ---------------------------------------------------------------- helpers

async function safeRun(command, cwd, timeoutMs) {
  let process
  let timer
  try {
    process = Bun.spawn(command, {
      cwd,
      env: { ...globalThis.process.env },
      stdout: "pipe",
      stderr: "ignore",
    })
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => {
        process.kill()
        resolve("")
      }, timeoutMs)
    })
    const output = process.stdout.text()
    const result = await Promise.race([
      process.exited.then((code) => code === 0 ? output : ""),
      timedOut,
    ])
    return result
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

function truncate(text, max) {
  const trimmed = (text || "").trim()
  if (!trimmed) return ""
  return trimmed.length <= max
    ? trimmed
    : trimmed.slice(0, max) + "\n\n[...truncated]"
}

export default Plugin.define({
  id: "kindex-memory",
  async setup(ctx) {
    const cwd = ctx.location.project?.directory || ctx.location.directory
    const probe = await safeRun(["kin", "--version"], cwd, KIN_TIMEOUT_MS)
    const kinAvailable = Boolean(probe.trim())

    await ctx.session.hook("context", async (event) => {
      try {
        const policy = getPolicy()
        if (!policy) return
        event.system.push({ type: "text", text: policy })
      } catch {
      }
    })

    await ctx.session.hook("compaction", async (event) => {
      try {
        const policy = getPolicy()
        if (policy) event.system.push({ type: "text", text: policy })

        if (!kinAvailable) return

        const orientation = truncate(
          await safeRun(["kin", "context"], cwd, KIN_TIMEOUT_MS),
          MAX_ORIENTATION_CHARS,
        )

        if (orientation) {
          event.system.push({
            type: "text",
            text: "## Kindex orientation (regenerated at compaction)\n\n" + orientation,
          })
        }
      } catch {
      }
    })
  },
})
