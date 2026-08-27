---
name: Brand visibility preferences
description: Per-pharmacy PBS brand visibility is a display-only preference, scoped to the Clerk account.
---

Brand visibility choices must be stored per Clerk user/account and matched by both drug and normalized brand identity. Hiding a brand is a read-time display filter only; it must never restrict PBS ingestion, source retention, pricing calculations, or alert detection.

**Why:** A pharmacy may only want to see brands it stocks, while the shared PBS reference dataset must remain complete and auditable for every user.

**How to apply:** Use the active PBS ingestion watchlist only to populate the selectable settings catalogue. Keep a visible hidden-listing count and a one-click show-all control wherever a display filter can affect what the user sees.