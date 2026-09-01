---
name: Deployment startup database termination
description: Publish attempts can build successfully but fail during autoscale promotion when API startup database work loses its PostgreSQL session.
---

An autoscale publish can pass package installation, artifact builds, and image creation, then fail readiness if database initialization runs before the API opens its port. An unreachable database may wait silently until the platform terminates the process, while a transient database restart may surface SQLSTATE `57P01`.

**Why:** Autoscale readiness needs a prompt liveness response. Coupling it to database maintenance turns connectivity delays into deployment failures and may produce no application exception before SIGTERM.

**How to apply:** Open the HTTP port and expose an unauthenticated liveness route before database maintenance. Run idempotent initialization asynchronously, use finite connection timeouts, log failures, and retry without weakening TLS.