---
title: "Make the payment retry path safe against partial failures"
type: bug
priority: high
status: todo
order: 156
created: '2026-05-03T17:00:00.000Z'
updated: '2026-05-04T17:00:00.000Z'
project: eval-fixture
---

When a payment request times out, the caller cannot tell whether the charge went through, and retrying risks charging twice while not retrying risks losing the order. The retry path needs a way to ask the provider what actually happened before deciding.
