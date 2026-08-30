---
name: PBS API pagination
description: Confirmed request and pagination contract for the Department of Health PBS v3 API.
---

The PBS v3 `items` endpoint accepts `page` and `limit` query parameters. It returns page metadata in `_meta` and pagination links as objects in `_links`, including a relative `/api/v3/...` next URL.

**Why:** The API rejects the common `pageSize` parameter, and resolving its relative next URL against the API base without preserving the `/pbs` prefix targets the wrong path.

**How to apply:** Use `limit`, inspect `_links` entries with `rel: "next"`, and resolve `/api/v3/...` links against `https://data-api.health.gov.au/pbs`. Validate every returned continuation URL remains HTTPS on `data-api.health.gov.au` under `/pbs/api/v3/` before sending the subscription-key header; test fixtures must use that same base path.