---
title: "Route reporting queries to a read replica"
type: feature
priority: medium
status: backlog
order: 111
created: '2026-05-01T20:00:00.000Z'
updated: '2026-05-02T20:00:00.000Z'
project: eval-fixture
---

Long analytical queries run against the primary database and hold locks that stall writes during business hours. Reporting traffic should be routed to a replica, with the tolerated replication lag documented so callers know when a number can be slightly stale.
