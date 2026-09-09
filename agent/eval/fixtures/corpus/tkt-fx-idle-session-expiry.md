---
title: "Expire idle sessions after a configurable timeout"
type: feature
priority: high
status: todo
order: 136
created: '2026-05-02T21:00:00.000Z'
updated: '2026-05-03T21:00:00.000Z'
project: eval-fixture
---

Sessions live until the cookie expires, so an unattended machine stays authenticated for weeks and this keeps coming up in security review. Sessions should expire after a configurable period without activity, with the timeout set centrally rather than per deployment and a clear message on the next request.
