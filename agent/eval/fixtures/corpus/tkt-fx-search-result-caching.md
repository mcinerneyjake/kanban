---
title: "Cache repeated search queries for a short window"
type: task
priority: medium
status: backlog
order: 105
created: '2026-05-01T14:00:00.000Z'
updated: '2026-05-02T14:00:00.000Z'
project: eval-fixture
---

Identical searches re-run the full query against the store every time, and dashboards that poll make this the hottest path we have. Results for an identical query and filter set should be cached briefly, with the cache keyed so that a permission change cannot serve one user another user’s hits.
