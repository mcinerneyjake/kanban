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

## Concurrent sessions: one worktree each

Two sessions sharing one working tree is not safe — whichever stages a shared file first silently
absorbs the other's in-flight edits, and any commit lands on whatever branch the checkout happens to
be on, regardless of which session made it (`tkt-4b74943a319e`). **Give each concurrent session its
own git worktree.**

Use Claude Code's built-in support — do **not** hand-roll a convention. `EnterWorktree` creates
`.claude/worktrees/<name>` on a branch cut from a fresh `origin/main`; `ExitWorktree` removes it (and
auto-removes it if nothing changed). The Agent tool takes `isolation: "worktree"` for the same thing.
`.claude/worktrees/` is gitignored, so a worktree never shows up as untracked in the main checkout.

**Rename the branch before the first commit.** `EnterWorktree` prefixes `worktree-` and rewrites `/`
as `+`, so asking for `fix/tkt-abc123-slug` lands you on **`worktree-fix+tkt-abc123-slug`** — which
fails the required `branch-name` check when the PR opens. Fix it immediately after entering:
`git branch -m fix/tkt-abc123-slug` (`tkt-fb558add3a17`).

- **`node_modules` needs no handling** — *unless the ticket changes a dependency.* Worktrees are
  nested *inside* the repo, so Node's upward resolution finds the main checkout's `node_modules`:
  `npm run typecheck`/`lint`/`test` all run in a fresh worktree with no install. Don't symlink, don't
  install per tree. **Exception:** a ticket that bumps a dependency must `npm install` *in* the
  worktree — otherwise the suite resolves upward to the main checkout's old copy and proves nothing
  about the new one. The duplicate tree is gitignored and dies with the worktree.
- **Running two dev servers: set `KANBAN_PORT_OFFSET`.** `npm run dev` binds the API and Vite ports
  from `shared/ports.ts`; the offset shifts **both together** (`KANBAN_PORT_OFFSET=1` → API 3002, web
  5174), which is what keeps a worktree's UI talking to its *own* API. Vite runs `strictPort`, so a
  collision fails loudly instead of falling back to the next port and silently proxying to the other
  checkout's backend. `PORT` still overrides the API port outright.
- **Commits from a worktree run the full gate**, same as the main checkout — `.husky/pre-commit`
  scrubs git's exported repo context first, because git exports an *absolute* `GIT_DIR` in a worktree
  and inheriting it made the test suite drive the real repository (`tkt-cf1e0c0b3dda`).
- **`gh pr merge --delete-branch` errors from a worktree — and the merge still landed.** It fails
  with `fatal: 'main' is already used by worktree at …`, which is `gh`'s *local post-merge checkout*
  being refused because the primary worktree holds `main`. The remote merge is already complete; only
  the branch deletion and local sync were skipped. **Do not retry** — that runs against an
  already-merged PR. Confirm with `gh pr view <n> --json state` (expect `MERGED`), then
  `git push origin --delete <branch>` and `git pull --ff-only` in the *primary* checkout
  (`tkt-fb558add3a17`). **The local branch survives this, and nothing an agent can run will remove
  it**: a squash-merge leaves its commits non-ancestors of `main`, so `git branch -d` refuses, and
  `guard-bash` blocks `-D`. Measured 2026-08-11: 13 such branches had accumulated. Sweeping them is a
  human `-D`, and `gh pr view <n> --json state` returning `MERGED` is what makes it safe — the guard
  is right to block the agent, because "I already checked" is exactly the reasoning it exists to stop
  (`tkt-6321b5b79986`).
- **The embedded terminal is not isolated by this.** Its container mounts the *host* checkout, so an
  in-container `git switch` still moves the host branch — worktrees isolate Claude sessions, not
  terminal sessions.

## Branch, commit & PR workflow

Every ticket lands on its own branch and merges to `main` via a **squash-merged PR** — never a direct push to `main`. There are **four** human-approval gates, in this order:

| order | gate | crossing it requires |
|---|---|---|
| 1 | **commit gate** — *"Ready to commit?"* | explicit confirmation |
| 2 | **review gate** — the `/code-review`, raised at the commit gate and resolved *before* the commit | a review to have **run**, not merely been offered |
| 3 | **PR gate** — *"Ready to open PR?"* | explicit confirmation |
| 4 | **merge gate** — *"Ready to merge?"* | explicit confirmation |

They are referred to by **name**, not number, throughout — the numbers here are the ordering only. `### 1.`–`### 4.` below are *sections*, and the commit and review gates both live inside section **2. Commit**, so a bare "gate 2" would be ambiguous against this file's `**3. PR**`-style section references.

Never cross a gate without explicit confirmation. The review gate is the one that is easy to lose, because it is the only one whose absence looks like nothing having happened — so the rule is stated as a **precondition on the PR**, not as a question that may be answered "no": **do not open a PR, and never merge, until a `/code-review` has run for this ticket.** What is Jake's to decide is *when to spend the tokens*, not whether the review happens (`feedback_code_review_before_pr`; **who runs it** is mode-dependent — see the note below).

**Ask the gates with `AskUserQuestion`, not prose.** It makes each one a single tap on a phone, which is the whole point of `tkt-8b13323c2545`. Two constraints: it renders **2–4 options**, so a gate must offer a genuine alternative (*Hold — I want to look first*), never a lone OK button that only pretends to be a choice; and it changes how the question is **asked**, never whether approval is required — a typed reply is still a valid answer to any gate.

> **The review gate's ordering is deliberate and was corrected once — do not "fix" it back.** The review is resolved **before** the commit, not after it. Post-commit, a review misdirected at the wrong repo finds a plausible branch-vs-`main` diff and returns confident findings about code nobody asked about; pre-commit, the wrong repo has a clean tree, so the same mistake **finds nothing and says so**. Same defect, and only one version self-announces — the fail-open shape this repo rejects everywhere else. (`feedback_code_review_before_pr`, corrected 2026-08-12. The earlier post-commit ordering survives in `tkt-4584ee923550`'s original body and in that ticket's plan doc — both superseded, and the plan contradicts itself on this point, so it settles nothing.)
>
> **Who runs it depends on the mode — and the skill does not yet hold up its half.** By default Jake runs it himself. In the `/kanban-workflow` skill's `--gates auto-commit` / `--gates auto-pr`, he has pre-authorized the skill to run it, lifting only the "Jake personally" part. **But the skill does not currently implement that**: its gate table has three columns (commit / PR open / merge) with no review gate, and nothing in it invokes `/code-review`. Only the hard-stop-on-significant-finding half is present. So under `auto-pr` — `cross | cross | ask` — a run can reach an open PR with no review at all, which is the outcome this gate exists to prevent. Closing that is `tkt-abaff4ebd8b3`; until it lands, **treat the review gate as yours to cross manually in every mode.** **The skill is no longer machine-local** (`tkt-e18d0c20d6b6`): it lives at `.claude/skills/kanban-workflow/SKILL.md`, tracked here, so a change to it is a reviewable diff and a fresh clone gets it — unlike `guard-subagent-gates` and the `track-steps` writer, which keep that caveat. What a fresh clone does *not* get is its gitignored `repos.local.json` (see **Project structure**). **The merge gate stays human in every mode.**
>
> **The review gate is not enforced today — but it is enforceable, and the mechanism is already installed.** Note first that *no* gate here is enforced in the sense of "approval was obtained": `guard-bash` blocks dangerous **shapes** of the `git` commands (a commit on `main`, a force-push), never the absence of a confirmation, and it does not inspect `gh` at all — so `gh pr create` and `gh pr merge` both pass it untouched, leaving only the commit gate's `git commit` and the PR gate's `git push` in its path at all.
>
> What makes the review gate different is *precision*, not possibility. The pinned package ships a `record_review` MCP tool (allowlisted in `.claude/settings.json`) that appends a `review` milestone to `events/<id>.jsonl`, and the `/kanban-workflow` skill already calls it — so a `PreToolUse` hook could refuse a `git push` on a ticket with no such event. The reason that is not a gate yet, and it is worse than imprecision: `review` has **two writers**, and one of them fires automatically. `hooks/track-steps.mjs:103` pushes `review: reached` on *every passing commit*, so the milestone is present on nearly every ticket whether or not a review happened — the package's own `verify/rules.js` classifies it `AMBIGUOUS` and says "its presence witnesses neither one." It also carries no sha, so it cannot say *what* was reviewed. **Gating on the event as it stands would be a rubber stamp**, which is why the fix is to bind to content (`tkt-55080f378279`) rather than to wire a hook against today's record. Binding the gate to content is `tkt-55080f378279`. **Until then, do not report the review gate as enforced — and do not report it as unenforceable either.** There is also no CI substitute: the `code-review` workflow is `disabled_manually` as of 2026-08-17, so the review gate is the only *automated-tooling* review this repo gets, alongside the human diff-read in step 6 (see **3. PR**).

> **Enforced locally:** a PreToolUse hook (`.claude/hooks/guard-bash.mjs`, wired in `.claude/settings.json`) blocks `git add -A`/`--all`/`.`, commits on `main`, and pushes to `main` before they run — these rules are no longer honor-system. (GitHub branch protection backstops the same at merge time — see the end of this section.)
>
> **It also fails CLOSED on `commit`/`push` when it cannot resolve the current branch** (`tkt-fbc74a3252fe`, #169), blocking with *"Could not determine the current branch, so this commit/push cannot be checked against the never-commit-to-main rule…"*. This deliberately contradicts the hook's general fail-open stance ("a guardrail must never wedge legitimate work"): an unresolvable branch is the one unknown that **silently disables the very rule it guards**, turning every way of breaking `git rev-parse` — a bogus `GIT_CONFIG_PARAMETERS`, `GIT_CEILING_DIRECTORIES` set over the repo, a `safe.directory` refusal, git off `PATH` — into a commit-to-`main` bypass. It is scoped to `commit`/`push` only, so an unresolvable branch still can't wedge ordinary work, and checked last, so explicit violations keep their precise message. **If you hit it, fix the environment** (look for a stale `GIT_DIR`/`GIT_CONFIG_PARAMETERS`) — do not work around the guard.

### Permissions (prompt-free workflow)

The workflow commands run **prompt-free**: `.claude/settings.json` allowlists the non-destructive MCP tools (`list_tickets`, `get_ticket`, `start_ticket`, `create_ticket`, `update_ticket`) and the workflow shell commands. Safety is **layered**, not a function of the allowlist alone:

- **git rules are intentionally broad** (`git add`/`commit`/`push`/…) but safe because the **`guard-bash` hook** inspects each actual command and blocks the dangerous shapes — `git add -A`/`-f`, `commit -a`, commits/pushes to `main`, force-push, `branch -D`, `reset --hard`, `clean -f`, `checkout -f` — plus the **fail-closed** block on `commit`/`push` with an unresolvable branch (above), which is what stops a broken git environment from quietly reopening the `main` path. **Where that is proven, since kanban no longer vendors the hook:** `.claude/hooks/guard-bash.mjs` is a ~20-line *launcher* that imports the guard from the pinned `ticket-workflow` and calls `main()` (`tkt-6e4c55c81208`), so the guard's own unit suite lives upstream. What kanban asserts locally is the **effect at the pinned build** — `.claude/settings.audit.test.mjs` spawns the actually-wired launcher and requires it to block a commit on `main`, block again when the branch is unresolvable, and *allow* the same commit on a feature branch. The launcher **fails closed**: if the package is missing, or resolves but exports no callable `main`, it exits 2 rather than letting the command through (only exit 2 blocks — an uncaught throw would exit 1, which is a non-blocking hook error). **Accept the trade knowingly:** on a fresh clone with no `node_modules`, that means *no* Bash command runs — including the `npm ci` that fixes it — so recovery is `npm ci` from a plain terminal outside the session.
- **`gh`/`npm`/`npx` rules have no such runtime hook on the main thread**, so **in the checked-in `settings.json`** they are pinned to **specific subcommands** (`npm run lint`, `gh pr merge`, `npx vitest run *`, …) rather than a wildcarded subcommand like `npm run *`. **Read that scope literally — the broadest rules actually in effect are not in that file.** `.claude/settings.local.json` grants `Bash(npm run *)`, `Bash(node *)`, `Bash(npm install *)`, `Bash(gh pr *)` and more; it is gitignored **globally** (`~/.config/git/ignore`), so CI cannot see it and never could. Those are deliberate local choices, but `guard-bash` contains **zero** references to `npm` or `node` (measured), so unlike the git rules they have **no runtime backstop whatsoever** — nothing inspects what `npm run *` actually runs. Since `tkt-fa2bd5a7a455` the audit suite does check that file when it exists, against a reviewed wildcard list, which gates every *local* commit through `.husky/pre-commit`; where the file is absent those cases **report as skipped** rather than passing quietly. **`guard-bash` does not inspect `gh` at all** — measured, zero matches for `gh` in its source — and `gh pr merge` lands the commit on `main` *server-side* with no `git push`, so the never-push-to-`main` rule is never consulted (`tkt-e508ad42a68a`). Nothing enforces the merge gate on the main thread: it is the human-approval prose in **4. Merge**, and branch protection requires **0 approvals**, so CI going green is the only thing standing between an agent and a merge. Treat "Ready to merge?" as the actual control it is.
- **`delete_ticket` and destructive shapes stay excluded** — they still prompt.
- **`create_ticket` is allowlisted but blocked at runtime by the `guard-ticket` hook** — ticket authoring is delegated to the local agent (see **Ticket creation flow**), parallel to the broad git rules being `guard-bash`-backed. The allow entry only avoids a re-prompt if that policy is ever relaxed; the hook is the real gate.

**A subagent cannot cross the three *command* gates at all** — commit, PR and merge; the review gate has no command to block, so nothing stops a subagent skipping it (`tkt-8e291b058706`, ticket-workflow v0.16.0). A
user-scope `PreToolUse(Bash)` guard, `guard-subagent-gates`, blocks `git commit`, `git push`,
`gh pr create` and `gh pr merge` when the call comes from a **subagent** — keyed on the payload's
`agent_id`, which is present only inside one. It was paid for by a `/code-review` subagent that
committed, pushed, opened a PR and merged it to `main` unapproved, with none of it in the review's own
report. Reading and reporting (`git log`/`diff`, `gh pr view`/`diff`/`list`, `gh pr comment`) are
untouched, and the main thread is unaffected — the four human gates above are still yours to cross.

Two things about it that are easy to get wrong. It keys on `agent_id`, **not** `agent_type`: the review
agents' types are undocumented, so a guessed list that never matches would be a guard that silently
never fires. And **it lives only in `~/.claude/settings.json`** — like the `track-steps` writer, it is
machine-local, so a fresh clone elsewhere has no such protection and nothing in this repo can detect
that. It also does not stop a subagent *editing* files (blocking `Edit` for every subagent would break
coding subagents); that half is `tkt-63e3c3cc962a` and needs one observed review run.

`.claude/settings.audit.test.mjs` enforces this in the gate: it pins the non-git allows to a reviewed set, rejects explicit dangerous tokens, keeps `delete_ticket` gated, and asserts both the `guard-bash` and `guard-ticket` backstops are wired — **failing CI** if any of those drift. **That CI guarantee covers `settings.json` only.** `settings.local.json` is audited by the same suite but can only ever be a *local* gate, because the file does not exist in CI — so a machine that never runs the suite locally has no check on its broadest permissions at all (`tkt-fa2bd5a7a455`). It also drives `guard-subagent-gates` **out of the pinned package** and requires a subagent `gh pr merge` to exit 2 while a `gh` read and a main-thread merge exit 0 (`tkt-e508ad42a68a`) — that asserts the *build* still refuses, never that it is armed here, because the wiring is machine-local. (It does not — and cannot — prove a broad git glob is safe at runtime; that is the hook's job, which is why the two are coupled.)

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

Ask **"Ready to commit?"** (the commit gate) — do not commit until confirmed. **This is also where the review gate is raised:** offer the `/code-review`, wait for it to run, and address its findings *before* committing. It costs tokens, so the spend is Jake's call — but "not now" defers the commit, it does not skip the review, because the PR cannot open without one. **Always name the target repo in the args** — a bare `/code-review` reviews the session's cwd, which from a kanban-rooted session has silently reviewed the wrong branch. Then:

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

**Confirm the review gate was crossed before asking**: a `/code-review` has run for this ticket and its findings are addressed. If none has, go back to the review gate — that is the failure this ordering exists to prevent, and nothing downstream will catch it.

Ask **"Ready to open PR?"** (the PR gate) — then push the branch and open it:

```bash
git push -u origin <prefix>/<id>-<slug>
gh pr create --base main --title "<ticket title>" --body "<why + ticket id + the ## Implementation summary>"
```

The PR body must reference the ticket id and include the `## Implementation summary` (which now carries both the `Tests:` and `Risk:` lines — so blast radius + rollback are visible inline on the PR). CI (`.github/workflows/ci.yml`) runs the same gate (typecheck + lint + test) on the PR — it must be green before merge. A second check (`.github/workflows/pr-branch-name.yml`) fails the PR if the head branch doesn't match `<type>/<id>-<slug>`. A fourth workflow (`.github/workflows/e2e.yml`, added 2026-07-02) runs the Playwright suite path-filtered to UI-touching changes (`src/**`, `e2e/**`, `playwright.config.ts`) — it is **advisory** (not in the ruleset) until it earns a stable track record, then gets promoted to required.

**Branch protection:** `main` is protected by **two** rulesets, and the difference between them matters (verified against the API 2026-07-23):

| ruleset | enforcement | required checks | bypass |
|---|---|---|---|
| `18042938` — *main: CI floor (no bypass)* | **active** | `gate`, `branch-name` | **none** (`current_user_can_bypass: never`) |
| `18084578` — *main: review (admin-bypassable)* | **disabled** | `gate`, `branch-name`, `review` | RepositoryRole + User |

So what is actually enforced today is the floor: a PR is required (**0 approvals**), deletion and force-push are blocked, and `gate` + `branch-name` must pass — with no bypass for anyone, including admins. **`review` is required by nothing right now**: the only ruleset naming it is parked, and everything else that ruleset declares (`pull_request`, `deletion`, `non_fast_forward`) merely duplicates the floor.

It is parked because `ANTHROPIC_API_KEY` is still unset. The **fail-open half is fixed** (`tkt-5f28061cb3bf`): the `review` job used to log *"secret not configured — skipping code review"* and exit **green**, so a green check meant either "reviewed, clean" or "never ran". It now **fails closed** — `scripts/review-preconditions.mjs` exits 2 when the key is missing, and the filter widened from `.ts|.tsx` to also cover `.mjs`/`.yml`, which had made the guard hooks, every workflow and this workflow itself invisible.

**The workflow is now `disabled_manually` (since 2026-08-17T14:35Z), so `review` does not appear on a PR at all** — measured on #289, which ran exactly two workflows. It was disabled ~8 minutes after three consecutive red `review` checks, which is the friction the paragraph below predicted; the prediction was right and the resolution was to switch the job off rather than live with it. **Read the absence correctly: no `review` check means nothing reviewed, which is not the same as nothing to report.** A disabled workflow contributes **no** check rather than a failing one, so `gh pr checks` exits 0 and the PR reads all-green — confirm with `gh workflow list --all`, never by inferring from the checks list. Whether it is re-enabled or retired is `tkt-16b6e37a1cbb`.

**Still true today, and not superseded by the disable:** re-enabling ruleset `18084578` needs the secret **first** (`tkt-f9782ff3fdf5`) — requiring a check that always fails would be its own trap — and `e2e` reports on the PR but does not block merge (it is `active`, with a `paths:` filter).

**What the disable did supersede** is the behaviour of the `review` check itself; this is what returns if the workflow is switched back on with the key still unset. **`review` was RED on every ordinary PR until the secret was set.** That was the intended state, not a regression — it blocked nothing, because the active ruleset requires only `gate` + `branch-name`. **Dependabot and fork PRs SKIPPED the job instead**, because Actions secrets are structurally unavailable to them, so failing there would have been ~5 red checks a week carrying no signal; a skipped check reads as absent rather than as passing.

When the PR opens, call `update_ticket` to set `status: "qa"` — **this is the single point where a ticket enters `qa`** (self-review no longer sets it; the ticket was `in-progress` through commit). It stays in `qa` until the merge step. **The `code-review` CI job no longer runs — the workflow is `disabled_manually` (see above), so expect no `review` check on the PR.** While it was enabled it posted findings as a PR comment, but only with `ANTHROPIC_API_KEY` configured; without the key it went **red** rather than green (`tkt-5f28061cb3bf`), so a red `review` meant "no key", not "findings", and a *green* one was real evidence a review ran. None of that is available today, which is why the review gate — a `/code-review` before the commit — is the only *automated-tooling* review this repo gets.

### 4. Merge (after CI is green — `review` does not run at all; workflow disabled)

Check for a code review comment on the PR from the `code-review` CI job. **Expect none today** — the workflow is disabled (see **3. PR**) — and note it was never the review gate regardless: it runs after the PR is open, too late to gate it. When it was live:

```bash
gh pr view <number> --comments
```

If there are significant findings, present them to the user and ask: **"Fix these in the current PR, or create follow-up tickets?"**
- **Fix now** — implement, commit, push; wait for CI to go green again, then return to this step
- **Follow-up tickets** — file each finding via the local agent (`npm run agent -- --yes --create-only "<finding>"`, per **Ticket creation flow**), then proceed to merge. If the local runtime is down, say so and let the user decide (fix-now, or hold the merge until it's back) — don't hand-author the ticket.

If the review found no significant issues, proceed directly. **If `review` is red with no comment, read the job log before treating it as the no-key case** — "red because unconfigured" and "red because the API call failed" look identical from the checks list, and only one of them is fine to merge past. That applies only if the workflow is re-enabled; while it is disabled there is no `review` check to read either way.

Ask **"Ready to merge?"** (the merge gate) — never merge without explicit approval, in any mode. Then:

```bash
gh pr merge --squash --delete-branch
git switch main && git pull
```

No `--admin` needed: the active `main` ruleset requires the `gate` / `branch-name` checks but **0 approvals**, so a normal squash-merge lands once CI is green (a red check still blocks it).

### Merge authority in the embedded terminal (push + open-PR only)

When the workflow runs **from inside the embedded terminal**, the session has **push + open-PR authority only** — a repo-scoped GitHub PAT with **no merge permission**, seeded via the container's mounted HOME (see README → *GitHub-in-terminal*, `tkt-fc6f493e2033`). At the merge gate the agent must therefore **not** attempt `gh pr merge` (it would fail on the token scope). Instead: capture the PR URL from `gh pr create` (or `gh pr view --json url -q .url`), state plainly that merging to `main` is the human's decision — the container is the least-guarded context and `guard-bash` does not run there — and print the URL for a manual merge from the host. The human-in-the-loop merge gate is deliberate; narrate it rather than hitting a permission error.

This squashes the branch to a single commit on `main` and deletes the **remote** branch. The local branch usually goes with it, but **not from a worktree** — see the `gh pr merge --delete-branch` bullet under **Concurrent sessions**, which is where local branches accumulate and why an agent cannot clear them.

Then, in order:

1. **`ExitWorktree`, if the ticket ran in one.** This is a step of the merge, not a courtesy — a worktree carries its own full copy of `CLAUDE.md`, so an abandoned one leaves stale project instructions on disk that `grep` keeps finding. Stale prose is harmless; a stale `CLAUDE.md` **instructs**. One left behind for 20 days was returning a phantom hit on every repo-wide grep (`tkt-6321b5b79986`), and the same shape in another repo left two CLAUDE.md files asserting the opposite of each other about TypeScript strictness (`tkt-af10174bec77`).
2. **`update_ticket` to set `status: "done"`** — this is the moment the ticket is officially closed.

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

## Temporary scripts

Prefer the MCP tools for all ticket operations — never write a script to mark a ticket done or mutate ticket state; `update_ticket` does that, and `npm run ticket` covers it when the MCP server is down (above). Only when a genuine one-off needs the service layer directly (e.g. a bulk migration across the markdown files) write a script to the project root, run it with `node_modules/.bin/tsx <script>.ts`, then delete it. Do not use `/tmp` or the Claude scratchpad directory — relative imports won't resolve from outside the project root.

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
  > **The user-scope duplicate was deleted 2026-08-18** (`tkt-9a3afc5b9f4f`). It was kept while the skill refused a foreign repo; **foreign-repo mode replaces that capability** — §1 resolves native vs foreign and drives another repo from a kanban session via §2a's `cd <target> && …` form, so non-kanban work no longer needs a session in that repo. One thing the deletion settled: **user scope won while both existed** (measured — a `/kanban-workflow` invocation loaded with `Base directory: ~/.claude/skills/kanban-workflow` and carried that copy's text verbatim), so the earlier "which one wins is unverified" is answered, and the answer was the *unversioned* one — a change to the tracked file would have been inert. That is why a second copy was never a harmless duplicate. **What is NOT yet verified: that the tracked copy now loads.** It has never been observed loading — the deletion removed the copy that was winning, and project-scope pickup is an inference, not a measurement. If it is wrong, `/kanban-workflow` is broken everywhere and foreign-repo mode is unreachable. The probe is one invocation in a fresh kanban session: it must report `Base directory: <repo>/.claude/skills/kanban-workflow`. `ls ~/.claude/skills/kanban-workflow` only confirms the deletion, not the pickup — do not read it as the same thing. A session rooted in a non-kanban repo now has no copy at all, which is intended: drive those from here in foreign mode.

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

**The general rule — controls, the surprising-result tell, ranking by consequence — now lives in `~/.claude/CLAUDE.md` → *Prove the instrument before reporting its output*, and applies in every repo.** What follows is this repo's instance and its executable precedent (`tkt-d2267fb6bac4`).

This is where the rule was paid for: **~12 confident false results in one 2026-07-15 session**, including a case-sensitive `git log --grep` that undercounted AI-co-authored commits 3× and nearly got a *true* resume claim weakened (`tkt-ceebed633013`). Same shape as the fail-open guard and the transcribed trace — see memory `feedback_validate_probe_with_controls`.

- **Recurring, code-shaped probes get a tested probe with a built-in control that fails loud** — the executable precedent is `scripts/probe/repo-stats.mjs` (+ `.test.mjs`): trailer-aware commit counting whose `assertInstruments` throws rather than return a false zero, and whose test watches the reconstructed broken probe go red. It is also the source for the published repo stats (never hand-transcribe them — see `feedback_generate_dont_transcribe`).
- **The cross-repo sweep is `scripts/probe/vacuous-tests.mjs <root>`** — it takes any repo's path, so run it rather than rebuilding it, and read a `0` only beside another repo's non-zero.
- **Merged-but-undeleted branches: `scripts/probe/merged-branches.mjs <repo-path>`** (`tkt-0993b12650a1`). Ancestry is the wrong instrument — a squash-merge makes a branch's commits non-ancestors of `main`, so `git rev-list main..<branch>` called 11 of 13 branches live when 3 were. This asks GitHub for merged PRs instead, and requires the branch tip to still *be* the merged head: a name matching a merged PR does not mean the commits do. It prints a paste-ready `git branch -D`, which stays a **human** action (`guard-bash` blocks the agent, correctly — see **Concurrent sessions**).
- **NUL bytes in ticket files: `node scripts/probe/nul-bytes.mjs <board-path>`** (`tkt-0fc9ba1b86c2`). One stray NUL makes a ticket file classify as binary, and a binary-skipping grep silently drops it — the live board counted 745 archived one way and 746 the other, both plausible. **Plain `grep(1)` is not the culprit**: this session's `grep` is a shim that execs ugrep with `-I` (binary) and `--ignore-files` (gitignored), so the hazard is the wrapper, not grep. It names the file, byte offset and a marked excerpt, and **exits 2 rather than 0 when it cannot scan** — an absent or empty `tickets/` is never reported as clean. Read-only: it prints the repair rather than applying it, and the intended text is usually a two-character `\0` escape, so substitute rather than delete.
- **Adoption counts for the workflow markers: `node scripts/probe/adoption-markers.mjs [board-root]`** (`tkt-6d0d8a0fe2d2`). Counts the red-first and mutation-check markers on `Tests:` lines, project-scoped, excluding `tickets/.history/**` and fenced code blocks — the two contamination paths hand-rolled counters had: a `.history/` snapshot double-counts any ticket edited after its summary landed, and an unfenced template counts its own paperwork (the shape `tkt-a98723f627df`'s CORRECTION fixed once already). `assertInstruments` throws on a misclassifying control rather than emit a count, and an unscannable board exits 2, never 0. Promotion decisions (`tkt-a98723f627df`, `tkt-06b572e5f00e`) read this probe, never an ad-hoc grep.
- **Before A/B-ing any instruction change: `node scripts/probe/clean-room.mjs`** (`tkt-b86d2a318f8b`). Answers whether a session can be run that loads **no** user-scope instructions — without one, both arms carry `~/.claude/CLAUDE.md` and the difference between them is unattributable, which is what invalidated the `tkt-70ab03c22f43` A/B. **It reports `BLOCKED`, not `CLEAN`, when it cannot tell** — `CLEAN` is reachable from exactly one arm pair and every other input, including an unrecognised one, is `BLOCKED` — and it exits non-zero on anything but `CLEAN`. As measured 2026-08-11 it *is* `BLOCKED` here: `--bare` and an isolated `CLAUDE_CONFIG_DIR` both exist and both fail auth on this subscription-only machine (`--bare` reads strictly `ANTHROPIC_API_KEY`; the OAuth token does not travel with a copied `.claude.json`). The unblocker is an API key, not a new mechanism — so until then, **an instruction change can be reasoned about but not measured, and should not be deleted on the strength of one A/B.** When it does go green, note that `--bare` strips MCP servers, skills and hooks as well as `CLAUDE.md`, so those must be held constant across both arms or they become the next confound.

## Writing these documents

`CLAUDE.md` and `README.md` instruct every future session, so a wrong sentence here misinforms
unboundedly and silently — unlike a wrong function, which fails once and loudly. Two rules, both paid
for by `tkt-4de2f4a839b7`, where a `/code-review` found **12** false or stale claims across the two
files and 9 needed correcting.

**1. For mutable external state, write the probe — not the answer.** Nearly every stale claim here was
*true when written*: `review` really was red on every PR, branch protection really did require three
checks. They rotted because they were recorded as answers to questions nobody would re-ask. A sentence
naming the command that answers it cannot go stale.

> ❌ "`review` is RED on every ordinary PR until the secret is set."
> ✅ "`gh workflow list --all` says whether `review` runs here — the checks list can't, because a
> disabled workflow contributes no check at all."

Applies to workflow states, branch-protection rulesets, secrets, installed versions, and anything else
living outside the repo. Where the current answer genuinely helps, **date it and keep the probe beside
it**, the way `repoStats` is an `asOf` snapshot rather than a live figure.

**2. A claim about code in this repo belongs in a test, not in prose.** If it can be measured, assert
it — `.claude/settings.audit.test.mjs` is the home, and `shared/constants.test.ts` is the pattern. A
hand-run `grep` quoted into a paragraph is a transcription, and *"generate, don't transcribe"* applies
to sentences exactly as it does to numbers. Precedent: this file asserted twice that `guard-bash` never
inspects `gh`, and drew a real conclusion from it (the merge gate has no runtime backstop) — nothing
checked it until that claim got its own test.

**3. Governing-doc changes are never "trivial".** The Testing table lets docs-only changes skip tests,
and that stays true — but do not let "it's only markdown" also skip the **review gate**. These two files
are where an unreviewed false claim propagates furthest. Size is not the measure of blast radius here.

**Do not build an assertion-word probe for this.** It was prototyped and measured against the pre-fix
files: **1 true positive in 51 flags** (~2% precision, 20% recall). The premise is backwards — words
like *never*/*cannot*/*enforced* select for prose the author thought hard about, which is already hedged
and cited, while the claims that actually rot are unremarkable declaratives (*"A human approves three
checkpoints."*). The measurement is in `tkt-4de2f4a839b7`.

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
