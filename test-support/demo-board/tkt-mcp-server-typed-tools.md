---
title: MCP server exposes the board as typed tools
type: feature
priority: high
status: done
created: 2026-06-20T09:00:00.000Z
updated: 2026-07-01T10:00:00.000Z
order: 10
project: kanban
---

A from-scratch MCP server exposes the board to the agent as seven typed tools (list_tickets, get_ticket, create_ticket, update_ticket, start_ticket, record_review, delete_ticket) that it calls like functions, with status validated against a shared enum. This replaces letting the agent grep the tickets directory and hand-edit markdown, moving malformed writes from a runtime failure to a validation error at the boundary.
