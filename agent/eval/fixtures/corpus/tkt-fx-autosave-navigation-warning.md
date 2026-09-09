---
title: "Warn before navigating away with unsaved changes"
type: task
priority: low
status: backlog
order: 115
created: '2026-05-02T00:00:00.000Z'
updated: '2026-05-03T00:00:00.000Z'
project: eval-fixture
---

Closing the tab mid-edit discards work with no prompt. The editor should warn on navigation while changes are pending, and the warning must clear as soon as the pending save resolves so it does not fire on an already-saved document.
