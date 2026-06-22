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
4. **Write tests** for any new server-side logic introduced (see Testing rule below)
5. Call `update_ticket` to set `status: "done"` when finished, and append an `## Implementation summary` to the ticket body

## Testing

After every feature or bug-fix ticket, write pertinent tests in `server/tickets.test.ts` (or a new `*.test.ts` file if the logic lives elsewhere). Tests are written with Vitest and follow the existing patterns in `server/tickets.test.ts`:

- Use `TICKETS_DIR_OVERRIDE` to redirect file I/O to a temp directory — never touch the real `tickets/` folder
- Use `makeRaw` / `writeRaw` helpers to seed fixture files directly, avoiding round-trips through `createTicket`
- Cover: the happy path, edge cases (empty input, boundary values), and rejection cases (invalid input, missing resources)
- Skip tests for pure UI concerns (React components, CSS) — focus on the service layer and any new API routes
- Run `npm test` and confirm all tests pass before marking the ticket done

When asked to create a ticket, use `create_ticket`. When asked what's on the board or what's left to do, call `list_tickets`.

### Ticket creation flow

Before calling `create_ticket`, always use `AskUserQuestion` to collect the following fields in a single prompt (4 questions):

1. **Type** — single-select, options: `bug`, `feature`, `task`, `chore`
2. **Priority** — single-select, options: `low`, `medium`, `high`, `urgent`
3. **Status** — single-select, options: `backlog`, `todo`, `in-progress`, `qa`, `done` (default `backlog`)
4. **Project** — single-select, options: `None` plus any project names visible in the current board context; the user can pick "Other" to type a custom name

Then call `create_ticket` with the title (from the user's original request) and all four fields. Do not call `create_ticket` before collecting these selections.

## Project structure

- `server/tickets.ts` — service layer (CRUD on markdown files, single source of truth)
- `server/index.ts` — Express routes (thin, delegates to service)
- `src/` — React frontend
- `tickets/` — one `.md` file per ticket (frontmatter + markdown body)
- `shared/constants.ts` — enum values for status, type, priority
- `mcp/server.ts` — MCP server exposing ticket tools

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
