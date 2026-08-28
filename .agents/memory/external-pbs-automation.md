---
name: External PBS automation
description: The scheduled PBS ingestion trigger is designed to be called through the published API rather than a separate scheduled deployment.
---

The external PBS scheduler must call the published Autoscale API; the workspace development URL is not a stable destination for third-party cron services.

**Why:** The ingestion runner shares the API's database lock and audit trail, while the API deployment is the intended long-lived service.

**How to apply:** Keep the endpoint token-protected and provide the production URL only after checking deployment metadata. If no deployment exists, publish the API before configuring the external cron caller.