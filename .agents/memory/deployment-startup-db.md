---
name: Deployment startup database termination
description: Publish attempts can build successfully but fail during autoscale promotion when API startup database work loses its PostgreSQL session.
---

An autoscale publish can pass package installation, both artifact builds, and image creation, then fail its readiness phase if the API performs database initialization before `listen()` and PostgreSQL terminates that session with SQLSTATE `57P01` (admin shutdown).

**Why:** The API startup sequence currently performs several database mutations and recalculations before exposing its health route, so a transient production database restart becomes a startup-probe failure rather than a recoverable request-time error.

**How to apply:** Classify this as a promote/startup failure rather than a build failure. Confirm the last successful build remains live and `/api/healthz` returns 200 before changing application code; retry transient failures, and only harden startup ordering if the database termination repeats.