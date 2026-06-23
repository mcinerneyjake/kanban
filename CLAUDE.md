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
4. **Test coverage** — after implementing, explicitly evaluate what layers were touched and act accordingly (see Testing section below for rules). This step is mandatory; do not skip it silently.
5. Run `npm test` and confirm all tests pass
6. Call `update_ticket` to set `status: "done"` when finished, and append an `## Implementation summary` to the ticket body

The implementation summary **must** include a test line — either:
- `Tests: N added — <brief description of what they cover>`
- `Tests: none — <reason, e.g. "pure UI change" or "no new logic">`

## Testing

After every feature or bug-fix ticket, evaluate which layers were touched and write tests accordingly:

| Layer touched | Test file | Framework |
|---|---|---|
| `server/tickets.ts` (service) | `server/tickets.test.ts` | Vitest |
| `server/index.ts` (API routes) | `server/index.test.ts` | Vitest |
| `src/lib/` (shared utilities) | `src/lib/*.test.ts` next to the file | Vitest |
| React components / CSS only | skip | — |

Vitest patterns to follow:
- Use `TICKETS_DIR_OVERRIDE` to redirect file I/O to a temp directory — never touch the real `tickets/` folder
- Use `makeRaw` / `writeRaw` helpers to seed fixture files directly, avoiding round-trips through `createTicket`
- Cover: the happy path, edge cases (empty input, boundary values), and rejection cases (invalid input, missing resources)

**Skip tests only when the change is pure UI** (React components, CSS, no logic). All other changes — service functions, API routes, utility modules — require at least a happy-path test. State the skip reason explicitly in the implementation summary.

When asked to create a ticket, use `create_ticket`. When asked what's on the board or what's left to do, call `list_tickets`.

### Ticket creation flow

Before calling `create_ticket`, always use `AskUserQuestion` to collect the following fields in a single prompt (4 questions):

1. **Type** — single-select, options: `bug`, `feature`, `task`, `chore`
2. **Priority** — single-select, options: `low`, `medium`, `high`, `urgent`
3. **Status** — single-select, options: `backlog`, `todo`, `in-progress`, `qa`, `done` (default `backlog`)
4. **Project** — single-select, options: `None` plus any project names visible in the current board context; the user can pick "Other" to type a custom name

Then call `create_ticket` with the title (from the user's original request) and all four fields. Do not call `create_ticket` before collecting these selections.

## Commit workflow

After each ticket is marked done, ask the user: **"Ready to commit?"** — do not commit until they confirm. Then:

1. `git add` only the files changed for this ticket (never `git add -A`)
2. `git commit` with a message in this shape:
   ```
   <Imperative summary under 72 chars>

   <1–3 sentences on why, not what. Reference the behaviour fixed or
   the invariant established. Omit if the summary is self-contained.>

   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   ```
3. Pass the message via heredoc to avoid shell-escaping issues:
   ```bash
   git commit -m "$(cat <<'EOF'
   Message here
   EOF
   )"
   ```

One ticket = one commit. Do not batch multiple tickets into a single commit.

## Temporary scripts

When a helper script is needed (e.g. to mark a ticket done via the service layer), write it directly to the project root, run it with `node_modules/.bin/tsx <script>.ts`, then delete it. Do not use `/tmp` or the Claude scratchpad directory — relative imports won't resolve from outside the project root.

## Project structure

- `server/tickets.ts` — service layer (CRUD on markdown files, single source of truth)
- `server/index.ts` — Express routes (thin, delegates to service)
- `src/` — React frontend
- `tickets/` — one `.md` file per ticket (frontmatter + markdown body)
- `shared/constants.ts` — enum values for status, type, priority
- `mcp/server.ts` — MCP server exposing ticket tools

## TypeScript conventions

- **No type casting** (`as Foo`, `as string`, `as any`). Use type predicates (`(x): x is string => Boolean(x)`), proper generics, or fix the upstream type instead.
- **No non-null assertions** (`foo!`, `bar!.baz`). Restructure so TypeScript can narrow the type itself — e.g. check `if (foo && bar)` at the closure level so the truthy branch carries the narrowed type.
- **No `any` or `unknown` in your own types.** Define concrete interfaces at external boundaries (library data, API responses). Let TypeScript infer types where possible; use type predicates to narrow instead of widening to `any`/`unknown`.

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
