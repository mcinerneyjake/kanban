---
title: "Lazy-load the charting bundle so first paint is not blocked"
type: bug
priority: high
status: todo
order: 132
created: '2026-05-02T17:00:00.000Z'
updated: '2026-05-03T17:00:00.000Z'
project: eval-fixture
---

The charting library is imported at the application entry point, so every visitor downloads and parses it before anything renders, including on pages with no chart at all. It should be split into a chunk loaded on demand when a chart first mounts, with a placeholder holding the layout in the meantime.
