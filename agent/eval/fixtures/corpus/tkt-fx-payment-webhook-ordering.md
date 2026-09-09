---
title: "Handle out-of-order payment status webhooks"
type: bug
priority: high
status: todo
order: 157
created: '2026-05-03T18:00:00.000Z'
updated: '2026-05-04T18:00:00.000Z'
project: eval-fixture
---

Payment status callbacks can arrive out of order, so a stale pending message can overwrite a settled state and the payment appears unfinished forever. Status transitions should be applied by sequence rather than by arrival.
