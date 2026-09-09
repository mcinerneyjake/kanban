---
title: "Rate-limit the search endpoint per API key"
type: task
priority: medium
status: backlog
order: 107
created: '2026-05-01T16:00:00.000Z'
updated: '2026-05-02T16:00:00.000Z'
project: eval-fixture
---

One misbehaving integration polling search in a tight loop can saturate the query pool and slow every other tenant. The endpoint needs a per-key rate limit with a clear 429 and a retry-after header, plus a higher documented ceiling for interactive traffic.
