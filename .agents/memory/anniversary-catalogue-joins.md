---
name: Anniversary catalogue joins
description: Reliability and cardinality constraints when resolving anniversary workbook rows to the PBS catalogue.
---

Normalize and join anniversary rows using legal-instrument drug, legal-instrument form, and brand. Treat the result as a product-concept match and retain every matching PBS item code rather than forcing one code.

**Why:** In the August 2026 public PBS catalogue, all 73 current anniversary rows matched those three fields exactly after basic punctuation and case normalization, and all resolved to one branded product concept. However, most rows had multiple PBS codes for that same concept because program and benefit variants reuse the same medicine/form/brand identity.

**How to apply:** For prediction verification, mark a prediction as linked when its item code belongs to the row's candidate-code set. Do not persist a one-to-one workbook-row-to-item-code mapping unless another source field supplies the missing program or benefit discriminator.