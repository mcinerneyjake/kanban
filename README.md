# Kanban (Markdown-backed)

A local-only, single-board kanban à la Jira/ClickUp. **Every ticket is one
Markdown file** in `tickets/` — that's the entire database. Edit them in the UI
or in your editor; both stay in sync because the files *are* the source of
truth. The board is also driven by an **MCP server**, so an agent like Claude
Code can list, create, and move tickets as first-class tools.

## How this was built (AI-first)

This board was built by an agent driving itself. Every feature — the
Markdown-backed store, the MCP server, the agentic-RAG intake agent — landed as
a kanban ticket that Claude Code picked up through *this project's own* MCP
tools, implemented, and shipped. The board is both the product and its own
issue tracker: Claude reads the next ticket with `start_ticket`, writes the
code, and closes it with `update_ticket` — dogfooding the very tools it builds.

The workflow is deliberately strict so an agent can run it end-to-end. One
ticket → one branch → one squash-merged PR, gated by CI (typecheck · lint ·
Vitest) and a *second* automated Claude review that comments on each PR. Branch
protection blocks direct pushes to `main`, so nothing merges without the gate
green. A human approves three checkpoints — commit, open PR, merge — but the
implementation between them is the agent's.

The result: **124 commits across four days, 53 co-authored by Claude**, each a
self-contained, tested, reviewed slice rather than a big-bang dump. It's a
working demo of agent-driven development where the *process* — tickets, gates,
and review — is as much the artifact as the code.

## Quick Start

**Requires Node 20+.**

```bash
npm install
npm run seed     # optional — populate an empty board with demo tickets
npm run dev      # starts API (:3001) and Vite (:5173) together
```

Open <http://localhost:5173>.

> `npm run dev` runs both processes via `concurrently`. Run only the API with
> `npm run server`.
>
> `npm run seed` copies the demo tickets in `seed/` into `tickets/` — but only
> when the board is empty, so it never overwrites your own tickets.

### Use it as an MCP server

The board is exposed to agents through an MCP server, so Claude Code can manage
tickets as first-class tools. `.mcp.json` at the repo root wires it in at
*project scope*, so it auto-starts when you open the project — Claude Code
prompts you to trust it on first load:

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"]
    }
  }
}
```

Once trusted, the tools (`list_tickets`, `get_ticket`, `start_ticket`,
`create_ticket`, `update_ticket`, `delete_ticket`) are available in the session.

## Agentic-RAG intake agent

A local, agentic Retrieval-Augmented-Generation agent that turns a raw report
(a bug, a request, a note) into the right action on the board — **find the
existing ticket and update it, or create a new one** — with a human approving
every write. It runs entirely against a local, OpenAI-compatible LLM runtime
(e.g. [LM Studio](https://lmstudio.ai)); no cloud API or key required.

```bash
npm run agent -- "the PDF export cuts off the footer on mobile Safari"
```

The agent embeds the report, semantically searches the board for duplicates,
and proposes a `create_ticket` / `update_ticket` — pausing for your `y/N`
approval (showing the proposed change, plus the current state for updates)
before anything is written.

### How it works

Four layers, each independently testable (the model is mocked in tests):

1. **Retrieval** (`agent/retrieval.ts`) — embeds every ticket via the runtime's
   `/v1/embeddings` and builds an in-memory cosine index. Run just this layer
   with `npm run agent:search -- "<query>"`.
2. **Tools** (`agent/tools.ts`) — a safe whitelist of the MCP tools plus
   `search_board`, adapted to the OpenAI function-tool schema.
3. **Loop** (`agent/loop.ts`) — the tool-use loop: chat → dispatch tool calls →
   feed results back → summarize. Search results carry ticket **status**, and
   the agent is told to skip archived/done tickets as update targets.
4. **CLI + approval gate** (`agent/index.ts`) — the entry point and a
   **fail-safe** human-in-the-loop gate: every non-read-only tool needs
   approval, and a closed stdin defaults to *decline*.

### Local-LLM setup

Configure an embedding model and a chat model via a gitignored `.env` (copy
`.env.example`). The IDs **must match what your runtime advertises** — check
with `curl http://localhost:1234/v1/models`:

```bash
EMBED_BASE_URL=http://localhost:1234/v1
EMBED_MODEL=text-embedding-qwen3-embedding-0.6b
LLM_BASE_URL=http://localhost:1234/v1
LLM_MODEL=qwen/qwen3.5-9b
```

Any OpenAI-compatible runtime works (LM Studio, llama.cpp, Ollama). The chat
model needs reliable tool-calling; a bigger model gives better summaries.
Open-weight `LLM_MODEL` options, in rough quality order:

| Model | Notes |
|---|---|
| `qwen3-coder-30b-a3b` | Best tool-calling + summaries |
| `gpt-oss-20b` | Great on ~16 GB |
| `qwen3.5-9b` | Lightest; summaries can be thin |

Task-instruction prefixes for known embedders (Qwen3-Embedding, nomic) are
applied automatically; override with `EMBED_QUERY_PREFIX` / `EMBED_DOC_PREFIX`
for any other embedder.

#### Trying it yourself — the quick, robust path

Fully local: no API keys, no billing, nothing to flake mid-demo.

1. Install [LM Studio](https://lmstudio.ai).
2. Load **Qwen3-Embedding-0.6B** (~600 MB) plus a chat model from the table,
   and start the local server (`:1234`).
3. `curl http://localhost:1234/v1/models` → put the exact ids in `.env`.
4. `npm run dev`, then create a ticket (watch the dedup strip) or run
   `npm run agent -- "<report>"`.

#### Bring your own key (cloud chat — optional, advanced)

Prefer not to run a local *chat* model? Point `LLM_BASE_URL` at an
OpenAI-compatible cloud endpoint and set `LLM_API_KEY` (`.env` only, never
commit):

- **OpenAI** — `https://api.openai.com/v1` (e.g. `LLM_MODEL=gpt-4o-mini`).
  Native format, no shim.
- **Claude** — `https://api.anthropic.com/v1` (Anthropic's OpenAI-compat
  endpoint, e.g. `LLM_MODEL=claude-...`). A best-effort migration shim —
  **verify the tool loop works** before demoing on it.

Two caveats worth knowing: **Anthropic has no embeddings API**, so retrieval
still needs an embedder (a local one, or OpenAI's). And the embedder is keyless
today, so a *fully*-cloud setup is OpenAI-for-both; Claude is chat-only
alongside a local embedder.

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
