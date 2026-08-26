---
name: Same-strength PBS listings
description: Why PBS items that share strength, pack, program, schedule, and price must sometimes remain separate listings.
---

Do not deduplicate PBS items solely because they share a brand, strength, pack size, program, schedule, formulary, and price. Separate PBS codes can represent different benefit listings.

**Why:** Verified rosuvastatin pairs differ by benefit type, maximum quantity, maximum prescribable packs, substitution group, and first-listed date even when their visible medicine and price fields match. Prescriber indicators and schedule may remain identical.

**How to apply:** Preserve each PBS code and LI item identity in ingestion and counts. If the UI needs to explain apparent duplicates, expose benefit/listing metadata in the item detail rather than collapsing rows.