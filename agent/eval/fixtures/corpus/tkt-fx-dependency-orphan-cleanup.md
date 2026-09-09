---
title: "Clean up dependency edges pointing at deleted tasks"
type: bug
priority: medium
status: todo
order: 159
created: '2026-05-03T20:00:00.000Z'
updated: '2026-05-04T20:00:00.000Z'
project: eval-fixture
---

Deleting a task leaves dependency edges pointing at an id that no longer exists, and the scheduler waits on a predecessor that can never complete. Deletion should remove the incoming edges, and a sweep should clear the ones already stranded.
