---
title: Local-first intake agent with retrieval
type: feature
priority: high
status: done
created: 2026-06-26T09:00:00.000Z
updated: 2026-07-05T10:00:00.000Z
order: 40
project: kanban
---

The intake agent runs local-first against an OpenAI-compatible endpoint with no cloud key. It embeds the board, retrieves the tickets most related to an incoming note, and runs a tool-use loop that proposes a create/update/decline behind a human approval gate.
