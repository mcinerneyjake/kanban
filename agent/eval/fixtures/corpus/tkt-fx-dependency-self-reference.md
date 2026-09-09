---
title: "Reject a task that depends on itself"
type: bug
priority: medium
status: todo
order: 158
created: '2026-05-03T19:00:00.000Z'
updated: '2026-05-04T19:00:00.000Z'
project: eval-fixture
---

A task can be saved with itself as its own predecessor, which is the degenerate one-node cycle and leaves the task permanently un-runnable. The validator should reject a self-reference at write time with a clear message.
