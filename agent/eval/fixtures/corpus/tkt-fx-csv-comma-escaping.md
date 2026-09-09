---
title: "Escape embedded commas and quotes in exported CSV fields"
type: bug
priority: high
status: todo
order: 123
created: '2026-05-02T08:00:00.000Z'
updated: '2026-05-03T08:00:00.000Z'
project: eval-fixture
---

Field values containing a comma, a quote or a newline are written raw, so a single free-text note shifts every later column and the file will not open cleanly. Values need proper quoting and doubling of embedded quotes, verified against fields that contain all three.
