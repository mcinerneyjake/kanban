# Kanban Project

## Session startup (MANDATORY — always do this before anything else)

At the start of every session in this directory, run these steps before responding **when the opening message is a ticket or implementation request** (e.g. "work on X", "fix the bug in Y", "what's left on the board"):

1. Call `list_tickets` to load the board
2. Print a one-line summary: ticket counts by status (e.g. "3 backlog · 2 todo · 1 in-progress")
3. If the user's opening message names a specific ticket (e.g. "work on X", "start ticket Y"), match it against the board and call `start_ticket` directly — skip the selection prompt entirely.
4. Otherwise, if any tickets are `todo`, use `AskUserQuestion` to present a single-select prompt:
   - question: "Which ticket should we start?"
   - header: "Ticket"
   - One option per `todo` ticket: `label` = ticket title, `description` = `[priority] type`
   - Include a final option: label "Skip", description "Don't start a ticket right now"
5. When the user picks a ticket (not Skip), call `start_ticket` with its id — this marks it in-progress and returns the full body so implementation can begin immediately

If no tickets are `todo`, just show the summary and wait for instructions.

**Escape hatch:** If the opening message is a meta, analysis, planning, or configuration request with no ticket implied (e.g. "analyze my workflow", "explain how X works", "update a setting"), skip the board load and address it directly. When genuinely in doubt, do steps 1–2 (they're cheap) and then address the request — but don't force the board on a clearly non-ticket ask.

## MCP server

The kanban MCP server is wired in `.mcp.json` at the project root (project scope) and auto-starts with the project. It exposes `list_tickets`, `get_ticket`, `start_ticket`, `create_ticket`, `update_ticket`, and `delete_ticket`. Always prefer these tools over file-grepping or helper scripts. If the tools are not available in a session, check that `.mcp.json` has the `kanban` entry, that the server is approved (Claude Code prompts to trust project MCP servers on first load), and restart the session — MCP servers load at startup and are not hot-reloaded. Note: MCP servers declared in `.claude/settings.json` are ignored — that file does not support an `mcpServers` key.

## Ticket workflow

This project has a kanban MCP server. When asked to work on a ticket:

1. Call `list_tickets` to find it by title match
2. Call `start_ticket` to set `status: "in-progress"` before starting (preferred over `update_ticket` for this — it marks and loads in one call), then cut the ticket's branch (see **Branch, commit & PR workflow → 1. Branch**)
3. Implement the work described in the ticket's `body`
4. **Test coverage** — after implementing, explicitly evaluate what layers were touched and act accordingly (see Testing section below for rules). This step is mandatory; do not skip it silently.
5. **Quality gate** — run `npm run typecheck`, `npm run lint`, and `npm test`. All three must pass before the ticket can be marked done. (Docs-only tickets that touch no code may skip the gate; state that in the summary.)
6. **Self-review (`qa`)** — for non-trivial tickets, set `status: "qa"` via `update_ticket`, then run a `/code-review` pass (and `/verify` when runtime behavior should be confirmed). Address findings before continuing. Trivial or docs-only tickets may skip `qa` and proceed to step 7.
7. Append an `## Implementation summary` to the ticket body via `update_ticket`. Do **not** set `status: "done"` yet — that happens after the PR merges (see **Branch, commit & PR workflow → 4. Merge**).

The implementation summary **must** include a test line — either:
- `Tests: N added — <brief description of what they cover>`
- `Tests: none — <reason, e.g. "pure UI change" or "no new logic">`

### Definition of Done

A ticket is **Done** only when all of these hold (the gate is executable, not advisory):

- [ ] `npm run typecheck` passes — or N/A (docs-only, no code touched)
- [ ] `npm run lint` passes — or N/A (docs-only, no code touched)
- [ ] `npm test` passes, with tests added per the Testing table below — or an explicit skip reason
- [ ] Self-review (`qa`) completed for non-trivial tickets
- [ ] `## Implementation summary` appended to the ticket body, including the `Tests:` line
- [ ] Status transitioned to `done` via `update_ticket` **after PR merge**

## Testing

After every feature or bug-fix ticket, evaluate **each touched file independently** and write tests accordingly. Do not evaluate the ticket as a whole — a route ticket that also modifies a shared utility in `src/lib/` requires tests for both layers:

| Layer touched | Test file | Framework |
|---|---|---|
| `server/tickets.ts` (service) | `server/tickets.test.ts` | Vitest |
| `server/index.ts` (API routes) | `server/index.test.ts` | Vitest |
| `src/lib/` (shared utilities) | `src/lib/*.test.ts` next to the file | Vitest |
| `mcp/handlers.ts` (MCP tool handlers) | `mcp/handlers.test.ts` | Vitest |
| React components / CSS only | skip | — |

> The MCP **logic** lives in `mcp/handlers.ts` (testable); `mcp/server.ts` is a thin transport-wiring entrypoint with no logic, so it needs no test.

Vitest patterns to follow:
- Use `TICKETS_DIR_OVERRIDE` to redirect file I/O to a temp directory — never touch the real `tickets/` folder
- Use `makeRaw` / `writeRaw` helpers to seed fixture files directly, avoiding round-trips through `createTicket`
- Cover: the happy path, edge cases (empty input, boundary values), and rejection cases (invalid input, missing resources)

**Skip tests only when the change is pure UI** (React components, CSS, no logic). All other changes — service functions, API routes, utility modules — require at least a happy-path test. State the skip reason explicitly in the implementation summary.

When asked to create a ticket, use `create_ticket`. When asked what's on the board or what's left to do, call `list_tickets`.

### Ticket creation flow

**Infer the fields, then confirm in one step** — do not make the user answer four separate prompts.

1. **Infer all four fields** from the request, using these heuristics (so the inference is reproducible):
   - **Type** (`bug` | `feature` | `task` | `chore`) — from intent: "fix / broken / regression / bug" → `bug`; "add / build / support / new" → `feature`; "update / tidy / bump / rename / clean up" → `chore`; otherwise `task`.
   - **Priority** (`low` | `medium` | `high` | `urgent`) — from urgency words: "quick / minor / nit / whenever" → `low`; "urgent / asap / blocking / drop everything" → `urgent`; "soon / important" → `high`; otherwise `medium`.
   - **Status** (`backlog` | `todo` | `in-progress` | `qa` | `done`) — default `backlog`; `todo` if the user wants it queued next; `in-progress` if they want to start it now.
   - **Project** — match against projects visible on the board; else `None`.
   - **Title** — a concise imperative drawn from the request.

2. **Confirm once.** State the inferred fields in a single line and ask the user to confirm or adjust — e.g. *"I'll create **Update the README** — chore · low · backlog · no project. Confirm or edit?"*. A confirmation creates it; any correction ("make it high") is applied first. Prefer this lightweight plain-text confirm over a prompt.

3. **Fall back to an explicit `AskUserQuestion`** only for the field(s) that are genuinely ambiguous (e.g. intent doesn't map cleanly to a type) — pre-select the best inference as the recommended option.

Never call `create_ticket` before the user has confirmed (or accepted the inferred defaults).

## Branch, commit & PR workflow

Every ticket lands on its own branch and merges to `main` via a **squash-merged PR** — never a direct push to `main`. There are three human-approval gates: **"Ready to commit?"**, **"Ready to open PR?"**, **"Ready to merge?"**. Never cross a gate without explicit confirmation.

### 1. Branch (at `start_ticket`)

When a ticket goes in-progress, cut its branch from an up-to-date `main` **before editing**:

```bash
git switch main && git pull
git switch -c <prefix>/<id>-<slug>
```

- **`<prefix>`** maps the ticket `type`: `bug→fix`, `feature→feat`, `task→task`, `chore→chore`.
- **`<id>`** is the full ticket id (e.g. `tkt-4f7ccb2cd6bc`).
- **`<slug>`** is the title kebab-cased: lowercased, symbols dropped, ~4–5 words max.

Example: `chore/tkt-4f7ccb2cd6bc-adopt-branch-per-ticket`.

### 2. Commit (once implementation is complete)

Ask **"Ready to commit?"** — do not commit until confirmed. Then:

1. `git add` only the files changed for this ticket (never `git add -A`).
2. `git commit` with a message in this shape, passed via heredoc to avoid shell-escaping issues:
   ```bash
   git commit -m "$(cat <<'EOF'
   <Imperative summary under 72 chars>

   <1–3 sentences on why, not what. Reference the behaviour fixed or
   the invariant established. Omit if the summary is self-contained.>

   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

Commit as many times as the work needs — the squash-merge collapses the branch to **one commit on `main`**, preserving the one-ticket-one-commit history. Do not put multiple tickets on one branch.

### 3. PR (after committing)

Ask **"Ready to open PR?"** — then push the branch and open it:

```bash
git push -u origin <prefix>/<id>-<slug>
gh pr create --base main --title "<ticket title>" --body "<why + ticket id + the ## Implementation summary>"
```

The PR body must reference the ticket id and include the `## Implementation summary`. CI (`.github/workflows/ci.yml`) runs the same gate (typecheck + lint + test) on the PR — it must be green before merge. A second check (`.github/workflows/pr-branch-name.yml`) fails the PR if the head branch doesn't match `<type>/<id>-<slug>`.

When the PR opens, call `update_ticket` to set `status: "qa"` — the ticket enters review whether or not it went through the self-review step. It stays in `qa` until the merge step. The `code-review` CI job also runs automatically and posts its findings as a PR comment.

### 4. Merge (after CI is green)

Before asking **"Ready to merge?"**, check the code review comment posted to the PR by the `code-review` CI job:

```bash
gh pr view <number> --comments
```

If there are significant findings, present them to the user and ask: **"Fix these in the current PR, or create follow-up tickets?"**
- **Fix now** — implement, commit, push; wait for CI to go green again, then return to this step
- **Follow-up tickets** — call `create_ticket` for each finding, then proceed to merge

If the review found no significant issues (or the secret wasn't configured), proceed directly.

Ask **"Ready to merge?"** — never merge without explicit approval. Then:

```bash
gh pr merge --squash --delete-branch
git switch main && git pull
```

This squashes the branch to a single commit on `main` and deletes the branch locally and remotely. After the merge completes, call `update_ticket` to set `status: "done"` — this is the moment the ticket is officially closed.

## Temporary scripts

Prefer the MCP tools for all ticket operations — never write a script to mark a ticket done or mutate ticket state; `update_ticket` does that. Only when a genuine one-off needs the service layer directly (e.g. a bulk migration across the markdown files) write a script to the project root, run it with `node_modules/.bin/tsx <script>.ts`, then delete it. Do not use `/tmp` or the Claude scratchpad directory — relative imports won't resolve from outside the project root.

## Project structure

- `server/tickets.ts` — service layer (CRUD on markdown files, single source of truth)
- `server/index.ts` — Express routes (thin, delegates to service)
- `src/` — React frontend
- `tickets/` — one `.md` file per ticket (frontmatter + markdown body)
- `shared/constants.ts` — enum values for status, type, priority
- `mcp/handlers.ts` — MCP tool definitions + dispatch logic (the testable core)
- `mcp/server.ts` — thin MCP entrypoint: wires the handlers to a stdio transport

## TypeScript conventions

- **No type casting** (`as Foo`, `as string`, `as any`). Use type predicates (`(x): x is string => Boolean(x)`), proper generics, or fix the upstream type instead.
- **No non-null assertions** (`foo!`, `bar!.baz`). Restructure so TypeScript can narrow the type itself — e.g. check `if (foo && bar)` at the closure level so the truthy branch carries the narrowed type.
- **No `any` or `unknown` in your own types.** Define concrete interfaces at external boundaries (library data, API responses). Let TypeScript infer types where possible; use type predicates to narrow instead of widening to `any`/`unknown`.

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
