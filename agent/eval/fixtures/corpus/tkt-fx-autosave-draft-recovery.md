---
title: "Recover unsaved draft content after a crash"
type: feature
priority: medium
status: backlog
order: 114
created: '2026-05-01T23:00:00.000Z'
updated: '2026-05-02T23:00:00.000Z'
project: eval-fixture
---

If the tab closes before an autosave completes, the in-flight edit is gone with nothing offering it back. Draft content should be mirrored locally as it is typed and offered for recovery on the next visit, with a clear discard path so a stale draft cannot silently overwrite newer server state.
