# Kanban Project

## Ticket workflow

This project has a kanban MCP server. When asked to work on a ticket:

1. Call `list_tickets` to find it by title match
2. Call `update_ticket` to set `status: "in-progress"` before starting
3. Implement the work described in the ticket's `body`
4. Call `update_ticket` to set `status: "done"` when finished

When asked to create a ticket, use `create_ticket`. When asked what's on the board or what's left to do, call `list_tickets`.

## Project structure

- `server/tickets.js` — service layer (CRUD on markdown files, single source of truth)
- `server/index.js` — Express routes (thin, delegates to service)
- `src/` — React frontend
- `tickets/` — one `.md` file per ticket (frontmatter + markdown body)
- `shared/constants.js` — enum values for status, type, priority
- `mcp/server.js` — MCP server exposing ticket tools

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
