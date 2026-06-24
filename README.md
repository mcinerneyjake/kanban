# Kanban (Markdown-backed)

A local-only, single-board kanban à la Jira/ClickUp. **Every ticket is one
Markdown file** in `tickets/` — that's the entire database. Edit them in the UI
or in your editor; both stay in sync because the files *are* the source of
truth. The board is also driven by an **MCP server**, so an agent like Claude
Code can list, create, and move tickets as first-class tools.

## Stack

- **Backend** — Express, thin. Two-layer Route → Service; the service
  (`server/tickets.ts`) is the only code that touches the filesystem.
- **Frontend** — React + Vite + TypeScript, native HTML5 drag-and-drop (no DnD
  library).
- **MCP server** — `mcp/` exposes the board as agent tools (`list_tickets`,
  `get_ticket`, `start_ticket`, `create_ticket`, `update_ticket`,
  `delete_ticket`) over the same service layer.
- **Parsing** — [`gray-matter`](https://github.com/jonschlinkert/gray-matter)
  for YAML frontmatter; [`marked`](https://github.com/markedjs/marked) +
  [`DOMPurify`](https://github.com/cure53/DOMPurify) for the sanitized
  description preview.

```
kanban/
├── server/          Express API (index.ts) + file service (tickets.ts)
├── mcp/             MCP server: handlers.ts (tool logic) + server.ts (entrypoint)
├── shared/          Domain enums shared by server, client + MCP (no drift)
├── src/             React app
├── tickets/         ← source of truth: one .md per ticket (gitignored)
├── .github/         CI: quality gate · PR branch-name · Claude code review
└── vite.config.ts   dev proxy /api → :3001
```

## Ticket format

```markdown
---
title: SSO login fails on Safari
type: bug           # bug | feature | task | chore
priority: high      # low | medium | high | urgent
status: in-progress # backlog | todo | in-progress | qa | done
order: 1            # fractional sort key within a column
created: 2026-06-20T09:00:00.000Z
updated: 2026-06-20T09:00:00.000Z
---

## Description
Markdown body…
```

## Run

```bash
npm install
npm run dev      # starts API (:3001) and Vite (:5173) together
```

Open <http://localhost:5173>.

> `npm run dev` runs both processes via `concurrently`. Run only the API with
> `npm run server`.

## Tests & CI

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
```

A husky pre-commit hook runs all three locally; the same gate runs in GitHub
Actions on every PR, alongside a check that branch names follow
`<type>/<id>-<slug>`. Work lands on `main` via squash-merged PRs, with branch
protection requiring both checks green.

A third workflow runs an automated **Claude code review** on each PR — it posts
findings as a comment when an `ANTHROPIC_API_KEY` repo secret is configured, and
skips silently when the secret is absent or the diff is docs/config-only.

## Design notes

- **Filename = `{id}.md`** (stable, not title-derived) so renaming a ticket
  never moves or orphans its file.
- **Fractional `order`** — dropping a card between two others sets its order to
  the midpoint of their orders, so a move rewrites exactly one file instead of
  renumbering the column.
- **Atomic writes** — write to a temp file then `rename`, so a crash mid-save
  can't corrupt a ticket.
- **Hand-edit friendly** — invalid/missing fields fall back to defaults on
  read, so a typo in a `.md` file won't crash the board.
- **One source of truth for enums** — `shared/constants.ts` is imported by the
  server, client, and MCP layer, so valid types/statuses never drift.

## Known trade-offs (local-only by design)

- No auth, no per-user isolation — assumes a single user on localhost.
- The Markdown preview is sanitized client-side with DOMPurify, but the server
  itself has no network hardening (no auth, no rate limiting) — don't expose it
  to a network as-is.
- Fractional orders shrink as you repeatedly drop between the same two cards.
  Thousands of moves in one slot would need a renumber pass — irrelevant for
  personal use.
