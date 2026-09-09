---
title: "Sign webhook payloads with an HMAC header"
type: feature
priority: high
status: backlog
order: 102
created: '2026-05-01T11:00:00.000Z'
updated: '2026-05-02T11:00:00.000Z'
project: eval-fixture
---

Subscribers currently have no way to verify that a webhook actually came from us, so anyone who learns an endpoint URL can forge events. Each delivery should carry an HMAC signature over the raw body plus a timestamp, with a documented verification recipe and support for rotating the signing secret.
