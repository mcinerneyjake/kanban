---
title: Playwright e2e suite, path-filtered in CI
type: task
priority: medium
status: in-progress
created: 2026-07-01T09:00:00.000Z
updated: 2026-07-08T10:00:00.000Z
order: 60
project: kanban
---

An end-to-end Playwright suite runs in CI, path-filtered to UI-touching changes so it only fires when the frontend actually changes. It is advisory until it earns a stable track record, then gets promoted to a required check in the branch ruleset.
