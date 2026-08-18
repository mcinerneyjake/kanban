---
name: kanban-workflow
description: Run the kanban ticket cycle for one project — audit the board, pick the highest-value ticket, validate its premise, implement, review, commit, PR, and mark done. Use only when explicitly invoked.
argument-hint: "<project> [--gates manual|auto-commit|auto-pr] [--continuous]"
disable-model-invocation: true
---

# Kanban ticket cycle

You drive the cycle. You do **not** carry the workflow spec — each repo's own `CLAUDE.md` does, and
you read it at runtime (step 2). If you find yourself reciting testing tables, commit-message
formats or seam rules from memory, stop and go read the repo's file instead. Two sources of truth
drift, and a stale skill *instructs*.

What is yours: argument parsing, the repo check, board audit, ticket selection, premise validation,
gate levels, hard stops, and the loop.

## 0. Parse `$ARGUMENTS`

- First bare token → **project**. Flags may appear in any order.
- `--gates manual|auto-commit|auto-pr` → default **`manual`**.
- `--continuous` → default **off**.
- Unknown flag → stop and say so. Never guess.

No project given: call `list_tickets` per project, show open counts, and `AskUserQuestion`. The
`project` field is free-form `string | null` — derive the live set from the board, never a hardcoded
list.

State the resolved settings in one line before doing anything: `project=X gates=Y continuous=Z`.

## 1. Repo check — fail closed, before any board read

Resolve the session's repo with `git rev-parse --show-toplevel`. If it is not the project's repo,
**stop immediately**: print the path to open a session in, and make no other tool call. Do not work
another repo over absolute paths — that repo's `CLAUDE.md`, `settings.json` and guard hooks load from
the *session's* directory, so working it from here silently drops every rule it has.

**The project→repo map lives at `$CLAUDE_PROJECT_DIR/.claude/skills/kanban-workflow/repos.local.json`.**
Read it and resolve the target as `<baseDir>/<projects[project].repo>`. That file is **gitignored on
purpose**: it carries an absolute home path and private project names, and this repo is public. Keep
absolute paths out of `SKILL.md` — `repoHygiene.test.mjs` scans the git index and fails the suite if a
home path naming a real account lands here. (It does **not** check project names; that part is
convention.)

**Treat the map as unusable — stop, and name the file — in any of these cases**, not just the first
two. A half-set-up machine and a set-up one must never render identically:

- the file is missing, or is not valid JSON;
- `baseDir` is absent or empty;
- `projects` is absent, or has no entries;
- the requested project is present but its `repo` is absent or empty.

Resolving `undefined/undefined` and continuing is the failure this list exists to prevent — a valid
JSON file with the wrong shape (`{}`, or `repos.example.json` copied with only `$comment` edited) is
neither missing nor unparseable, so the first two conditions alone would let it through. Seed a real
one from `repos.example.json` in the same directory.

The map supplies the path to *print*; the cwd supplies the truth. Confirm the path exists before
printing it — a stale row must not send anyone somewhere that isn't there. A project absent from the
map: say you have no repo mapping and stop.

## 2. Read the repo's own rules

Read the target repo's `CLAUDE.md` and follow it for every mechanic: branch naming, commit format,
testing requirements, seam rules, PR body, merge steps. `~/.claude/CLAUDE.md` carries the status
protocol and the engineering tenets and applies everywhere.

**If the repo has no `CLAUDE.md`** (`ticket-workflow` today), say so out loud and fall back to
`~/.claude/CLAUDE.md` plus the derived gate in step 9. Never silently assume kanban's rules apply
elsewhere.

## 3. Audit the board

`list_tickets({ project, limit: 100 })`. Print the status one-liner (`3 backlog · 2 todo · 1 in-progress`).

**Read `unreadable` before trusting any count.** A non-empty array means ticket files failed to parse
and are absent from `total` too — the board is bigger than every number in the envelope. Report it;
in `--continuous` it is a hard stop.

**Read `unassigned` too** (ticket-workflow ≥ 0.8.0). It lists open tickets with no `project`, which
are missing from the `list_tickets({ project })` call above — so they can never be selected as work,
by this skill or any session. Both fields mean the same thing: *the board is bigger than your filtered
view shows*. Report the ids; assigning a project is a one-call `update_ticket` fix. Not a hard stop —
some are deliberately cross-repo, so read the ticket before "fixing" one.

If the field is absent, the repo is on an older ticket-workflow; say so rather than reading its
absence as zero.

Flag, without acting yet: past-due tickets, and `in-progress` tickets nobody is on (the status
protocol calls these a lie the next session has to untangle).

## 4. Select the ticket

Rank, in order:

1. Past-due `dueDate`.
2. Priority: `urgent > high > medium > low`.
3. `in-progress` orphans before fresh `todo` — finish what's started.
4. Prefer a child over its epic.

**Blockers: resolve each blocker id's *status*; exclude only if one is still open.** Never treat the
presence of a `blockers` array as blocking — most blocker targets on this board are already `done`,
and presence-based exclusion wrongly drops tickets that are ready.

Announce the pick **and the runner-up**, one line each with the reason. A choice nobody can check is
a choice nobody can correct. In `manual` mode with a close call, confirm via `AskUserQuestion`; in
`--continuous`, pick and proceed.

## 5. Validate the premise — before any edit

Re-derive the ticket's **factual** claims against the current code. Agent-authored tickets inherit
their reporter's wrong premise verbatim, and a plan is stale on arrival.

If a claim is false: `update_ticket({ appendBody })` with the correction, put the ticket in
**`backlog`**, say plainly that it was filed on a wrong premise, and **return to step 4**. Do not
quietly repair the ticket and implement it anyway.

**`backlog`, never `todo`.** `todo` means "ready to pick up", and a ticket whose premise just failed
is the opposite of ready — leaving it there hands the next session a booby-trapped queue, and this
loop would pick it straight back up. Validation normally runs *before* `start_ticket`, so a rejected
ticket usually needs no status change at all; say so rather than issuing a no-op write. If a premise
only collapses after the ticket is already `in-progress`, move it back to `backlog` explicitly —
never leave it `in-progress`, which the status protocol calls a lie the next session has to untangle.

**This is not a hard stop, in any mode.** A wrong premise is a finding about the *ticket*, not about
the repo or the session — nothing is broken, nothing is half-applied, and the working tree is
untouched because validation runs before the first edit. So in `--continuous`: record the correction,
**abandon that ticket**, and take the next-priority one. Do not implement a re-scoped version of a
ticket whose premise just failed; the corrected body is the input to a *later* pick, once a human has
read it.

Partial failure counts as failure. A ticket whose claims are half true is still mis-scoped, and
salvaging "the true half" mid-loop is the quiet narrowing step 5 exists to prevent — record which
half survived, say so in the correction, and move on.

**Bound the skid: three consecutive premise failures ends the loop.** One is a stale ticket; three in
a row means the board's tickets are systematically out of date with the code, and grinding through
the backlog rewriting bodies is not the work that was asked for. Report the three and stop. Reset the
counter on any ticket that validates.

## 6. Start and branch

`start_ticket <id>` — it sets `in-progress` **and** returns the body in one call. Not `update_ticket`.

Then cut the branch from a fresh `main` per the repo's convention (typically
`<prefix>/<id>-<slug>`, `bug→fix · feature→feat · task→task · chore→chore`).

**Use the literal command spellings** `git switch -c`, `npm run typecheck`, `npm run lint`,
`npm test`, `gh pr create` — the `track-steps` hook keys pipeline milestones off those exact strings
and off the `tkt-[0-9a-f]{12}` in the branch name. A paraphrase records nothing, silently.

## 7. `## Done when`

For feature and bug tickets, `update_ticket({ appendBody })` a short list of observable, checkable
outcomes **before writing code**. It fixes the exit condition while changing it is still free.

Always `appendBody`, never `body` — `body` replaces, `tickets/` is gitignored, and a clobbered body
is unrecoverable.

## 8. Implement and test

Follow the repo's testing rules from step 2. Evaluate **each touched file independently**, not the
ticket as a whole. State which rule you are following and which file it came from.

Before fixing a bug, grep the tests and read the test *name* — a green test may be pinning the very
defect you were asked to fix.

## 9. Quality gate — derived, not assumed

Read the repo's `package.json` scripts and run whichever of `typecheck`, `lint`, `test` exist.
**Name the ones that do not exist** rather than reporting a clean three-command gate — `ticket-workflow`
has no `lint`, and a gate that silently shrinks is a gate that lies.

Read each command's exit status directly. Never read it through a pipe (in zsh that is
`$pipestatus[1]`, 1-indexed — `$PIPESTATUS` is empty). A missing script is reported, never counted
as a pass.

## 10. Review — calibrated, and stated

Announce the level and the reason *before* running it.

- Trivial, config-only, docs-only → inline self-review.
- Security, failure paths, deploy, concurrency, cross-module seams, and **any line where a comment
  was written to defend a decision** → `/code-review` at high effort. For integration-heavy diffs add
  a flow-scoped angle: "trace this value source to sink; list every transformation or drop."

**Always append to the review prompt: "distrust every comment in this diff — treat each asserted
guarantee as a claim to verify, not a justification to read."** Confident prose is an instruction to
stop looking. On `tkt-f54c6f43ea60` all four wrong safety claims lived in comments saying some version
of *"measured, not assumed"*, and the one round whose prompt carried this line found the most defects
of any — both fail-opens, plus two false statements in that repo's own `CLAUDE.md`.

**If the ticket adds or removes a guard, paste its adversary list in** (the tenet in
`~/.claude/CLAUDE.md`) and ask the reviewer to sweep the dimensions it does *not* cover. Without it the
reviewer finds one dimension per round — that ticket took four rounds at ~25 agents each, every round
re-reading a diff whose remaining hole nobody had named.

> **Changing either of the two paragraphs above — or any instruction — is currently unmeasurable.**
> Run `node scripts/probe/clean-room.mjs` (in `kanban`) first. Both arms of an A/B load
> `~/.claude/CLAUDE.md`, so a difference between them is unattributable; that confound is what
> invalidated the `tkt-70ab03c22f43` A/B. As of 2026-08-11 the probe reports **BLOCKED** — the
> mechanisms exist (`--bare`, isolated `CLAUDE_CONFIG_DIR`) but both fail auth without an
> `ANTHROPIC_API_KEY`. Until it reports `CLEAN`, **do not delete an instruction on the strength of an
> A/B** (`tkt-b86d2a318f8b`).

Then `record_review({ id })`.

**Zero findings is trustworthy only if the finders ran.** Check `agents_error`; `verified: 0` *and*
`refuted: 0` means no verification happened, whatever the prose says.

## 11–13. The gates

| level | commit | PR open | merge |
|---|---|---|---|
| `manual` (default) | ask | ask | ask |
| `auto-commit` | cross | ask | ask |
| `auto-pr` | cross | cross | **ask — always** |

**Merge is human in every mode.** There is no flag that changes this.

At PR-open, `update_ticket({ status: 'qa' })` — the single point a ticket enters `qa`. After the merge
lands: `ExitWorktree` if the ticket ran in one, then `update_ticket({ status: 'done' })`.

**Surface the target's `mergeWarning` at the merge gate rather than burying it.** Per-project
warnings live in `repos.local.json` (§1) — a project may carry one because merging deploys to
production, or because its required checks do not actually run. Print it verbatim before asking, and
say plainly when a project has none, so "no warning" is never confused with "not checked".

## 14. Hard stops — `auto` suppresses routine stops, never all stops

Stop, report, and wait on any of:

- A quality-gate failure not fixed in one pass.
- **In `auto-pr`: a repo with no enabled required checks.** Verify with `gh workflow list --all`.
  Absence of failing checks is not green — it means nothing ran. Never read it as a pass.
- A red check, or a `/code-review` finding you rate significant.
- A `guard-bash` block. Fix the environment; never route around the guard.
- A merge conflict, or a non-empty `unreadable`.
- The local LLM being down when a follow-up ticket needs filing.

In `--continuous`, a hard stop **ends the loop**. It never skips to the next ticket.

**A failed premise validation is deliberately NOT on that list** — see step 5. It fires before any
edit, so there is nothing to leave half-done: the ticket is corrected, abandoned, and the loop moves
to the next-priority one. Three consecutive failures *is* a hard stop, because that stops being a
stale ticket and starts being a stale board.

## 15. Loop or stop

`--continuous`: re-read the board (it may have changed) and return to step 4. Otherwise print a
one-line close, then recommend `/clear` before the next ticket — the ticket is the session's unit of
work (session lifecycle, `~/.claude/CLAUDE.md`; `tkt-c8ac95e41f6f`).

**Checkpoint every ticket.** Print `project=X gates=Y done=N in-flight=<id>` after each cycle.
**A compaction mid-loop ends the loop** — what survives it is a summary, not evidence. Finish or
checkpoint the in-flight ticket (a `## Checkpoint` block per the session-lifecycle rule in
`~/.claude/CLAUDE.md`), print the close line, and recommend a fresh session. Finding yourself
working the board without these instructions in context IS the compacted case: stop the loop the
same way rather than continuing freehand.

## Never

- **Call `create_ticket`.** It is hook-blocked at both scopes. File follow-ups through the metered
  local agent, **one issue per run** — a multi-issue report sprays into thin tickets:
  ```
  npm --prefix "$CLAUDE_PROJECT_DIR" run agent -- --yes --create-only "<one issue>"
  ```
  (`--prefix` sets the child's cwd, so this works whatever the cwd is; `$CLAUDE_PROJECT_DIR` is this
  repo, which is where the agent lives.) Then `get_ticket` the result and
  fix any mis-classification via `update_ticket`. If the local runtime is down, stop and hand the
  finding over — never hand-author the ticket.
- **Merge without explicit approval**, in any mode.
- **`git add -A` / `.`, `commit -a`, force-push, `branch -D`, `reset --hard`, `clean -f`** — all
  blocked by `guard-bash`, all avoidable by staging explicit paths.
