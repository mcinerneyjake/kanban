# Kanban (Markdown-backed)

A local-only, single-board kanban à la Jira/ClickUp. **Every ticket is one
Markdown file** in `tickets/` — that's the entire database. Edit them in the UI
or in your editor; both stay in sync because the files *are* the source of
truth.

## Stack

- **Backend** — Express, ~120 lines. Two-layer Route → Service. The service
  (`server/tickets.js`) is the only code that touches the filesystem.
- **Frontend** — React + Vite, native HTML5 drag-and-drop (no DnD library).
- **Parsing** — [`gray-matter`](https://github.com/jonschlinkert/gray-matter)
  for YAML frontmatter; [`marked`](https://github.com/markedjs/marked) for the
  description preview.

```
kanban/
├── server/          Express API (index.js) + file service (tickets.js)
├── shared/          Domain enums shared by server + client (no drift)
├── src/             React app
├── tickets/         ← source of truth: one .md per ticket
└── vite.config.js   dev proxy /api → :3001
```

## Ticket format

```markdown
---
title: SSO login fails on Safari
type: bug          # bug | feature | task | chore
priority: high     # low | medium | high | urgent
status: in-progress # backlog | todo | in-progress | done
order: 1           # fractional sort key within a column
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

## Known trade-offs (local-only by design)

- No auth, no concurrency control — assumes a single user on localhost.
- The Markdown preview renders trusted, self-authored content (no HTML
  sanitization). Fine locally; don't expose this server to a network.
- Fractional orders shrink as you repeatedly drop between the same two cards.
  Thousands of moves in one slot would need a renumber pass — irrelevant for
  personal use.
