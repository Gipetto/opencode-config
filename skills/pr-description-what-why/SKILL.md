---
name: pr-description-what-why
description: "Create or revise pull request descriptions with explicit What and Why sections. Use whenever drafting, creating, or editing a PR body; do not use for work that will not produce a PR."
---

# PR Description: What and Why

Use this skill whenever authoring or changing a pull request description.

The body must contain these non-empty sections:

```markdown
## What

Describe the change and its observable scope.

## Why

Describe the problem, motivation, or constraint that makes the change necessary.
```

Make both sections specific to the change. Do not use placeholders or restate the same sentence in both sections. Preserve useful existing PR content outside these sections.

Before reporting a PR-description operation complete, read the live body and verify that both headings and their content are present.

Use plain language to describe the changes, but don't obscure any necessary detail behind simplified language. Use plain language, then expand on the idea with more technical details if necessary.
