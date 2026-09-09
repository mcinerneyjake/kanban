---
title: "Collapse duplicate error alerts into a single notification"
type: bug
priority: high
status: todo
order: 116
created: '2026-05-02T01:00:00.000Z'
updated: '2026-05-03T01:00:00.000Z'
project: eval-fixture
---

A single failing dependency produces one alert per request, so an incident buries the on-call channel in thousands of identical messages and the useful signal is lost. Alerts sharing a fingerprint should collapse into one notification carrying an occurrence count and a first-seen time, updating in place rather than repeating.
