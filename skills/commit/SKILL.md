---
name: commit
description: Commit staged or selected work with house message conventions. Use whenever the user asks to commit, checkpoint, or save work to git.
allowed-tools: Read, Bash, Glob, Grep
---

# Commit

**Arguments:** `$ARGUMENTS`

Commit work with house message conventions.

Workflow:

1. Run `git status` and `git diff` before staging; review what is about to go in.
2. Stage deliberately — name files; never `git add .` or `git add -A` blindly.
3. Never commit secrets, credentials, `.env` files, or build artifacts.
4. Subject line: imperative mood, ~50-72 chars, matches the repo's existing
   history style (check `git log --oneline -5` if unsure).
5. Body: include what and why when the diff is not self-explanatory.
6. Never add `Co-Authored-By` or any trailer lines.
7. Never amend, force-push, or rebase as part of a commit; rebase and merge
   belong to the rebase and merge skills.
8. Report the resulting commit SHA and subject line when done.
