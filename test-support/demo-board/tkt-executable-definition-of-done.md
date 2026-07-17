---
title: Executable definition-of-done gate
type: feature
priority: medium
status: done
created: 2026-06-24T09:00:00.000Z
updated: 2026-07-03T10:00:00.000Z
order: 30
project: kanban
---

The definition of done is a checklist the agent cannot self-certify past: typecheck, lint, tests, and an implementation summary that must include a Tests line (either "N added" or "none, with a reason"). The forced choice turns a skipped test into a decision someone has to defend, and CI runs the same gate on every PR.
