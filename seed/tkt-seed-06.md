---
title: Rate-limit the public API
type: feature
priority: urgent
status: todo
order: 2
created: 2026-06-21T15:45:00.000Z
updated: 2026-06-21T15:45:00.000Z
---

## Description
The public `/api/v1` endpoints have no rate limiting. A single misbehaving client
took the service to 90% CPU last week. Add a token-bucket limiter keyed by API key.

## Acceptance
- Default 100 req/min per key; configurable per plan tier.
- `429` with `Retry-After` when exceeded.
