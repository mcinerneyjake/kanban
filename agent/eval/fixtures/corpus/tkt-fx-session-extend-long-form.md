---
title: "Keep a session alive while a long form is being filled in"
type: bug
priority: medium
status: todo
order: 149
created: '2026-05-03T10:00:00.000Z'
updated: '2026-05-04T10:00:00.000Z'
project: eval-fixture
---

Filling in a long form involves no network activity, so the session is treated as idle and expires mid-entry, discarding everything typed. Local interaction should count as activity for the purposes of session lifetime.
