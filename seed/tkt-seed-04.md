---
title: Dashboard charts lag past 10k rows
type: bug
priority: high
status: backlog
order: 5
created: 2026-06-20T13:00:00.000Z
updated: 2026-06-20T13:00:00.000Z
---

## Description
The analytics dashboard becomes unresponsive once a tenant has more than ~10k
rows in the time-series. Main-thread blocks for 2–3s on every filter change.

## Notes
- Profiler points at re-aggregating the full series on each render.
- Options: memoize aggregation, downsample for the chart, or move binning server-side.
