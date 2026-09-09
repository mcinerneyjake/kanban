---
title: "Add a column picker to the CSV export"
type: feature
priority: low
status: backlog
order: 121
created: '2026-05-02T06:00:00.000Z'
updated: '2026-05-03T06:00:00.000Z'
project: eval-fixture
---

The CSV export always emits every column, so people delete most of them by hand before using the file. The export should accept a chosen column set and remember the last selection, keeping a documented default for scripted callers.
