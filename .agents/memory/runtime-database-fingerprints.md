---
name: Runtime database fingerprints
description: How to distinguish displayed database secrets from the effective database used by a published or workspace process.
---

Runtime-managed database variables may override or differ from the value shown in the Secrets UI. Treat a URL displayed in the editor as configuration metadata, not proof of the effective target.

**Why:** A production incident showed that the workspace process and the published process reached different database endpoints even though both exposed the same runtime-managed variable names. Repairing the wrong endpoint would not restore the application data path.

**How to apply:** Log or query only a sanitized hostname/database/user fingerprint from inside the exact running process, then check connectivity, role presence, and representative row counts on that same target before changing roles or connection configuration.