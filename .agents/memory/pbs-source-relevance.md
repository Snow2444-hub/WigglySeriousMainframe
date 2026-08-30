---
name: PBS source relevance
description: How source health distinguishes out-of-scope published rows from local catalogue coverage gaps.
---

The local PBS item catalogue is intentionally watchlist-scoped even though ingestion reads the full schedule snapshot. A fetched, nonempty workbook with zero local matches is parse-healthy.

**Why:** Published source files can contain only drugs outside the enabled watchlist. Their absence from the local catalogue is expected, while unmatched rows that do correspond to the watchlist indicate a real catalogue coverage gap.

**How to apply:** Use tracked/watchlist-unmatched evidence to distinguish a visible coverage-gap state from a no-relevant-rows state. Never use local match count alone as parser health, and never label tracked unmatched rows as benign.