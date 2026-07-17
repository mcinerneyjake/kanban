---
title: Guard hook blocks dangerous git commands
type: feature
priority: high
status: done
created: 2026-06-22T09:00:00.000Z
updated: 2026-07-02T10:00:00.000Z
order: 20
project: kanban
---

A PreToolUse hook inspects every shell command before it runs and blocks the dangerous shapes: git add -A, commit -a, any commit or push targeting main, force-push, reset --hard, clean -f, checkout -f. The rules are enforced by the hook rather than requested in the prompt, and the hook has its own test suite.
