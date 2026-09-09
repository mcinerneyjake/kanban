---
title: "Stream large CSV exports instead of buffering in memory"
type: bug
priority: high
status: todo
order: 120
created: '2026-05-02T05:00:00.000Z'
updated: '2026-05-03T05:00:00.000Z'
project: eval-fixture
---

The export endpoint builds the entire CSV as a string before sending it, so a large account exhausts the heap and takes the process down with it. Rows should be written to the response as they are read from the database, with a bounded buffer, so export cost stays flat in memory regardless of size.
