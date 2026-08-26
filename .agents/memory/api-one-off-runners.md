---
name: API one-off runners
description: How to execute temporary TypeScript maintenance code against the bundled API workspace.
---

Temporary API maintenance runners must bundle local workspace libraries with the API server’s esbuild configuration, including the Pino worker plugin. Do not externalize `@workspace/db`.

**Why:** Running source through an unavailable `tsx` binary failed, and externalizing the workspace database package made Node ESM follow an extensionless source-directory import that it cannot resolve.

**How to apply:** Use the API package’s existing esbuild dependency and mirror its Node ESM banner and Pino plugin. When building from stdin with plugin-generated worker entries, use an output directory and execute the generated stdin entry.