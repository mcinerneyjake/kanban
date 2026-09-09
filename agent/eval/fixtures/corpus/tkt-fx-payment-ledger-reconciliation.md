---
title: "Reconcile payments against the provider’s ledger nightly"
type: task
priority: high
status: backlog
order: 130
created: '2026-05-02T15:00:00.000Z'
updated: '2026-05-03T15:00:00.000Z'
project: eval-fixture
---

Our payment records and the provider’s are assumed to agree and nothing checks. A nightly job should compare both sides, report any payment present in one and missing from the other, and fail loudly rather than reporting a clean run it could not complete.
