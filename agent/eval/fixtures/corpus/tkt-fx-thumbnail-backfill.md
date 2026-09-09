---
title: "Backfill missing thumbnails for previously uploaded images"
type: task
priority: medium
status: todo
order: 140
created: '2026-05-03T01:00:00.000Z'
updated: '2026-05-04T01:00:00.000Z'
project: eval-fixture
---

Thumbnail generation was added after launch and only runs on new uploads, so everything uploaded before it shows a broken placeholder. A backfill job should walk existing images and generate the missing sizes, resumable so it can run in batches without redoing finished work.
