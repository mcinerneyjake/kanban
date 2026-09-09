---
title: "Allow a task to depend on more than one predecessor"
type: feature
priority: medium
status: backlog
order: 146
created: '2026-05-03T07:00:00.000Z'
updated: '2026-05-04T07:00:00.000Z'
project: eval-fixture
---

A task can record only a single predecessor, so work that genuinely waits on several inputs is modelled by inventing placeholder tasks. Dependencies should be a set, and a task should become ready only once every predecessor is complete.
