---
title: "Detect and break circular dependencies in the task graph"
type: bug
priority: urgent
status: todo
order: 144
created: '2026-05-03T05:00:00.000Z'
updated: '2026-05-04T05:00:00.000Z'
project: eval-fixture
---

Two tasks can be made to depend on each other, and the scheduler then walks the chain forever and never runs either one. Creating a dependency should be rejected when it would close a cycle, the existing data needs a sweep to find cycles already stored, and the traversal should fail loudly rather than spin if one is ever reached.
