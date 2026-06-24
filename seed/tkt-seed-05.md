---
title: Dark mode toggle
type: feature
priority: low
status: qa
order: 4
created: 2026-06-16T10:30:00.000Z
updated: 2026-06-23T09:10:00.000Z
---

## Description
Add a light/dark theme toggle, persisted to `localStorage` and defaulting to the
OS `prefers-color-scheme`. Theme tokens already exist in `styles.css`.

## Acceptance
- Toggle in the header; persists across reloads.
- Respects OS preference on first visit.
