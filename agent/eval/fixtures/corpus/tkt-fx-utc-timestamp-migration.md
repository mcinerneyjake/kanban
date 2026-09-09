---
title: "Store timestamps in UTC and keep the original timezone"
type: task
priority: high
status: todo
order: 124
created: '2026-05-02T09:00:00.000Z'
updated: '2026-05-03T09:00:00.000Z'
project: eval-fixture
---

Timestamps are written in whatever local zone the writing process happened to run in, so ordering across regions is wrong and a comparison can put a later event first. Every stored instant should be normalized to UTC with the original zone retained alongside it, and the migration must be backfilled rather than applied only to new rows.
