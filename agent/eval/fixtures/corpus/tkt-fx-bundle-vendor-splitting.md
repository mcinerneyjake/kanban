---
title: "Split vendor code into a separately cached chunk"
type: task
priority: medium
status: backlog
order: 152
created: '2026-05-03T13:00:00.000Z'
updated: '2026-05-04T13:00:00.000Z'
project: eval-fixture
---

Application and dependency code are bundled together, so every deploy invalidates the whole download even when no dependency changed. Vendor code should be emitted as its own long-cached chunk so a routine release is a small download.
