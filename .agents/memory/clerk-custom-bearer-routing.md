---
name: Clerk and custom bearer routes
description: Custom bearer-token endpoints must be mounted before global Clerk middleware.
---

Mount machine-to-machine routes that authenticate their own `Authorization: Bearer` token before global Clerk middleware.

**Why:** Clerk interprets non-Clerk bearer values as session tokens and can return `401` before the custom route executes, making downstream token diagnostics disappear.

**How to apply:** Isolate each custom bearer endpoint in a narrowly scoped pre-Clerk router. Keep all ordinary application routes behind Clerk, and test through the full Express app rather than the router alone.