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
Vitest, plus a path-filtered Playwright e2e job) and a *second* automated Claude
review that comments on each PR. Branch protection blocks direct pushes to
`main`, so nothing merges without the gate green. A human approves three
checkpoints — commit, open PR, merge — but the implementation between them is
the agent's.

The result: **177 commits across ten days, 148 co-authored by Claude**, each a
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

> **No LLM setup needed to run the board.** The kanban app, the MCP server, and CI
> all run with zero model configuration. Only the intake agent's dedup/triage
> features need a local model — the server boots fine without one and simply skips
> warming the embedding index. See [Agentic-RAG intake agent](#agentic-rag-intake-agent).

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

1. **Retrieval** (`agent/retrieval/retrieval.ts`) — embeds every ticket via the
   runtime's `/v1/embeddings` and builds an in-memory cosine index. Run just this
   layer with `npm run agent:search -- "<query>"`.
2. **Tools** (`agent/runtime/tools.ts`) — a safe whitelist of the MCP tools plus
   `search_board`, adapted to the OpenAI function-tool schema.
3. **Loop** (`agent/runtime/loop.ts`) — the tool-use loop: chat → dispatch tool calls →
   feed results back → summarize. Search results carry ticket **status**, and
   the agent is told to skip archived/done tickets as update targets.
4. **CLI + approval gate** (`agent/index.ts`) — the entry point and a
   **fail-safe** human-in-the-loop gate: every non-read-only tool needs
   approval, and a closed stdin defaults to *decline*.

Each run ends with a cost summary from a pluggable model
(`agent/cost/economics.ts`): local runs are costed by **measured energy**
(kWh × your regional rate) rather than notional token prices — the per-token
API-price model stays available as a dormant seam for cloud endpoints.

### Local-LLM setup

Configure an embedding model and a chat model via a gitignored `.env` (copy
`.env.example`). The IDs **must match what your runtime advertises** — check
with `curl http://localhost:1234/v1/models`:

```bash
EMBED_BASE_URL=http://localhost:1234/v1
EMBED_MODEL=text-embedding-qwen3-embedding-0.6b
LLM_BASE_URL=http://localhost:1234/v1
LLM_MODEL=openai/gpt-oss-20b
```

Any OpenAI-compatible runtime works (LM Studio, llama.cpp, Ollama). The chat
model needs reliable tool-calling; a bigger model gives better summaries.
Open-weight `LLM_MODEL` options, in rough quality order:

| Model | Notes |
|---|---|
| `qwen3-coder-30b-a3b` | Best tool-calling + summaries |
| `openai/gpt-oss-20b` | Great on ~16 GB |
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
4. `npm run dev`, then hit **+ New ticket** — with a model up, the create modal
   is AI-first: paste a messy note and the agent drafts the ticket (with a
   "Related tickets" dedup strip as you type). Or run the CLI:
   `npm run agent -- "<report>"`. Without a model, the modal falls back to the
   plain manual form.

#### Bring your own key (cloud chat — optional, advanced)

Prefer not to run a local *chat* model? The provider seam is just the
OpenAI-compatible `/v1` contract — point `LLM_BASE_URL` at a cloud endpoint and
set `LLM_API_KEY` (`.env` only, never commit). **OpenAI**
(`https://api.openai.com/v1`, e.g. `LLM_MODEL=gpt-4o-mini`) works natively. A
dedicated Anthropic/Claude chat driver was evaluated and deliberately dropped
rather than shipped half-verified — cloud stays a config swap behind the seam,
not a maintained path. (The one cloud integration this repo keeps is the CI
code-review job.) Note the embedder is keyless today, so retrieval still runs
against a local embedding model either way.

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
├── server/          Express API (routes → controllers → tickets.ts service)
├── mcp/             MCP server: handlers.ts (tool logic) + server.ts (entrypoint)
├── agent/           Intake agent: retrieval · tools · loop · CLI · cost/economics
├── shared/          Domain enums shared by server, client + MCP (no drift)
├── src/             React app
├── e2e/             Playwright browser tests (smoke + drag-and-drop)
├── tickets/         ← source of truth: one .md per ticket (gitignored)
├── .github/         CI: quality gate · branch-name · Claude review · e2e
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

Optional frontmatter fields: `project`, `blockers` (ticket ids), `parent`
(sub-tickets), `dueDate`, `assignee`. Invalid values never crash the board —
see Design notes.

## Tests & CI

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (includes the e2e specs)
npm test            # vitest — 640+ tests across every logic layer
npm run test:e2e    # playwright — boots the app and drives a real browser
```

A husky pre-commit hook runs the first three locally; the same gate runs in
GitHub Actions on every PR, alongside a check that branch names follow
`<type>/<id>-<slug>`. Work lands on `main` via squash-merged PRs, with branch
protection requiring three checks green (gate · branch-name · review).

Two more workflows run per-PR: an automated **Claude code review** posts
findings as a comment when an `ANTHROPIC_API_KEY` repo secret is configured
(and skips silently when it's absent or the diff is docs-only), and a
path-filtered **Playwright e2e job** runs the browser suite whenever UI-facing
files change — advisory for now, promoted to required once it has a stable
track record. All workflows run least-privilege (`contents: read`) with
concurrency groups.

> The e2e suite is deterministic without a local LLM: `playwright.config.ts`
> pins the drafting model at a dead port so the create modal always falls to
> its manual form.

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
