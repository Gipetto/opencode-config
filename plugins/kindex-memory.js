// Injects the Kindex policy into the system prompt on every request and
// into every compaction summary, so it cannot be summarized away.
// Optionally appends a fresh `kin context` snapshot at compaction when
// the kin CLI is present.
//
// Advisory only: every hook swallows its own errors. Nothing here is
// allowed to break a session, a prompt, or a compaction.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** @typedef {import('@opencode-ai/plugin').Plugin} Plugin */

// ---------------------------------------------------------------- tunables

const POLICY_PATH =
  process.env.KINDEX_POLICY_PATH ||
  join(homedir(), ".config", "opencode", "kindex-policy.md")

const MAX_ORIENTATION_CHARS = 4000
const KIN_TIMEOUT_MS = 5000

// ----------------------------------------------------------------- policy

let policyCache = { mtimeMs: -1, text: "" }

/**
 * Read the policy, re-reading only when the file's mtime changes.
 * Lets you edit the markdown without restarting OpenCode.
 * @returns {string} policy text, or "" if the file is missing/unreadable
 */
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

/**
 * Run a shell command with a hard timeout. Never throws, never hangs.
 * @returns {Promise<string>} stdout, or "" on any failure
 */
async function safeRun(run, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      run(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(""), timeoutMs)
      }),
    ])
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

/** @returns {string} */
function truncate(text, max) {
  const trimmed = (text || "").trim()
  if (!trimmed) return ""
  return trimmed.length <= max
    ? trimmed
    : trimmed.slice(0, max) + "\n\n[...truncated]"
}

// ----------------------------------------------------------------- plugin

/** @type {Plugin} */
export const KindexMemory = async ({ $, directory, worktree }) => {
  const cwd = worktree || directory

  // Probe once at load. Gates ONLY the `kin context` shell-out below —
  // policy injection does not depend on the CLI, since the policy drives
  // the MCP server.
  const probe = await safeRun(
    () => $`kin --version`.cwd(cwd).nothrow().quiet().text(),
    KIN_TIMEOUT_MS,
  )
  const kinAvailable = Boolean(probe && probe.trim())

  const bytes = getPolicy().length
  console.log(
    `[kindex-memory] policy: ${
      bytes ? `${bytes}B from ${POLICY_PATH}` : `NOT FOUND at ${POLICY_PATH}`
    } | kin CLI: ${kinAvailable ? "available" : "not found"}`,
  )

  return {
    // Fires on every chat request. File read is mtime-cached, so this is
    // a stat() per request. No shelling out here.
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const policy = getPolicy()
        if (!policy) return
        if (Array.isArray(output?.system)) output.system.push(policy)
      } catch {
        // advisory: never break prompt assembly
      }
    },

    // Fires before the continuation summary is generated. Without this,
    // the policy gets compacted away.
    "experimental.session.compacting": async (_input, output) => {
      try {
        if (!Array.isArray(output?.context)) return

        const policy = getPolicy()
        if (policy) output.context.push(policy)

        if (!kinAvailable) return

        const orientation = truncate(
          await safeRun(
            () => $`kin context`.cwd(cwd).nothrow().quiet().text(),
            KIN_TIMEOUT_MS,
          ),
          MAX_ORIENTATION_CHARS,
        )

        if (orientation) {
          output.context.push(
            "## Kindex orientation (regenerated at compaction)\n\n" +
              orientation,
          )
        }
      } catch {
        // advisory: never break compaction
      }
    },
  }
}
