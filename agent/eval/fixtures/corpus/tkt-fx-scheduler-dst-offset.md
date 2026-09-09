---
title: "Fix the daylight-saving offset in the recurring scheduler"
type: bug
priority: high
status: todo
order: 127
created: '2026-05-02T12:00:00.000Z'
updated: '2026-05-03T12:00:00.000Z'
project: eval-fixture
---

Recurring jobs are scheduled by adding a fixed number of hours, so on the two days a year the offset changes every job fires an hour early or late. Recurrence should be computed against a named timezone, and the twice-yearly transition needs an explicit test rather than being trusted.
