---
title: "Strip EXIF metadata from uploaded images"
type: task
priority: high
status: backlog
order: 142
created: '2026-05-03T03:00:00.000Z'
updated: '2026-05-04T03:00:00.000Z'
project: eval-fixture
---

Uploaded photographs keep their embedded metadata, which routinely includes GPS coordinates and device identifiers that are then served publicly. Metadata should be stripped on ingest while preserving orientation so images do not end up rotated.
