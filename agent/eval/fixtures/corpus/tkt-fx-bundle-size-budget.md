---
title: "Fail the build when the bundle exceeds its size budget"
type: task
priority: medium
status: backlog
order: 153
created: '2026-05-03T14:00:00.000Z'
updated: '2026-05-04T14:00:00.000Z'
project: eval-fixture
---

Bundle size grows unnoticed between releases and is only discovered when a page feels slow. The build should enforce a byte budget per entry chunk and fail loudly when a change pushes it over, rather than reporting the number and moving on.
