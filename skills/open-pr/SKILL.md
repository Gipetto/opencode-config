---
name: open-pr
description: Write a PR description using conversation context and open PR creation in browser.
disable-model-invocation: true
allowed-tools: Read, Bash, Glob, Grep
---

<!-- This is a starting point. Customize the template and guidelines to match your team's PR conventions. -->

## Gather context

1. Get the base branch (usually `main` or `master`)
2. Get the diff: `git diff <base>...HEAD`
3. Get commit messages: `git log <base>...HEAD --format="%s"`
4. Read changed files to understand the broader context
5. Check for ACCEPTANCE.md at the repo root (also accept `acceptance/*.md`)

## Commit uncommitted changes

1. Run `git status` to check for uncommitted changes
2. Never stage or commit ACCEPTANCE.md (or `acceptance/*.md`) — it is a working artifact
3. If changes exist, commit them before proceeding

## Write PR description

Use this template:

```markdown
## Summary

[1-2 sentences: what this PR does and why]

## Changes

- [Key change 1]
- [Key change 2]
- [Key change 3]

## Testing

[How you verified it works]
```

Guidelines:

- Lead with a concise summary of what the PR does
- Explain the "why" before the "how"
- The PR body follows the pr-description-what-why skill — explicit What and Why sections.
- Use the conversation context to inform the description
- Include before/after comparisons for UI or performance changes
- If ACCEPTANCE.md exists at the repo root (or `acceptance/*.md`), paste its content verbatim into a `## Acceptance criteria` section of the PR description
- Be direct and to the point

## Create the PR

1. Write a short PR title (max 72 characters)

2. Ensure the branch is pushed:
   ```bash
   git push -u origin HEAD
   ```

3. Open PR creation in browser (do NOT create directly):
   ```bash
   gh pr create --web --title "<title>" --body "<body>"
   ```

4. Delete ACCEPTANCE.md (and `acceptance/*.md`) only after the PR is successfully opened
