---
title: "Auto-schedule task dates from their dependencies"
type: feature
priority: low
status: backlog
order: 147
created: '2026-05-03T08:00:00.000Z'
updated: '2026-05-04T08:00:00.000Z'
project: eval-fixture
---

Start and due dates are entered by hand and immediately contradict the dependency order, showing a task starting before the work it waits on has finished. Dates should be derived from the graph and durations, with manual overrides marked so they are not silently recomputed.
