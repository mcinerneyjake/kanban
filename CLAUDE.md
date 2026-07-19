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

The kanban MCP server is wired in `.mcp.json` at the project root (project scope) and auto-starts with the project. It exposes `list_tickets`, `get_ticket`, `start_ticket`, `create_ticket`, `update_ticket`, and `delete_ticket`. Always prefer these tools over file-grepping or helper scripts. The server is **auto-enabled** via `enabledMcpjsonServers: ["kanban"]` in `.claude/settings.json` (no trust prompt), and the five non-destructive tools are allowlisted there so they run **without permission prompts** (`delete_ticket` is intentionally left to prompt; `create_ticket`, though allowlisted, is now **blocked at runtime by the `guard-ticket` hook** — new-ticket authoring is delegated to the local agent, see **Ticket creation flow**). If the tools are not available in a session, check that `.mcp.json` has the `kanban` entry and restart the session — MCP servers load at startup and are not hot-reloaded. Note: MCP server **definitions** in `.claude/settings.json` are ignored — that file does not support an `mcpServers` key (it does support `enabledMcpjsonServers`, which enables servers defined in `.mcp.json`).

**This board is the central board for every repo (as of 2026-07-16).** The kanban ticket engine was extracted into the standalone **`ticket-workflow`** package (epic `tkt-fad0d18e2d35`), and a machine-local **user-scope** `kanban` MCP server (in `~/.claude.json`, pointed here via `BOARD_DIR_OVERRIDE`) plus a global `track-steps` hook let *any* repo drive this board and record pipeline milestones to it. In *this* repo the project-scope server above wins (local > user scope; same board), so nothing here changes. Two things to know: (1) the global `track-steps` hook double-logs events alongside this repo's project `track-steps` — harmless (reducer is last-write-wins; cleanup `tkt-af4669ce9a0d`); (2) `list_tickets` returns the whole board, which now overflows the tool-output cap (400+ tickets) — **filter with `status=`/`project=`** until `tkt-d6fb2ce5c780` adds a limit. Architecture record: memory `project-ticket-workflow-boards`, plan `~/.claude/plans/polymorphic-bubbling-diffie.md`.

## Ticket workflow

This project has a kanban MCP server. When asked to work on a ticket:

1. Call `list_tickets` to find it by title match
2. Call `start_ticket` to set `status: "in-progress"` before starting (preferred over `update_ticket` for this — it marks and loads in one call), then cut the ticket's branch (see **Branch, commit & PR workflow → 1. Branch**)
3. Implement the work described in the ticket's `body`
4. **Test coverage** — after implementing, explicitly evaluate what layers were touched and act accordingly (see Testing section below for rules). This step is mandatory; do not skip it silently.
5. **Quality gate** — run `npm run typecheck`, `npm run lint`, and `npm test`. All three must pass before the ticket can be marked done. (Docs-only tickets that touch no code may skip the gate; state that in the summary.)
6. **Self-review** — for non-trivial tickets, at the manual-review pause **ask whether the user wants a `/code-review`** (run it only if they opt in — it costs tokens — plus `/verify` when runtime behavior should be confirmed). Address findings before continuing. The ticket **stays `in-progress`** through self-review and commit — it moves to `qa` only when the PR opens (the single `qa` trigger; see **Branch, commit & PR workflow → 3. PR**). This keeps the status flow in-step with the tracker pipeline (`… Review · Commit · PR · QA · Done`). Trivial or docs-only tickets may skip self-review and proceed to step 7.
7. Append an `## Implementation summary` to the ticket body via `update_ticket`. Do **not** set `status: "done"` yet — that happens after the PR merges (see **Branch, commit & PR workflow → 4. Merge**).

The implementation summary **must** include a test line — either:
- `Tests: N added — <brief description of what they cover>`
- `Tests: none — <reason, e.g. "pure UI change" or "no new logic">`

### Definition of Done

A ticket is **Done** only when all of these hold (the gate is executable, not advisory):

- [ ] `npm run typecheck` passes — or N/A (docs-only, no code touched)
- [ ] `npm run lint` passes — or N/A (docs-only, no code touched)
- [ ] `npm test` passes, with tests added per the Testing table below — or an explicit skip reason
- [ ] Self-review completed for non-trivial tickets (status stays `in-progress`; `qa` is set at PR-open)
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

### Integration seams (end-to-end round-trip test) — MANDATORY for cross-module data flows

The per-file table above catches per-**layer** regressions but **misses seam bugs** — defects in the *handoff* between modules, where a value is silently dropped, mangled, or misrouted as it crosses a boundary. These hide from isolated unit tests (every layer passes green) **and** from diff-scoped review (no single diff owns the whole path).

**Rule:** when a change threads data across **≥2 modules** — e.g. `model proposal → proposalToPrefill → form → changedFormFields → createTicket/updateTicket → provenance` — add (or extend) **one end-to-end round-trip test** that drives the *real* chain with stubbed I/O (a fake chat client, `TICKETS_DIR_OVERRIDE`/`RUNS_DIR_OVERRIDE`) and asserts **source input == persisted output** across the full path. Include a **fidelity invariant**: for a valid input `P`, `apply(P)` yields a result whose fields equal `P` (modulo server-forced defaults) — asserting "no field silently dropped/mangled at the boundary" as a *class*, not case-by-case. Write the round-trip test **first** and TDD the feature/fix against it.

Two reinforcements that make the seam load-bearing (prefer these over piling on more test cases):
- **Types:** make a cross-layer mapping/DTO the *full* field set (or force an explicit, commented exclusion) so adding a field upstream fails to **compile** until the mapping handles it; derive shared validation sets (e.g. create-valid statuses) from **one** constant used on both sides.
- **Review:** for integration-heavy PRs, run a **flow-scoped** review angle — "trace this value from source to sink; list every transformation or drop" — not only the default diff-scoped pass.

> **Why this rule exists:** the in-app intake feature shipped ~8 real bugs (silent no-op saves, update→duplicate-create misrouting, dropped agent-proposed fields, stripped provenance, untracked spend) that all lived in the propose→apply seam and survived a green unit suite + per-ticket reviews. They were built as separate tickets and reviewed diff-by-diff, so nothing exercised the whole path. See the agentic-rag-demo round-trip harness ticket (`tkt-345255727ffe`).

When asked to create a ticket, **delegate authoring to the local intake agent** (below) — never call `create_ticket` yourself. When asked what's on the board or what's left to do, call `list_tickets`.

### Ticket creation flow (authored by the local LLM)

In **this repo's sessions**, every **new** ticket is authored by the local intake agent, **not Claude**, so its title/body/classification is written inside a **metered local-LLM run** and the ticket carries a real usage record (`tkt-2492e26a277a`). Claude calling `create_ticket` is **blocked by the `guard-ticket` PreToolUse hook** — an enforced gate, not honor-system (mirrors how `guard-bash` enforces the git workflow).

> **Scope of enforcement (best-effort, like `guard-bash` — not a sandbox):** the hook is wired in *this* repo's project-scope `.claude/settings.json`, so it only guards sessions run here, and it guards only the **MCP tool**. A session in another repo driving the same central board via the user-scope `kanban` server (see the MCP-server section) isn't guarded, and a direct `POST /api/tickets` or a service-layer `createTicket` script would bypass it. Closing those (wiring the guard at user scope; rejecting un-metered creates server-side) is follow-up work — the policy below is the honor-system default where the hook can't reach.

1. **Confirm the report once.** Restate the *substance* you're about to file in one line — not exact field values, since the agent classifies and words it — e.g. *"I'll have the local agent file a ticket for: the CSV export crashes on empty rows. Go?"*. Don't pre-negotiate type/priority/status/project; the agent decides them.
2. **Delegate to the agent.** On confirmation, run:
   ```bash
   npm run agent -- --yes --create-only "<the report, in the user's words plus any clarifying detail>"
   ```
   `--yes` auto-approves the write so the create happens **inside** the metered run (the run→ticket linkage the run log needs). `--create-only` drops `update_ticket` from the agent's toolset so a mis-matched retrieval can only ever create a **new** ticket — never overwrite an existing ticket's body (the interactive `npm run agent` path keeps the anti-duplicate update behavior). The agent authors title + body and classifies the four fields; if a related ticket exists it cites the id in the body rather than updating it. **Trade-off:** a retrieval miss yields a duplicate (non-destructive — delete/merge later), never a clobbered body.
3. **Report what landed.** After the run, state the resulting ticket **id + classified fields** (type/priority/status/project). The agent is *intake-tuned*, so an internal chore may land as `task`/`medium` or the wrong project — this gives the user a chance to correct any field via `update_ticket` (structured-field fixes stay Claude's). Under `--create-only` the agent can't update, so it always creates — but it may still merge several issues from one report into a **single** create; when you handed it multiple distinct findings, confirm each got its own ticket and flag any that looks dropped.
4. **Local model down → block, don't fall back.** If the agent exits non-zero (models unavailable) or `GET /api/intake/health` reports down, tell the user the local runtime is unavailable and **stop**. Do **not** author the ticket yourself via `create_ticket` — that creates an *untracked* ticket, defeating the metering (and the hook blocks it regardless).

**What stays Claude's, directly (no agent):**
- **Structured-field updates** (status, priority, type, project, parent, blockers, assignee, dueDate) → `update_ticket`. Routine status/priority moves don't pipe through the local LLM.
- **Body edits + the mandatory `## Implementation summary`** → `update_ticket`. The agent authors *intake from a report*; it can't summarize the work Claude just did, so summaries and directed body edits remain Claude's.
- **Delete** → `delete_ticket` (the agent's toolset excludes it; still prompts).

## Branch, commit & PR workflow

Every ticket lands on its own branch and merges to `main` via a **squash-merged PR** — never a direct push to `main`. There are three human-approval gates: **"Ready to commit?"**, **"Ready to open PR?"**, **"Ready to merge?"**. Never cross a gate without explicit confirmation.

> **Enforced locally:** a PreToolUse hook (`.claude/hooks/guard-bash.mjs`, wired in `.claude/settings.json`) blocks `git add -A`/`--all`/`.`, commits on `main`, and pushes to `main` before they run — these rules are no longer honor-system. (GitHub branch protection backstops the same at merge time — see the end of this section.)

### Permissions (prompt-free workflow)

The workflow commands run **prompt-free**: `.claude/settings.json` allowlists the non-destructive MCP tools (`list_tickets`, `get_ticket`, `start_ticket`, `create_ticket`, `update_ticket`) and the workflow shell commands. Safety is **layered**, not a function of the allowlist alone:

- **git rules are intentionally broad** (`git add`/`commit`/`push`/…) but safe because the **`guard-bash` hook** inspects each actual command and blocks the dangerous shapes — `git add -A`/`-f`, `commit -a`, commits/pushes to `main`, force-push, `branch -D`, `reset --hard`, `clean -f`, `checkout -f` (proven by `guard-bash.test.mjs`).
- **`gh`/`npm`/`npx` rules have no such runtime hook**, so they are pinned to **specific subcommands** (`npm run lint`, `gh pr merge`, `npx vitest run *`, …) — never a wildcarded subcommand like `npm run *`.
- **`delete_ticket` and destructive shapes stay excluded** — they still prompt.
- **`create_ticket` is allowlisted but blocked at runtime by the `guard-ticket` hook** — ticket authoring is delegated to the local agent (see **Ticket creation flow**), parallel to the broad git rules being `guard-bash`-backed. The allow entry only avoids a re-prompt if that policy is ever relaxed; the hook is the real gate.

`.claude/settings.audit.test.mjs` enforces this in the gate: it pins the non-git allows to a reviewed set, rejects explicit dangerous tokens, keeps `delete_ticket` gated, and asserts both the `guard-bash` and `guard-ticket` backstops are wired — **failing CI** if any of those drift. (It does not — and cannot — prove a broad git glob is safe at runtime; that is the hook's job, which is why the two are coupled.)

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

Ask **"Ready to commit?"** — do not commit until confirmed. At this gate, also **offer a `/code-review`** (run it only if the user opts in — it costs tokens — and address findings before committing). Then:

1. `git add` only the files changed for this ticket (never `git add -A` — the `guard-bash` hook blocks it).
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

The PR body must reference the ticket id and include the `## Implementation summary`. CI (`.github/workflows/ci.yml`) runs the same gate (typecheck + lint + test) on the PR — it must be green before merge. A second check (`.github/workflows/pr-branch-name.yml`) fails the PR if the head branch doesn't match `<type>/<id>-<slug>`. A fourth workflow (`.github/workflows/e2e.yml`, added 2026-07-02) runs the Playwright suite path-filtered to UI-touching changes (`src/**`, `e2e/**`, `playwright.config.ts`) — it is **advisory** (not in the ruleset) until it earns a stable track record, then gets promoted to required.

**Branch protection:** `main` is protected by a GitHub ruleset that enforces the three **required** CI checks (`gate`, `branch-name`, `review`) and requires a PR — direct pushes are blocked at the GitHub level. (`e2e` reports on the PR but does not yet block merge.)

When the PR opens, call `update_ticket` to set `status: "qa"` — **this is the single point where a ticket enters `qa`** (self-review no longer sets it; the ticket was `in-progress` through commit). It stays in `qa` until the merge step. The `code-review` CI job also runs automatically and posts its findings as a PR comment.

### 4. Merge (after CI is green)

Before asking **"Ready to merge?"**, check the code review comment posted to the PR by the `code-review` CI job:

```bash
gh pr view <number> --comments
```

If there are significant findings, present them to the user and ask: **"Fix these in the current PR, or create follow-up tickets?"**
- **Fix now** — implement, commit, push; wait for CI to go green again, then return to this step
- **Follow-up tickets** — file each finding via the local agent (`npm run agent -- --yes --create-only "<finding>"`, per **Ticket creation flow**), then proceed to merge. If the local runtime is down, say so and let the user decide (fix-now, or hold the merge until it's back) — don't hand-author the ticket.

If the review found no significant issues (or the secret wasn't configured), proceed directly.

Ask **"Ready to merge?"** — never merge without explicit approval. Then:

```bash
gh pr merge --squash --delete-branch
git switch main && git pull
```

No `--admin` needed: the `main` rulesets require the `gate` / `branch-name` / `review` checks but **0 approvals**, so a normal squash-merge lands once CI is green (a red check still blocks it).

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
- `agent/` — local-first agentic-RAG intake agent (retrieval, tools, tool-use loop, CLI); talks to an OpenAI-compatible `/v1` endpoint

## LLM & agent philosophy (local-first)

This project's agent (`agent/`) is **local-first by default and local-only in practice.** It talks to an OpenAI-compatible `/v1` endpoint (LM Studio, llama.cpp, Ollama) running a local model — no cloud API key, runs air-gapped. This is a deliberate product stance (privacy/residency for untrusted operational intake, zero per-call cost, offline demoability), not a stopgap.

- **Default to local.** When building or extending agent features, target the local `/v1` seam (`LLM_BASE_URL` / `LLM_MODEL`). Do **not** reach for the Anthropic SDK, push a cloud deployment, or invoke the `claude-api` skill unless the user explicitly asks for the cloud path.
- **Cloud is a swappable option, not the goal.** The provider seam is config-driven, so a cloud driver could drop in behind it — but the Anthropic chat driver was evaluated and dropped (`tkt-29788d084c21` archived). The one Anthropic integration that remains is the CI `code-review` job; leave it as-is.
- **Cost is measured, not estimated.** Observability uses a pluggable cost model: locally that's measured **energy** ($ from kWh × regional rate), with the per-token API-price model left as a dormant seam (see `tkt-88b47600d94c`).

## TypeScript conventions

These are **lint-enforced** (`eslint.config.js`): `consistent-type-assertions` (`assertionStyle: never`, so `as const` stays allowed), `no-non-null-assertion`, and `no-explicit-any`. A violation fails `npm run lint` — the gate, not just the docs.

- **No type casting** (`as Foo`, `as string`, `as any`). Use type predicates (`(x): x is string => Boolean(x)`), proper generics, or fix the upstream type instead.
- **No non-null assertions** (`foo!`, `bar!.baz`). Restructure so TypeScript can narrow the type itself — e.g. check `if (foo && bar)` at the closure level so the truthy branch carries the narrowed type.
- **No `any` or `unknown` in your own types.** Define concrete interfaces at external boundaries (library data, API responses). Let TypeScript infer types where possible; use type predicates to narrow instead of widening to `any`/`unknown`.

## Comment philosophy

Comments are sparse. Keep only a non-obvious *why*: invariants, security/concurrency/atomicity decisions, gotchas, and ticket refs that add traceability — as terse one-liners, not per-function prose headers. Delete anything that restates the *what* the code already says.

- **Exempt (keep):** directives (`/* v8 ignore */`, `@ts-expect-error`, the `vite/client` reference) and the "commented exclusion" pattern that documents a deliberate cross-layer field omission (see **Integration seams**).
- **Tests:** trim verbose "why this test exists" headers, but keep bug-ticket refs (`// tkt-… (Bug X, FIXED)`) and terse assertion glosses (`// counted once`).

This **supersedes** any instinct to match the codebase's former high comment density — do not re-add narration when editing existing files.

## Probe discipline

When you need a fact you can't read directly — a repo's commit count, a PDF's text, a server's state — you write a probe (a regex, a grep flag, a script, an inference). **A broken probe fails silently and confidently: it returns a plausible value, so "I couldn't measure this" and "here's the answer" are the same output.** That produced ~12 confident false results in one 2026-07-15 session, including a case-sensitive `git log --grep` that undercounted AI-co-authored commits 3× and nearly got a *true* resume claim weakened (`tkt-ceebed633013`). Same shape as the fail-open guard and the transcribed trace — see memory `feedback_validate_probe_with_controls`.

- **A surprising result is a hypothesis about the instrument, not a finding.** A 3× discrepancy or "every string absent" is the tell that the probe is broken — chase the instrument first.
- **Prove the instrument with a control before reporting its output as fact.** Positive control: show it finds a known-present. Negative control (for any *absent* claim): show it doesn't match a known-absent. Purpose-built tools lie too (`git log --grep` is case-sensitive by default) — control them anyway.
- **Rank by consequence.** A probe whose result would *cause an action* (weaken a claim, delete a file) gets validated first, not the one that's easiest to run.
- **Recurring, code-shaped probes get a tested probe with a built-in control that fails loud** — the executable precedent is `scripts/probe/repo-stats.mjs` (+ `.test.mjs`): trailer-aware commit counting whose `assertInstruments` throws rather than return a false zero, and whose test watches the reconstructed broken probe go red. It is also the source for the published repo stats (never hand-transcribe them — see `feedback_generate_dont_transcribe`).

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
