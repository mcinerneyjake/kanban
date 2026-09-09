---
title: "Retry failed webhook deliveries with exponential backoff"
type: feature
priority: high
status: todo
order: 100
created: '2026-05-01T09:00:00.000Z'
updated: '2026-05-02T09:00:00.000Z'
project: eval-fixture
---

A webhook delivery that gets a 5xx or times out is dropped on the floor today, so a subscriber that was briefly down loses the event permanently. Deliveries should be queued and retried on an exponential schedule with jitter, giving up after a bounded number of attempts. The final give-up should be visible rather than silent.
