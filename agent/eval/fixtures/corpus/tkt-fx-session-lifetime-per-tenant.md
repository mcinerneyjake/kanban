---
title: "Make session lifetime configurable per tenant"
type: feature
priority: medium
status: backlog
order: 150
created: '2026-05-03T11:00:00.000Z'
updated: '2026-05-04T11:00:00.000Z'
project: eval-fixture
---

Session lifetime is one global constant, and tenants with stricter policies cannot shorten it while others find it disruptively short. The lifetime should be a per-tenant setting with a documented default and an enforced upper bound.
