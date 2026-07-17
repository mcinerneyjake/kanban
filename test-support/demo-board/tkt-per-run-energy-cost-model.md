---
title: Per-run energy cost model
type: feature
priority: medium
status: done
created: 2026-06-28T09:00:00.000Z
updated: 2026-07-06T10:00:00.000Z
order: 50
project: kanban
---

Instead of estimating cost from published token prices, each run reports measured economics: active compute time, token counts, and an energy-based cost (kWh times a regional rate). Unmeasured inputs are reported as null rather than guessed, so the summary never invents a number.
