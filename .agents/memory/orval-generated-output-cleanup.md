---
name: Orval generated-output cleanup
description: Why API generation explicitly removes and normalizes generated trees around Orval.
---

Always explicitly remove the generated client and Zod output trees before running Orval, then normalize trailing newlines after generation.

**Why:** Orval’s built-in `clean` option left stale declarations in a shared schema file after an inline enum moved between schemas, producing duplicate exports even though the OpenAPI contract contained only one current property definition.

**How to apply:** Keep the API specification package’s pre-clean and post-generation normalization steps in the code-generation command. Do not replace them with Orval’s `clean` option alone.