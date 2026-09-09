---
title: "Encrypt database backups at rest"
type: task
priority: high
status: backlog
order: 109
created: '2026-05-01T18:00:00.000Z'
updated: '2026-05-02T18:00:00.000Z'
project: eval-fixture
---

Nightly database dumps land in object storage as plaintext, so anyone with read access to the bucket has the whole dataset. Backups should be encrypted before upload with a key held separately from the storage credentials, and the restore path must be exercised rather than assumed.
