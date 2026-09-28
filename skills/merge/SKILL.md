---
name: merge
description: Finish worktree work by committing, rebasing, merging, and cleaning up with Worktrunk (`wt`).
allowed-tools: Read, Bash, Glob, Grep
---

# Merge With Worktrunk

**Arguments:** `$ARGUMENTS`

Use `wt merge` for worktree integration.

Map supported flags:

- `--keep`, `-k`: pass `--no-remove` to keep the worktree after merging.
- `--no-verify`, `-n`: pass `--no-hooks`, Worktrunk's hook-skipping option.
- `--no-squash`: pass through when the user explicitly wants commit history preserved.

After removing recognized flags, treat a remaining argument as the optional
target branch. Without a target, Worktrunk uses the repository default branch.

Before merging, inspect the worktree status and diff so the result is
understood. Then run:

```bash
wt merge [<target>] [--no-remove] [--no-hooks] [--no-squash]
```

By default, `wt merge` stages changes, creates a squashed result, rebases onto
the target when needed, fast-forwards the target, and removes the worktree and
branch after success.

If conflicts occur, inspect the target branch changes in each conflicting file
and preserve both intended changes when resolving them.
