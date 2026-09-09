---
title: "Paginate the search results endpoint with cursor tokens"
type: feature
priority: high
status: todo
order: 104
created: '2026-05-01T13:00:00.000Z'
updated: '2026-05-02T13:00:00.000Z'
project: eval-fixture
---

The search endpoint serializes every match into one response, so a broad query returns tens of megabytes and the client stalls. Results should come back a page at a time behind an opaque cursor token that encodes the sort position, so paging stays stable while records are being written.
