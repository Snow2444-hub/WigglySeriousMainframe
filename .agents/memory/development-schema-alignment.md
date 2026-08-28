---
name: Development schema alignment
description: Keeping the local development database aligned with checked-in Drizzle schema changes
---

When a database-backed test exercises newly added columns, rebuild shared type declarations and push the checked-in schema to the development database before diagnosing application code.

**Why:** The development database can lag behind the schema source, producing misleading missing-column errors even when the application and generated declarations are correct.

**How to apply:** Run the shared-library typecheck, then the database package’s development push command, before rerunning the API typecheck and tests.