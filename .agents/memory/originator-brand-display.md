---
name: Originator brand display
description: How to choose and render PBS originator labels alongside ingredient names.
---

Use the PBS listing whose `innovator_indicator` is true as the originator brand for drug-level labels. Do not substitute `originator_brand_indicator`, which describes a different PBS relationship.

**Why:** The product’s originator identity must remain stable even when the currently visible or predicted listing is a generic.

**How to apply:** Return a nullable originator brand with drug-level and item-level reference responses, then render it as `Drug name (Brand)` only when present and not already included.