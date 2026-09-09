---
title: "Rotate database credentials without downtime"
type: task
priority: high
status: todo
order: 108
created: '2026-05-01T17:00:00.000Z'
updated: '2026-05-02T17:00:00.000Z'
project: eval-fixture
---

Rotating the database password today means restarting every service at once, so rotation keeps being deferred and the current credential is over a year old. The pool should accept a second valid credential during an overlap window and pick up the new one as connections recycle, making rotation a routine operation rather than an outage.
