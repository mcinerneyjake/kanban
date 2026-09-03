# CLAUDE.md archive — board, tickets & testing

> **Archive — a record, not instructions.** This is prose lifted verbatim out of kanban's
> `CLAUDE.md` when that file was trimmed (`tkt-755358e09d94`, from commit `efcaea4`). It is kept
> because the incidents that paid for each rule are worth finding again, not because it governs
> anything. **`CLAUDE.md` is the only instruction file; where the two disagree, `CLAUDE.md` wins**,
> and nothing here should be read as still-current external state. Regenerate or diff against the
> source with `git show efcaea4:CLAUDE.md`.


---

## MCP server

The kanban MCP server is wired in `.mcp.json` at the project root (project scope) and auto-starts with the project. It exposes `list_tickets`, `get_ticket`, `start_ticket`, `create_ticket`, `update_ticket`, and `delete_ticket`. Always prefer these tools over file-grepping or helper scripts. The server is **auto-enabled** via `enabledMcpjsonServers: ["kanban"]` in `.claude/settings.json` (no trust prompt), and the five non-destructive tools are allowlisted there so they run **without permission prompts** (`delete_ticket` is intentionally left to prompt; `create_ticket`, though allowlisted, is now **blocked at runtime by the `guard-ticket` hook** — new-ticket authoring is delegated to the local agent, see **Ticket creation flow**). If the tools are not available in a session, check that `.mcp.json` has the `kanban` entry and restart the session — MCP servers load at startup and are not hot-reloaded. **When restarting isn't an option (mid-ticket, or the server disconnected under you), use `npm run ticket` — see [MCP unavailable: the `npm run ticket` fallback](#mcp-unavailable-the-npm-run-ticket-fallback).** Note: MCP server **definitions** in `.claude/settings.json` are ignored — that file does not support an `mcpServers` key (it does support `enabledMcpjsonServers`, which enables servers defined in `.mcp.json`).

**This board is the central board for every repo (as of 2026-07-16).** The kanban ticket engine was extracted into the standalone **`ticket-workflow`** package (epic `tkt-fad0d18e2d35`), and a machine-local **user-scope** `kanban` MCP server (in `~/.claude.json`, pointed here via `BOARD_DIR_OVERRIDE`) plus a global `track-steps` hook let *any* repo drive this board and record pipeline milestones to it. In *this* repo the project-scope server above wins (local > user scope; same board), so nothing here changes. Two env vars, two jobs — don't confuse them: **`BOARD_DIR_OVERRIDE`** sets the *board root* and is read by the `ticket-workflow` package (`paths.ts`, and its `track-steps` hook), which resolves `BOARD_DIR_OVERRIDE ?? CLAUDE_PROJECT_DIR ?? cwd` and then appends `tickets/`/`events/` — that's the one the user-scope server points here with. **`TICKETS_DIR_OVERRIDE`** (plus `EVENTS_DIR_OVERRIDE`) overrides just that one directory and takes priority over the board root; it's what tests use to redirect file I/O to a temp dir. Two more things to know: (1) the global `track-steps` hook is now the **only** pipeline writer — this repo deliberately wires no `PostToolUse` hook, and `.claude/settings.audit.test.mjs` fails if one returns. Guards are per-repo (duplicates decide identically, so they are harmless); **writers are per-machine**, and a second writer double-logs every milestone — it produced 1,889 duplicate event rows between 2026-07-17 and 08-13 (`tkt-af4669ce9a0d`). The consequence to know: the writer lives only in machine-local files (`~/.claude/settings.json` → `~/.claude/bin/track-steps-central.sh`), so a fresh clone on another machine, a container, or CI records **no** milestones at all, and nothing in the repo can detect that; (2) `list_tickets` returns an envelope `{ total, returned, omitted, unreadable, tickets, note? }`, capped at a default `limit` of **100** and **excluding `archived` by default** (pass `status: archived` to see archived); when the cap truncates, `note` reports how many were omitted. Narrow with `status=`/`project=`/`query=` or raise `limit` to see more — the raw board is 400+ tickets, so an unfiltered call is paged, not truncated silently (`tkt-d6fb2ce5c780`, shipped in ticket-workflow v0.3.0). **`unreadable` is the one field to read before trusting a count**: it names ticket *files* whose frontmatter wouldn't parse. They are skipped so one corrupt file can't take the board down, but they are absent from `total` too — so a non-empty `unreadable` means the board is bigger than every number in the envelope. It is board-wide and never filtered by `status`/`project`/`query`. `GET /api/tickets` carries `unreadable` too, plus **two telemetry-side counts** — `{ tickets, unreadable, eventsSkipped, eventsUnreadable }` — and the web board renders a banner for each (`tkt-6cd916608a2f`, ticket-workflow v0.6.0; `tkt-3d6039df4076`). The telemetry pair covers the completion join, not the whole board: only done/archived tickets have their event logs read. **`eventsSkipped`** counts lines lost from a log that *was* read; **`eventsUnreadable`** counts logs that could not be read at all — kept apart because zero lines read means zero lines lost, so one count alone reports total loss as a healthy board. A non-zero either way means a `completedAt` may be missing, or stale, on a ticket that does have one. Architecture record: memory `project_ticket_workflow_boards` and epic `tkt-fad0d18e2d35`, which carries its own "Premise corrected 2026-07-16" banner. **Deliberately not a plan doc:** this used to cite one under `~/.claude/plans/`, which had been deleted — that directory is scratch space, not durable storage, so never make it the record of a design decision (`tkt-c24ee6233c25`). The epic body still carries two such dead refs and says so.

## Ticket workflow

This project has a kanban MCP server. When asked to work on a ticket:

1. Call `list_tickets` to find it by title match
2. Call `start_ticket` to set `status: "in-progress"` before starting (preferred over `update_ticket` for this — it marks and loads in one call), then cut the ticket's branch (see **Branch, commit & PR workflow → 1. Branch**)
3. Implement the work described in the ticket's `body`. **For feature and bug tickets, first add a `## Done when` acceptance list** to the body via `update_ticket`'s `appendBody` (the non-destructive append — never a full-body `body` overwrite) — a short bullet list of observable, checkable outcomes that define the ticket's exit condition (e.g. "CSV export succeeds on an empty-rows file; no unhandled exception"). Defining it here, once the work is understood, gives an unambiguous target and a per-ticket complement to the global Definition of Done. Chores and docs-only tickets may omit it.
4. **Test coverage** — after implementing, explicitly evaluate what layers were touched and act accordingly (see Testing section below for rules). This step is mandatory; do not skip it silently.
5. **Quality gate** — run `npm run typecheck`, `npm run lint`, and `npm test`. All three must pass before the ticket can be marked done. (Docs-only tickets that touch no code may skip the gate; state that in the summary.) **Then the mutation check** (`tkt-6d0d8a0fe2d2`), for feature/task tickets adding or changing logic in a layer the Testing table covers **plus the `.claude` settings/hooks layer** — UI/CSS-only, docs and chores skip; bug tickets already satisfy it via the red repro, seam tickets via the round-trip test: name the diff's **authorizing line** — the guard/branch that authorizes the new behavior (per `~/.claude/CLAUDE.md`, "rarely the behaviour you were testing"), never the happy-path line. Run the narrowest test selection that should catch it and see it **green** (the positive control — without it a flake-red records a false "caught"), flip the line, see **red**, revert, confirm the tree is clean. A mutation the suite does not catch indicts the mutation first (verify it applied), then the suite — a real suite miss means the tests never bound to the code, which is exactly what this step exists to surface. If only e2e covers the line, record `mutation: none catchable — <reason>` rather than bending an acceptance criterion to fit. Honor-system, like the red-first rule: authoring order is unobservable and nothing enforces this — do not report it as enforced. Relatedly, the first `## Done when` item must be falsifiable by *some* test; if none could ever falsify it, fix the Done-when (an observability check, not the mutation binding).
6. **Self-review** — for non-trivial tickets, read your own diff at the manual-review pause, and run `/verify` when runtime behavior should be confirmed. **The `/code-review` itself is the review gate and belongs at the commit gate, not here** — see **Branch, commit & PR workflow**, which is the single place that describes it; raising it twice is how it ends up half-done in both. Address findings before continuing. The ticket **stays `in-progress`** through self-review and commit — it moves to `qa` only when the PR opens (the single `qa` trigger; see **Branch, commit & PR workflow → 3. PR**). This keeps the status flow in-step with the tracker pipeline (`… Review · Commit · PR · QA · Done`). Trivial or docs-only tickets may skip self-review and proceed to step 7.
7. Append an `## Implementation summary` to the ticket body via `update_ticket`'s `appendBody` (the non-destructive append — never a full-body `body` overwrite). Do **not** set `status: "done"` yet — that happens after the PR merges (see **Branch, commit & PR workflow → 4. Merge**).

The implementation summary **must** include a test line — either:
- `Tests: N added — <brief description of what they cover>`
- `Tests: none — <reason, e.g. "pure UI change" or "no new logic">`
- Bug tickets record the red-first repro inline (see **Testing → Bug tickets (failing repro first)**):
  `Tests: 1 added — <test name> (written first, observed red)`
- Feature/task tickets record the mutation check inline (see step 5), appended to the added-tests form:
  `; mutation: <file:line> flipped, observed red` — or `; mutation: none catchable — <reason>`.
  The marker `mutation: … observed red` is load-bearing: it makes adoption countable for the
  machine-wide promotion (`tkt-06b572e5f00e`), counted by `scripts/probe/adoption-markers.mjs`
  (see **Probe discipline**; the `none catchable` form is counted as its own category there — an
  escape-hatch user is an adopter, not a non-adopter). **Both markers must sit on the same
  physical line as `Tests:`** — the probe is line-anchored, so a wrapped continuation line
  silently doesn't count (this rule's own landing ticket got it wrong first and read 0). In
  ticket bodies, quote either marker's template only inside a code fence — the probe strips
  fences precisely so paperwork can never count as adoption.

It **must** also include a risk line stating blast radius + how to roll back — either:
- `Risk: <what could break + how to roll back, e.g. "touches the propose→apply seam; revert the squash commit and re-run the round-trip test">`
- `Risk: low — <why, e.g. "isolated docs edit, no runtime code">`

The risk line rides into the PR body with the rest of the summary (see **Branch, commit & PR workflow → 3. PR**), so a reviewer sees blast radius + rollback inline on every PR — no separate PR template needed.

### Definition of Done

A ticket is **Done** only when all of these hold (the gate is executable, not advisory):

- [ ] `npm run typecheck` passes — or N/A (docs-only, no code touched)
- [ ] `npm run lint` passes — or N/A (docs-only, no code touched)
- [ ] `npm test` passes, with tests added per the Testing table below — or an explicit skip reason
- [ ] Self-review completed for non-trivial tickets (status stays `in-progress`; `qa` is set at PR-open)
- [ ] **A `/code-review` ran before the commit and its findings are addressed** — the review gate, second of the four. Not enforced today, though it is enforceable — see **Branch, commit & PR workflow**
- [ ] For feature/bug tickets, a `## Done when` acceptance list was defined and every item holds
- [ ] The mutation check per **Ticket workflow step 5** ran — or its `none catchable` form was recorded. Step 5 is the single home for its scope and procedure (do not re-enumerate them here — a second copy is how the two drift). Honor-system, not enforced
- [ ] `## Implementation summary` appended to the ticket body, including the `Tests:` and `Risk:` lines
- [ ] Status transitioned to `done` via `update_ticket` **after PR merge**

## Testing

After every feature or bug-fix ticket, evaluate **each touched file independently** and write tests accordingly. Do not evaluate the ticket as a whole — a route ticket that also modifies a shared utility in `src/lib/` requires tests for both layers:

| Layer touched | Test file | Framework |
|---|---|---|
| `server/tickets.ts`, `server/events.ts`, `server/validation.ts`, `mcp/handlers.ts` (re-export shims) | **none** — covered upstream in `ticket-workflow` | — |
| `server/index.ts` (API routes) | `server/index.test.ts` | Vitest |
| `src/lib/` (shared utilities) | `src/lib/*.test.ts` next to the file | Vitest |
| React components / CSS only | skip | — |

> **Do not re-create local suites for the shims** (`tkt-6aa717c1c9ec` deleted 188 such cases, every one a strict subset of the package's). Upstream's gate runs against upstream *source at its HEAD*, never the tag `package.json` pins, and the published package ships no tests — so `server/packageContract.test.ts` asserts the **pinned build** through the shim. Add to that file when a bump could regress behaviour kanban relies on; it is deliberately narrow, covering only what no other kanban test asserts.
>
> `mcp/server.ts` is a thin transport-wiring entrypoint with no logic, so it needs no test.

Vitest patterns to follow:
- Use `TICKETS_DIR_OVERRIDE` to redirect file I/O to a temp directory — never touch the real `tickets/` folder
- Use `makeRaw` / `writeRaw` helpers to seed fixture files directly, avoiding round-trips through `createTicket`
- Cover: the happy path, edge cases (empty input, boundary values), and rejection cases (invalid input, missing resources)

**Skip tests only when the change is pure UI** (React components, CSS, no logic). All other changes — service functions, API routes, utility modules — require at least a happy-path test. State the skip reason explicitly in the implementation summary.

### Integration seams (end-to-end round-trip test) — MANDATORY for cross-module data flows

**Why seam bugs hide, and the round-trip + fidelity-invariant shape that catches them, are in `~/.claude/CLAUDE.md` → *Cross-module changes need one round-trip test*.** This section is the repo's binding instance of it (`tkt-d2267fb6bac4`), and here the rule is **MANDATORY**, not a default.

**This repo's seam** is `model proposal → proposalToPrefill → form → changedFormFields → createTicket/updateTicket → provenance`. Drive the *real* chain with this repo's stubs — a fake chat client plus `TICKETS_DIR_OVERRIDE`/`RUNS_DIR_OVERRIDE` — and write the round-trip test **first**, TDD-ing the feature or fix against it.

One reinforcement beyond the global rule (prefer it over piling on more test cases):
- **Review:** for integration-heavy PRs, run a **flow-scoped** review angle — "trace this value from source to sink; list every transformation or drop" — not only the default diff-scoped pass.

> **Why this rule exists:** the in-app intake feature shipped ~8 real bugs (silent no-op saves, update→duplicate-create misrouting, dropped agent-proposed fields, stripped provenance, untracked spend) that all lived in the propose→apply seam and survived a green unit suite + per-ticket reviews. They were built as separate tickets and reviewed diff-by-diff, so nothing exercised the whole path. See the agentic-rag-demo round-trip harness ticket (`tkt-345255727ffe`).

### Bug tickets (failing repro first) — MANDATORY

**The general rule is `~/.claude/CLAUDE.md` → *A passing test proves nothing until you know it can fail*.** That tenet stops at diagnosis — grep the tests and read the test *name*, because a green test may be pinning the very defect. This section is the repo's binding instance and carries it through to action: **write the failing reproduction first, watch it go red, then write the fix.**

**A repro that PASSES before the fix is the finding** — the test misses the defect. It does not mean the bug is absent.

**Scope.** Bug tickets touching a layer the Testing table covers. UI/CSS-only bugs are already skipped by that table, and a **seam bug is already covered by the round-trip rule above** — there the round-trip test *is* the repro. What this adds is single-module, non-UI bugs.

Record it on the existing `Tests:` line (see **Ticket workflow**) — there is no separate line and no extra Definition-of-Done box, because the `Risk:` line (the newest mandatory line) runs ~13 points below its control on post-rule summaries. The marker `written first, observed red` is load-bearing: it is what makes adoption countable for the machine-wide promotion (`tkt-a98723f627df`).

> **Honest limit:** nothing enforces this. Authoring order is unobservable, and `tickets/` is gitignored so CI can never read the `Tests:` line. It is honor-system prose, exactly like the seam rule above — do not report it as enforced.

When asked to create a ticket, **delegate authoring to the local intake agent** (below) — never call `create_ticket` yourself. When asked what's on the board or what's left to do, call `list_tickets`.

### Ticket creation flow (authored by the local LLM)

In **this repo's sessions**, every **new** ticket is authored by the local intake agent, **not Claude**, so its title/body/classification is written inside a **metered local-LLM run** and the ticket carries a real usage record (`tkt-2492e26a277a`). Claude calling `create_ticket` is **blocked by the `guard-ticket` PreToolUse hook** — an enforced gate, not honor-system (mirrors how `guard-bash` enforces the git workflow).

> **Scope of enforcement (best-effort, like `guard-bash` — not a sandbox):** the guard is wired at **user scope** (`~/.claude/settings.json`, matcher `mcp__kanban__create_ticket`) *and* project scope here, so it now guards the MCP tool in **every** repo a session touches — the "wire it at user scope" follow-up this section used to describe is done (`tkt-80e348e4ff22`, corrected in `tkt-05ebe3a365cf`). Two gaps remain, and neither is closed by that:
>
> 1. **It guards the tool, not the data.** `server/routes/tickets.ts` mounts `ticketsRouter.post('/', wrap(ctrl.create))`, and no `PreToolUse` hook ever sees an HTTP request — so `POST /api/tickets`, or any script calling the service layer directly, creates an un-metered ticket. Rejecting those server-side is the only thing that would close it, and is still genuinely follow-up work.
> 2. **The user-scope wiring is machine-local and unversioned.** A fresh clone on another machine, a container, or CI has **no** guard at all, and nothing in this repo can detect its absence — the same caveat as the `track-steps` writer and `guard-subagent-gates`. So "guarded everywhere" is true of *this machine*, not of this repository.
>
> The policy below is the honor-system default wherever the hook can't reach.

1. **Confirm the report once.** Restate the *substance* you're about to file in one line — not exact field values, since the agent classifies and words it — e.g. *"I'll have the local agent file a ticket for: the CSV export crashes on empty rows. Go?"*. Don't pre-negotiate type/priority/status/project; the agent decides them.
2. **Delegate to the agent.** On confirmation, run:
   ```bash
   npm run agent -- --yes --create-only "<the report, in the user's words plus any clarifying detail>"
   ```
   **ONE ISSUE PER RUN — this is the rule, not a preference.** A report covering several things gets
   **sprayed** into several thin tickets. This includes *enumeration inside prose*: "three rules have
   no test: X, Y and Z" is a list as far as the model is concerned, and produced three tickets on
   2026-07-26. Describe **one symptom**, and add any sub-parts yourself afterwards with
   `update_ticket`. For several findings, make several runs. Cleanup when it sprays anyway: repurpose
   one create and `delete_ticket` the rest.

   `tkt-dd22f37d1c60` hardened the runtime on both counts — the create-only prompt now says *prefer
   ONE ticket for the whole report* (it used to say the opposite), and a create-only run is
   hard-capped at **3 tickets created**. Neither replaces the rule above: the prompt is a bias on a
   local model, not a guarantee, and the cap stops a runaway without preventing a 2–3-way split.
   **The cap bounds tickets, not steps** — a blocked create still burns a loop step, so a model that
   keeps retrying past the limit can still exhaust the 8-step budget and end on *"did not finish
   within 8 steps"* instead of a summary naming ids. When the cap fires the CLI prints a
   `! N further create_ticket call(s) were blocked` line (deterministic — the model's own summary
   omits what it was blocked from filing). Seeing it means the report was too broad: re-file the
   remainder as separate single-issue runs rather than raising the cap.

   `--yes` auto-approves the write so the create happens **inside** the metered run (the run→ticket linkage the run log needs). `--create-only` drops `update_ticket` from the agent's toolset so a mis-matched retrieval can only ever create a **new** ticket — never overwrite an existing ticket's body (the interactive `npm run agent` path keeps the anti-duplicate update behavior). The agent authors title + body and classifies the four fields; if a related ticket exists it cites the id in the body rather than updating it. **Trade-off:** a retrieval miss yields a duplicate (non-destructive — delete/merge later), never a clobbered body.
3. **Report what landed.** After the run, state the resulting ticket **id + classified fields** (type/priority/status/project). The agent is *intake-tuned*, so an internal chore may land as `task`/`medium` or the wrong project — this gives the user a chance to correct any field via `update_ticket` (structured-field fixes stay Claude's). **Always `get_ticket` the result**: besides the classification, check for a *mis-matched related-id* (it cites plausible `tkt-…` refs that belong to other projects) and for a body that drifted off the report entirely, then fix it via `update_ticket`.
4. **Local model down → block, don't fall back.** If the agent exits non-zero (models unavailable) or `GET /api/intake/health` reports down, tell the user the local runtime is unavailable and **stop**. Do **not** author the ticket yourself via `create_ticket` — that creates an *untracked* ticket, defeating the metering (and the hook blocks it regardless).

**What stays Claude's, directly (no agent):**
- **Structured-field updates** (status, priority, type, project, parent, blockers, assignee, dueDate) → `update_ticket`. Routine status/priority moves don't pipe through the local LLM.
- **Body edits + the mandatory `## Implementation summary`** → `update_ticket`. The agent authors *intake from a report*; it can't summarize the work Claude just did, so summaries and directed body edits remain Claude's.
- **Delete** → `delete_ticket` (the agent's toolset excludes it; still prompts).


---

## MCP unavailable: the `npm run ticket` fallback

The MCP tools are the everyday path. But they load at session start and are **not hot-reloaded**, so if the `kanban` server disconnects mid-session, `update_ticket` is gone until the session restarts — which mid-ticket is often worse than the outage. `npm run ticket` (`scripts/ticket.ts`) is the sanctioned escape hatch: it wraps the same service layer the MCP handlers call.

```bash
npm run ticket -- set <id> <field> <value>   # status | type | priority | project | assignee | dueDate | parent
npm run ticket -- append <id> <file>         # append markdown to the body ("-" reads stdin)
npx ticket-workflow show <id>                # read a ticket (the package's own viewer)
```

- **Use it only when the MCP tools are actually unavailable.** It is a fallback, not a second everyday path — `update_ticket` stays the default so writes keep their provenance and the board stays the single interface.
- **`append` never overwrites.** It calls the service's `appendBody`, so the concatenation happens server-side, where a per-id lock orders it — so a stale read can't drop a concurrent edit. That lock is **in-process only**: this CLI, an MCP session and a worktree's dev server are separate processes over one `tickets/`, and nothing orders them against each other, so a full-body `body` write can still lose whichever edit lands first. Use `appendBody` regardless. An overwrite is no longer *unrecoverable* — since `tkt-18d53c0c7cd8` a body-changing write first snapshots the prior full file (frontmatter + body) to `tickets/.history/<id>/<timestamp>-<rand>.md` — but treat that as an undo you may not have: recovery is manual (no restore UI), the snapshot is best-effort (a failure is logged and the edit proceeds), and it does **not** survive `delete_ticket`, which unlinks the ticket without one. Canonical description: ticket-workflow's README → *Backup-on-write / recovery*; asserted against the pin in `server/packageContract.test.ts`.
- **No `create`, no `delete`.** New-ticket authoring stays with the metered local agent (see **Ticket creation flow**) and deletion stays a prompted MCP call. The CLI can only move fields and grow bodies.
- It resolves the board the same way everything else does (`BOARD_DIR_OVERRIDE ?? CLAUDE_PROJECT_DIR ?? cwd`), so another repo's session reaches the central board by running it from this directory.


---

## Project structure

- `server/tickets.ts` — service layer (CRUD on markdown files, single source of truth)
- `server/index.ts` — Express routes (thin, delegates to service)
- `src/` — React frontend
- `tickets/` — one `.md` file per ticket (frontmatter + markdown body)
- `shared/constants.ts` — enum values for status, type, priority
- `shared/ports.ts` — dev API/Vite ports derived from one `KANBAN_PORT_OFFSET` knob (see **Concurrent sessions**); imported by `vite.config.ts` and `server/index.ts` so the two can never disagree
- `shared/terminalSeed.mjs` — single source of truth for the embedded terminal's seed/session paths **and** setup-token validation, shared by `server/terminalHome.ts`, `scripts/preflight-dev.mjs`, `scripts/preflight-lib.mjs` and `scripts/terminal-setup-cred.mjs`. It stays `.mjs` with a hand-written `terminalSeed.d.mts` **because the setup scripts run under bare `node` and cannot import TypeScript** — do not "fix" it into a `.ts` (`tkt-812b2b71acbe`, `tkt-bfb3bc9f98d4`).
- `mcp/handlers.ts` — MCP tool definitions + dispatch logic (the testable core)
- `mcp/server.ts` — thin MCP entrypoint: wires the handlers to a stdio transport
- `agent/` — local-first agentic-RAG intake agent (retrieval, tools, tool-use loop, CLI); talks to an OpenAI-compatible `/v1` endpoint
- `.claude/skills/kanban-workflow/` — the `/kanban-workflow` ticket-cycle skill (`tkt-e18d0c20d6b6`). **Project-scoped**: Claude Code discovers `<projectDir>/.claude/skills` in sessions rooted here, so this copy serves kanban sessions. `SKILL.md` is tracked and must stay free of absolute paths; the project→repo map lives beside it in **gitignored** `repos.local.json`, seeded from the tracked `repos.example.json`. `repoHygiene.test.mjs` fails the suite if a home path naming a real account, or any unexpected tracked file, reaches the **index** — it does *not* check project names, which stay convention. A fresh clone gets the skill but not the map, and the skill stops and names the file rather than reporting an empty project list.

  `skillContract.test.mjs` (repo root) parses **both `SKILL.md` and this file** and fails the suite when one of the **five** bindings below drifts — some against an allowlist the test carries, others against a value it derives or a shape it requires. Read the live set off the `it` cases in that file's *one* real-file `describe` block; the list here is a summary and can go stale, which is the reason for the pointer.

  It bound **seven** surfaces until `tkt-5a4ff25d4e74` cut it from 1,604 lines / 124 tests to 805 / 46 on 2026-08-27. The rule the cut applied — **keep the bindings whose drift would be silent, drop the ones a run stops or degrades visibly on** — is this file's own trim safety rule, and `docs/skillContract-dropped-assertions.md` records what went (§0's ticket-id argument surface, §15's per-ticket-type close table, and the **handoff** half of the ticket slot), with the reason and the restore path for each. **Read that before re-adding one**, and before reading a dropped binding's absence as an oversight — it also records the two bindings the first cut wrongly dropped and a review restored, which is the more useful warning.

  - **§11–13's gate table** — its columns and every cell's value, against a per-gate allowlist. The structural half of both the review gate and "merge is human in every mode" (`tkt-abaff4ebd8b3`). Bound to the heading *word* `gates`, not to the number, so renaming that heading breaks it and renumbering it does not.
  - **§0's gate-level menu** (`tkt-34f8a4b467e7`) — it must offer every level the `--gates` flag accepts, describe each, and carry exactly one `(Recommended)`, on the level that asks at every gate and listed first. Two recommendations count as none.
  - **§10's post-review table** (`tkt-32f7c384bcad`) — the checks a run owes before `record_review` are rows there, and the `when it cannot be confirmed` column is matched **exactly**, with no normalization in front of the allowlist — so dropping the **scope** row, bolting an exemption onto a row name, qualifying a cell into a conditional, or hiding the table in a fence all redden the suite. The exact match is not fastidiousness: with the gate table's normalization in front, `**scope** (skip in foreign mode)` measured clean. That is the *detection* half of the wrong-repo fail-open (an empty finding list from a review that never saw your diff is indistinguishable from a clean one); naming the target repo at the commit gate is the *prevention* half and stays honor-system prose.
  - **The startup recommendation** in this file's **Session startup** section, bound to §15's close handoff (`tkt-9fbe6c952590`) — both must carry exactly one invocation, name the same skill, and pass the same `--gates` level; that level is **derived** from the gate table via `safestLevels`, never named in the test, so a prompt pre-filling an auto level reddens the suite even when *both* files agree on it. The "exactly one" half is what stops a second worked example landing in either section.
  - **The startup line carries NO ticket slot** (`tkt-71229c9290b8`) — the half of the slot binding that survives, because it is the half that fails silently. A **valid** `tkt-…` pasted into the startup invocation passes §5's premise validation, and §0's named-ticket path then skips §4's ranking, so every session opened from that prompt works a ticket nobody chose. The handoff's own slot check was dropped: losing it costs one re-ranking, visibly.

  **What none of it asserts.** It binds the two *files*, never that a run obeys a table and never that a session prints either line. It also does not check that `<project>` was substituted (prose in both files; a word-grep for it would be the ~2%-precision assertion-word probe).

  > **The user-scope duplicate was deleted 2026-08-18** (`tkt-9a3afc5b9f4f`). It was kept while the skill refused a foreign repo; **foreign-repo mode replaces that capability** — §1 resolves native vs foreign and drives another repo from a kanban session via §2a's `cd <target> && …` form, so non-kanban work no longer needs a session in that repo. One thing the deletion settled: **user scope won while both existed** (measured — a `/kanban-workflow` invocation loaded with `Base directory: ~/.claude/skills/kanban-workflow` and carried that copy's text verbatim), so the earlier "which one wins is unverified" is answered, and the answer was the *unversioned* one — a change to the tracked file would have been inert. That is why a second copy was never a harmless duplicate. **The tracked copy does load — measured 2026-08-18** (`tkt-9fbe6c952590`), closing what this paragraph previously recorded as an inference. The probe it named was run and matched: a `/kanban-workflow` invocation in a kanban session reported its base directory as this repo's `.claude/skills/kanban-workflow`, not the user-scope path — so project-scope pickup is observed, and a change to the tracked file reaches real runs. The absolute path it printed is deliberately **not** quoted here: `repoHygiene.test.mjs` fails the suite on a home path in a tracked file, which is why this reads like the success criterion rather than a transcript. Re-run that same probe if the skill ever appears not to load; `ls ~/.claude/skills/kanban-workflow` answers only whether the duplicate is gone, not which copy wins — do not read it as the same thing. A session rooted in a non-kanban repo now has no copy at all, which is intended: drive those from here in foreign mode.

