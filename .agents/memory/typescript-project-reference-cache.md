---
name: TypeScript project reference cache
description: Resolving stale declarations after changing a shared workspace package export.
---

When an application package cannot see a newly exported symbol from a referenced shared TypeScript package, force a project-reference rebuild before changing the source API.

**Why:** Incremental declarations can remain stale even when the shared package source and its ordinary build succeed, making a valid export appear missing to a consumer package.

**How to apply:** Run TypeScript build mode with `--force` for the consumer's project graph, then rerun its no-emit typecheck. Treat that as a cache issue only after confirming the source and declaration export barrels contain the symbol.