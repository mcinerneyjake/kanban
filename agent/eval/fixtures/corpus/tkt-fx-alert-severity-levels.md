---
title: "Introduce severity levels for alerts"
type: feature
priority: medium
status: backlog
order: 118
created: '2026-05-02T03:00:00.000Z'
updated: '2026-05-03T03:00:00.000Z'
project: eval-fixture
---

Alerts are undifferentiated, so a disk-space warning looks exactly like a total outage and people learn to ignore all of them. Each alert rule should declare a severity, and the delivery channel should follow from it rather than being configured per rule.
