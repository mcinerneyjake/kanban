---
title: "Email the CSV export when it is ready"
type: feature
priority: medium
status: backlog
order: 122
created: '2026-05-02T07:00:00.000Z'
updated: '2026-05-03T07:00:00.000Z'
project: eval-fixture
---

Large exports run long enough that the browser gives up waiting, so people retry and queue several copies of the same job. The export should run in the background and email a time-limited download link when it finishes.
