---
name: OpenAPI Zod compatibility
description: Compatibility note for generated Zod schemas in this workspace.
---

Use Zod 4 with the current Orval generator when the API contract contains integer schemas.

**Why:** The generator emits `zod.int()` for OpenAPI integer values, which is not available in Zod 3 and causes generated-library typechecking to fail.

**How to apply:** If code generation fails on `zod.int`, update the shared Zod catalog/runtime rather than editing generated files.