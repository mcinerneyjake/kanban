# Kanban Project

## Session startup (MANDATORY — always do this before anything else)

At the start of every session in this directory, **even if the user's first message is a specific request**, run these steps before responding:

1. Call `list_tickets` to load the board
2. Print a one-line summary: ticket counts by status (e.g. "3 backlog · 2 todo · 1 in-progress")
3. If any tickets are `todo`, use `AskUserQuestion` to present a single-select prompt:
   - question: "Which ticket should we start?"
   - header: "Ticket"
   - One option per `todo` ticket: `label` = ticket title, `description` = `[priority] type`
   - Include a final option: label "Skip", description "Don't start a ticket right now"
4. When the user picks a ticket (not Skip), call `start_ticket` with its id — this marks it in-progress and returns the full body so implementation can begin immediately

If no tickets are `todo`, just show the summary and wait for instructions.

Do not skip this startup sequence. If the user opens with a question or task, complete steps 1–2 first, then address their request.

## Ticket workflow

This project has a kanban MCP server. When asked to work on a ticket:

1. Call `list_tickets` to find it by title match
2. Call `start_ticket` to set `status: "in-progress"` before starting (preferred over `update_ticket` for this — it marks and loads in one call)
3. Implement the work described in the ticket's `body`
4. Call `update_ticket` to set `status: "done"` when finished, and append an `## Implementation summary` to the ticket body

When asked to create a ticket, use `create_ticket`. When asked what's on the board or what's left to do, call `list_tickets`.

## Project structure

- `server/tickets.ts` — service layer (CRUD on markdown files, single source of truth)
- `server/index.ts` — Express routes (thin, delegates to service)
- `src/` — React frontend
- `tickets/` — one `.md` file per ticket (frontmatter + markdown body)
- `shared/constants.ts` — enum values for status, type, priority
- `mcp/server.ts` — MCP server exposing ticket tools

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
