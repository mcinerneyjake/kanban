---
title: "Reject oversized uploads with a clear error"
type: bug
priority: medium
status: todo
order: 143
created: '2026-05-03T04:00:00.000Z'
updated: '2026-05-04T04:00:00.000Z'
project: eval-fixture
---

There is no upload size limit, so an accidental multi-gigabyte file fills the disk and the request fails with an unhelpful generic error. Uploads should be bounded, rejected early rather than after the full transfer, and the limit stated in the message.
