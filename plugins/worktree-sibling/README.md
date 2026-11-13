# worktree-sibling

Registers a global OpenCode worktree strategy that places every OpenCode-created
worktree next to the main checkout, named `<project>.<topic>`
(for example `~/Projects/quizstreak.issue-817`), matching the Worktrunk sibling
convention. Without it, OpenCode stores session worktrees in its data
directory (`~/.local/share/opencode/worktree/<project-id>/`), which trips
`external_directory` permission prompts and hides work from plain `ls`.

Sibling directories matching `<project>.*` that share the checkout's git common
directory are reported back on refresh, so OpenCode inventory and cleanup keep
working. `worktree.directory` in the global config stays as a fallback for when
this plugin is disabled.
