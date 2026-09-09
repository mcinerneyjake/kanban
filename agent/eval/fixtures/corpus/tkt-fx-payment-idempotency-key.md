---
title: "Accept an idempotency key on the payment submission endpoint"
type: bug
priority: urgent
status: todo
order: 128
created: '2026-05-02T13:00:00.000Z'
updated: '2026-05-03T13:00:00.000Z'
project: eval-fixture
---

Submitting a payment twice creates two charges, and an impatient double-click on checkout is enough to do it. The endpoint should accept a caller-supplied idempotency key, return the original result for a repeat of the same key, and reject a reused key carrying a different payload.
