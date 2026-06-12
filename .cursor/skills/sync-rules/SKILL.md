---
name: sync-rules
description: >-
  Sync CLAUDE.md to .cursor/rules/*.mdc files. Use when the user
  asks to sync rules, update cursor rules, or after editing CLAUDE.md.
disable-model-invocation: true
---

# Sync Rules

Generate `.cursor/rules/*.mdc` from `CLAUDE.md` (the single source of truth for project rules).

## Usage

Run the generator script:

```bash
node .cursor/skills/sync-rules/scripts/generate.mjs
```

## After Running

1. List `.cursor/rules/` to confirm the generated files
2. Report the sync result to the user (files created/updated/removed)
