---
title: "Warn the user before an idle session expires"
type: feature
priority: medium
status: backlog
order: 148
created: '2026-05-03T09:00:00.000Z'
updated: '2026-05-04T09:00:00.000Z'
project: eval-fixture
---

If an idle timeout ends a session, the next click fails with no warning and unsaved work is lost. A countdown should appear shortly before the session expires, offering to extend it, and it must not fire on a tab that is merely in the background.
