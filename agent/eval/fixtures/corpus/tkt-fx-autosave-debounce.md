---
title: "Debounce autosave so typing does not flood the server"
type: bug
priority: high
status: todo
order: 112
created: '2026-05-01T21:00:00.000Z'
updated: '2026-05-02T21:00:00.000Z'
project: eval-fixture
---

The editor fires a save request on every keystroke, so a paragraph of typing produces hundreds of writes and the last few frequently land out of order. Saves should be debounced with a trailing flush, coalescing a burst of edits into one request while still guaranteeing the final state is written.
