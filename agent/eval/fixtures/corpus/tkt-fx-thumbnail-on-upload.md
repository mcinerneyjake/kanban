---
title: "Generate thumbnails at upload time"
type: feature
priority: medium
status: done
order: 141
created: '2026-05-03T02:00:00.000Z'
updated: '2026-05-04T02:00:00.000Z'
project: eval-fixture
---

Full-size images are sent to the browser and scaled with CSS, so a gallery downloads many megabytes to show small previews. Thumbnails should be generated as part of the upload pipeline and served in place of the original wherever a preview is displayed.
