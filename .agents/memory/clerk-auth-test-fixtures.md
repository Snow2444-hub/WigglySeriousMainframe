---
name: Clerk auth test fixtures
description: How Express tests can exercise the real Clerk requireAuth and requireAdmin middleware without network authentication.
---

Express tests can provide a branded `req.auth` function that returns a Clerk auth object with `userId` and `tokenType: "session_token"`; the brand is `Symbol.for("@clerk/express.auth")`.

**Why:** Clerk `getAuth` rejects an unbranded request as missing middleware, and its default accepted-token filter treats a fake object without `session_token` as signed out.

**How to apply:** Install the branded request auth before mounting production routes, seed the local user row with the desired role, and assert responses through the real middleware rather than replacing `requireAdmin`.