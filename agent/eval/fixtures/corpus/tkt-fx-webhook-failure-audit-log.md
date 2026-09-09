---
title: "Log every webhook delivery failure to the audit trail"
type: task
priority: medium
status: backlog
order: 101
created: '2026-05-01T10:00:00.000Z'
updated: '2026-05-02T10:00:00.000Z'
project: eval-fixture
---

Webhook delivery failures are only visible in application logs, which roll over quickly. Each failed delivery should append an audit record carrying the subscriber, the endpoint, the response status and the payload id so support can answer whether an event was ever sent.
