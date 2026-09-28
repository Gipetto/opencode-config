---
name: worktree
description: Create or switch to git worktrees with Worktrunk (`wt`) for isolated implementation work. Use whenever the user asks for a worktree.
allowed-tools: Bash
---

# Worktree With Worktrunk

Tasks: $ARGUMENTS

Use `wt` for worktree operations.
**HARD REQUIREMENT** Use a worktree only when the current codebase explicitly
requires it or when the user requests the use of a worktree.

## Create A Worktree

Determine the repository's main checkout, branch name, and base branch from the
request and repository context. Prefer an explicitly supplied base. When the
stored preference applies, refresh the remote integration branch from the main
checkout and base the new worktree on it.

```bash
git -C <main-checkout> fetch origin <integration-branch>
wt -C <main-checkout> switch --create <branch> --base origin/<integration-branch> --no-cd
```

If the user explicitly wants to branch from the currently checked-out branch:

```bash
wt -C <checkout> switch --create <branch> --base @ --no-cd
```

Use `--no-cd` in agent-run commands because changing a child shell directory
does not change later tool calls. After creation, use the new worktree path as
the `workdir` for requested implementation work.

## Existing Worktrees

```bash
wt -C <checkout> list
wt -C <checkout> switch <branch> --no-cd
```

Use `wt remove` and `wt merge` for cleanup and integration.
