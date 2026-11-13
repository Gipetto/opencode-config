import { execFile } from "node:child_process"
import { access, readdir } from "node:fs/promises"
import { basename, dirname, join, resolve as resolvePath } from "node:path"
import { promisify } from "node:util"

import { Plugin, Worktree } from "@opencode/plugin"

const run = promisify(execFile)
const git = (args, cwd, signal) => run("git", args, { cwd, signal })
const exists = async (path) => {
  try { await access(path); return true } catch { return false }
}
const operationError = (message) =>
  Worktree?.OperationError ? new Worktree.OperationError({ message }) : new Error(message)
const commonDir = (dir, signal) =>
  git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir, signal)
    .then(({ stdout }) => resolvePath(stdout.trim()), () => null)

const siblingStrategy = {
  id: "sibling",
  async create({ sourceDirectory, directory, branch }, { signal }) {
    const name = basename(directory)
    const target = join(dirname(sourceDirectory), `${basename(sourceDirectory)}.${name}`)
    if (await exists(target)) {
      throw operationError(`Sibling worktree already exists: ${target}`)
    }
    if (branch) {
      const known = await git(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], sourceDirectory, signal,
      ).then(() => true, () => false)
      await git(
        known ? ["worktree", "add", "--", target, branch]
          : ["worktree", "add", "-b", branch, "--", target],
        sourceDirectory, signal,
      )
    } else {
      await git(["worktree", "add", "--detach", "--", target, "HEAD"], sourceDirectory, signal)
    }
    return { directory: target }
  },
  async remove({ directory, force }, { signal }) {
    const common = await commonDir(directory, signal)
    if (!common) throw operationError(`Not a git worktree: ${directory}`)
    const root = dirname(common)
    await git(
      ["worktree", "remove", ...(force ? ["--force"] : []), "--", directory], root, signal,
    )
    await git(["worktree", "prune"], root, signal).catch(() => {})
  },
  async list(sourceDirectory, { signal }) {
    const sourceCommon = await commonDir(sourceDirectory, signal)
    if (!sourceCommon) return []
    const parent = dirname(sourceDirectory)
    const prefix = `${basename(sourceDirectory)}.`
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
    const owned = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
      const directory = join(parent, entry.name)
      const common = await commonDir(directory, signal)
      if (common === sourceCommon) owned.push({ directory, type: "worktree" })
    }
    return owned
  },
}

export default Plugin.define({
  id: "worktree-sibling",
  async setup(ctx) {
    if (!ctx.worktree?.transform) {
      console.error("worktree-sibling: server exposes no worktree strategy API; plugin inactive")
      return
    }
    await ctx.worktree.transform((editor) => {
      editor.add(siblingStrategy)
    })
  },
})
