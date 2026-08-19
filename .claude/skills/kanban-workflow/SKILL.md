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

What is yours: argument parsing, repo resolution, board audit, ticket selection, premise validation,
gate levels, hard stops, and the loop.

## 0. Parse `$ARGUMENTS`

- First bare token → **project**. Flags may appear in any order.
- `--gates manual|auto-commit|auto-pr` → omitted means **ask** (see below), not a silent default; an
  unanswered menu resolves to `manual`.
- `--continuous` → default **off**.
- Unknown flag → stop and say so. Never guess.

No project given: call `list_tickets` per project, show open counts, and `AskUserQuestion`. The
`project` field is free-form `string | null` — derive the live set from the board, never a hardcoded
list.

**No `--gates` given: ask, with the same tool.** A level decides how many human approvals the rest of
the run skips, so choosing it silently is the one default that should not be invisible. One option
per level, `manual` first and labelled `(Recommended)`, each naming what the level crosses on your
behalf:

- `manual` (Recommended) — every gate asks. Nothing is crossed on your behalf.
- `auto-commit` — you run the review and commit without asking; PR-open and merge still ask.
- `auto-pr` — you run the review, commit and open the PR without asking; merge still asks.

**An unaskable or unanswered menu resolves to `manual`** — never to an auto level, and never to a
level inferred from the request's tone or from what was chosen last time. This is the fail-safe
direction: "I could not ask" must not return the permissive answer, exactly as elsewhere in this
repo's guards. A run that could not put the question is a run with no authorization to cross
anything, which is what `manual` means.

An explicit `--gates` flag is an answer already given: skip the menu, do not re-ask, and do not treat
the flag as a suggestion to confirm. Ask the project and the gate level in one `AskUserQuestion` call
when both are missing — it takes several questions, and two round-trips to start one ticket is
friction the menu does not need to cost.

`kanban`'s `skillContract.test.mjs` binds that list to the §11–13 table and fails that repo's suite
when the two drift. Read the checks there rather than a summary here — enumerating them in prose is
the transcription this repo's own rules forbid, and the first cut of this paragraph was already
missing two of them. As with the gate table, it asserts the *list*, never that a run asks.

State the resolved settings in one line before doing anything: `project=X gates=Y continuous=Z`.
Reprint it with `mode=native|foreign` appended once §1 has resolved the repos — it cannot be known
before then, since it needs the `git rev-parse` and the repo map.

## 1. Resolve the repos — native or foreign mode

Two repos matter, and they are not always the same one:

- the **session repo** — `git rev-parse --show-toplevel`. This is where the auto-injected `CLAUDE.md`,
  the `settings.json` allowlist and the project-scoped hooks came from, whatever you do later.
- the **target repo** — where this project's code lives, resolved from the project→repo map below.

Equal → **native mode**. Different → **foreign mode**: you drive the target repo from this session,
via §2a's command form. Announce which one, and in foreign mode name both paths.

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

**Three stops survive foreign mode. None is softened by it:**

- **The resolved target path does not exist.** Print it and stop — a stale row must not send anyone,
  or any `cd`, somewhere that isn't there. Confirm with a real check, not by assuming the map is current.
- **The project is absent from the map.** Say you have no repo mapping and stop. Do not guess a path
  from the project's name.
- **The resolved target path is not a plain absolute path.** If it contains whitespace, `$`, `*`, a
  quote or a leading `~`, stop and say why. This one is not fastidiousness — see the fail-open below.

**Why foreign mode is safe, and the two places it is not.** `guard-bash` parses a `cd` (and a
`git -C`) out of the command and judges **the target repo's** branch, so the protected-branch rules
apply to the repo actually being written. It follows the `cd` in both directions: a `cd` into a repo
on `main` is blocked even when the session sits on a feature branch, and a `cd` into a feature branch
is allowed even when the session sits on `main`. Asserted against the pinned build in kanban's
`.claude/settings.audit.test.mjs` ("judges a cd-carrying command against the target repo, in both
directions") — do not take it from this file's word.

Two limits on that, both measured, both failing in the **permissive** direction:

1. **A target path the guard cannot parse silently reverts to judging the *session*.** `resolveDir`
   returns null for a `cd` target that was whitespace-split, quoted, or a variable — and the fallback
   is the session's branch, which in foreign mode is a feature branch, i.e. *allowed*. Measured, session
   on a feature branch, every target on `main`: a plain `cd <path>` blocks, while `cd /a/my repo`,
   `cd "/a/my repo"`, `cd '/a/my repo'`, `cd $TARGET` and `pushd <path>` **all pass**. Hence the third
   stop above, and §2a's literal-path rule. The fail-open is pinned by a test case, so if upstream
   fixes it that test goes red and these rules can be relaxed — do not relax them before that.
2. **The commit rule is remote-gated; the push rule is not.** `ruleFor` returns null for `commit`
   when the repo has no remote, so in a target with no `origin` a commit on `main` is **allowed** —
   deliberate upstream behaviour ("land it on a branch and open a PR" being meaningless with nowhere
   to push), and identical natively. Two mapped targets have no remote today. Do not tell a reader
   working one of those that a guard is holding: check `git remote` and say which rules are live.

**What foreign mode carries, and what it drops.** The old hard stop named three things that load from
the session's directory — `CLAUDE.md`, `settings.json`, and the guard hooks. They do not all fare the
same, so do not let the guard result above stand in for the other two:

| loads from the session, not the target | status in foreign mode |
|---|---|
| **guard hooks** | **Carried** — but not because the target's copy runs. The guards are wired in `~/.claude/settings.json`, so they fire whatever the cwd, and `guard-bash` judges the `cd` target. The target's own `.claude/hooks/*` do **not** run, and they are not all launchers of the pinned package: two mapped targets vendor a standalone 333-line guard with no `ticket-workflow` reference at all. Those are older and stricter-by-accident (they hardcode `main` instead of consulting `origin/HEAD`), so the session's newer guard covers what they would have — verify that still holds before relying on it for a target you have not checked. |
| **`CLAUDE.md`** | **Your job, per §2.** Nothing loads the target's automatically. |
| **`settings.json` permission allowlist** | **Dropped, and in the permissive direction.** |
| **pipeline telemetry** | **Dropped, per §2a.** |

The allowlist row is the one with no mitigation, so state it rather than discovering it: commands you
run against the target are permitted by **this session's** allowlist, and the board repo's is among
the broadest on the machine. A target that deliberately allows less does not get to enforce that here.
The guards still bound what a permitted command may *do* — this widens what runs without a prompt, it
does not unblock a commit to `main`. If a target's restrictions are the point of the ticket, work it
from a session rooted there instead.

## 2. Read the repo's own rules

Read the **target** repo's `CLAUDE.md` and follow it for every mechanic: branch naming, commit format,
testing requirements, seam rules, PR body, merge steps. `~/.claude/CLAUDE.md` carries the status
protocol and the engineering tenets and applies everywhere.

> **Foreign mode inverts the usual precedence, and nothing on screen will tell you.** The `CLAUDE.md`
> auto-injected into this session is the **session** repo's, and it does **not** govern the target's
> ticket. It arrives first, it is never announced as scoped, and it reads exactly like the rules for
> the work in front of you — so the failure is silent by construction. In foreign mode the target's
> `CLAUDE.md` is the one you must go and read, and where the two disagree the **target wins** on every
> mechanic. Say out loud which file you are following before the first edit.

**Rank the target's rules by what its own `CLAUDE.md` actually defines** — do not treat "has a
`CLAUDE.md`" as "defines a workflow":

1. **It defines the mechanic** → follow it, exactly.
2. **It deliberately defines a *different* one** → follow that, and do not restore the missing step.
   A repo whose `CLAUDE.md` says commits land locally on `main` with no push, no PR and no CI means
   it; inventing a PR gate there is not caution, it is disobeying the file you were sent to read.
3. **It is silent on the mechanic** → fall back to `~/.claude/CLAUDE.md` plus the derived gate in
   §9, and **say which mechanic you are improvising**. Silence is common: several targets define
   testing and comment rules but no branch or commit convention at all.
4. **There is no `CLAUDE.md`** → say so out loud, then as (3). Never silently assume kanban's rules
   apply elsewhere; kanban's are the heaviest on this machine and the least likely to fit.

Whichever rung applies, name it. "I am on rung 3 for commit format" is checkable; "following the
repo's rules" is not.

## 2a. Foreign-mode command form — `cd`, never `-C` or `--prefix`

Skip this section in native mode. In foreign mode, **every** command that acts on the target repo is:

```bash
cd <target> && <the literal command from §6/§9/§11–13>
```

**Not `git -C <target> …`, and not `npm --prefix <target> …`, for any milestone-bearing command**
(`git switch -c`, `npm run typecheck`, `npm run lint`, `npm test`, `git commit`, `gh pr create`).
Both are safe — `guard-bash` follows `-C` as it follows `cd` — but the `track-steps` matcher is
**positional**: it reads `t[0]`/`t[1]`/`t[2]`, so `git -C … commit` puts `-C` where `commit` must be
and matches **nothing**. Measured, with controls:

| command | milestone recorded |
|---|---|
| `git commit -m x` | `commit` |
| `cd <target> && git commit -m x` | `commit` |
| `git -C <target> commit -m x` | **none** |
| `npm run typecheck` | `typecheck` |
| `npm --prefix <target> run typecheck` | **none** |
| `cd <target> && npm run typecheck` | `typecheck` |

The compound form works because the matcher splits on `&&` first and matches each segment. So `cd`
is not a style preference — it is the only spelling of a foreign command that the pipeline can see.

`--prefix` stays correct in the one place it already appears (**Never**, filing a follow-up ticket):
that command is deliberately *not* milestone-bearing, and it must run the agent from the board repo
rather than the target.

**Two things that are not commands, and route differently.** The board tools (`list_tickets`,
`start_ticket`, `update_ticket`, `record_review`) reach the board through the MCP server — a **separate
process** whose cwd and environment were fixed when the session started. No shell `cd` can move it, so
these are correct in both modes and take no prefix. (Which root it resolved is a per-machine detail;
what matters here is that a command's cwd is not an input to it.) **`EnterWorktree`/`ExitWorktree` are the
opposite: they act on the *session's* repo**, so in foreign mode they would branch this repo rather
than the target. Do not use them in foreign mode — if the target needs a worktree, that is a reason to
work it from a session rooted there.

> **Known limit — and it corrupts, it does not merely go missing.** `track-steps` resolves the ticket
> id from the branch of the *session's* cwd, never from the `cd` target, and writes the milestone to
> the central board's `events/<id>.jsonl`. So if this session sits on a branch carrying a `tkt-…` id,
> a foreign-mode run appends `test`/`commit`/`review` rows to **that** ticket's log — a real kanban
> ticket showing a pipeline it never ran. The `cd` form makes a milestone *matchable*; nothing makes
> it *attributable*. Same class as the 1,889 duplicate rows in `tkt-af4669ce9a0d`.
>
> **So: before entering foreign mode, check the session's own branch.** If it carries a `tkt-…` id,
> switch the session repo to `main` first, or stop and say why. On a branch with no id the milestone
> resolves to nothing and is simply dropped, which is the acceptable version of this. Fixing it
> properly is `tkt-8ada0242e94e` plus the runtime pin bump `tkt-876ab4261e69`; until both land, never
> report the tracker as intact because the commands looked right.

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
and off the `tkt-[0-9a-f]{12}` in the branch name. A paraphrase records nothing, silently. In foreign
mode these keep their exact spelling and gain a `cd <target> &&` prefix — see §2a.

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

Read the **target** repo's `package.json` scripts and run whichever of `typecheck`, `lint`, `test`
exist — in foreign mode, the target's, not the session's, and via §2a's `cd` form.
**Name the ones that do not exist** rather than reporting a clean three-command gate — `ticket-workflow`
has no `lint`, and a gate that silently shrinks is a gate that lies.

Read each command's exit status directly. Never read it through a pipe (in zsh that is
`$pipestatus[1]`, 1-indexed — `$PIPESTATUS` is empty). A missing script is reported, never counted
as a pass.

**The gate is not only the npm scripts.** Where the target's `CLAUDE.md` defines checks that bind its
tests to *this* diff — kanban names a **mutation check** and a **red-first repro** rule — those are
part of this step, and they run **before** the commit gate in every mode, including the auto ones that
cross it unattended. Take the procedure, its scope and the marker it wants recorded from that file
(step 2), never from here: a second copy of a procedure is the drift this skill exists to avoid, and
a stale one *instructs*. Where the repo offers an escape hatch, take it explicitly and say why,
rather than bending an acceptance criterion to fit.

An auto mode that crosses the commit gate without a check the repo defines is a **silent downgrade**
of that mode, not a faster one — the same hole as crossing it with no review. If one cannot be run,
name it and stop (§14); a check you could not run is never reported as one that passed.

## 10. Review — calibrated, and stated

**The target repo decides *whether*; this step decides only *how deep*.** Read its `CLAUDE.md`
(step 2) before calibrating: where that file makes a review a precondition of the PR — kanban's does —
one **always** runs, and the levels below choose the effort, never the exemption. Announce the level
and the reason *before* running it.

- Security, failure paths, deploy, concurrency, cross-module seams, **any line where a comment was
  written to defend a decision**, and any change to a repo's governing docs (`CLAUDE.md`, `README.md`)
  → `/code-review` at high effort. For integration-heavy diffs add a flow-scoped angle: "trace this
  value source to sink; list every transformation or drop." Governing docs are on that list because a
  wrong sentence there *instructs* every future session, silently and unboundedly — size is not the
  measure of blast radius, and "it's only markdown" is not a calibration.
- Anything else → `/code-review` at default effort. **The unclassified middle runs a review.** A diff
  being hard to place is not evidence that it is safe, and this is the branch where the gate would
  otherwise fail open.
- Inline self-review **only** where the target's `CLAUDE.md` does *not* make a review a precondition
  of the PR **and** the diff is trivial, config-only, or docs-only outside that repo's governing docs.
  Note the wording: a repo that is *silent* on reviews satisfies the first half — silence is the common
  case for a foreign target (§2, rungs 3–4), and reading it as "no exemption" would put a full review
  on a one-line typo fix in a plain docs repo. Name **both** conditions you checked; "it looked small"
  is neither of them.

**Always name the target repo in the review's arguments — never a bare `/code-review`.** It resolves
against the session's cwd, so in foreign mode a bare call reviews *this* repo and reports confidently
on a diff nobody asked about. In native mode naming it costs nothing; in foreign mode it is the whole
difference between reviewing the work and reviewing the wrong repository (`tkt-32f7c384bcad`).

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

| level | review | commit | PR open | merge |
|---|---|---|---|---|
| `manual` (default) | ask | ask | ask | ask |
| `auto-commit` | run | cross | ask | ask |
| `auto-pr` | run | cross | cross | **ask — always** |

**The review column has no skip value at any level, and that is the point of it.** `ask` means ask
*when* to spend the tokens — "not now" defers the commit, it never cancels the review. `run` means the
level has pre-authorized you to run it yourself (§10), which is the only thing an auto mode lifts.
There is no value that crosses `commit` without a review having run, so no reading of this table
reaches an open PR with none.

**That is a claim about this table, not a guarantee about a run.** Nothing enforces it at execution
time: `guard-bash` does not inspect `gh`, and kanban's `skillContract.test.mjs` — which fails that
repo's gate if a column here is dropped, reordered or given a skipping value — asserts the table's
*shape* only, and in foreign mode never runs at all. The obligation is yours; the table only removes
the excuse.

**Review resolves before the commit, which is what the column order records — do not "fix" it back.**
The reasoning is in kanban's `CLAUDE.md` ("The review gate's ordering is deliberate"); read it there
rather than trusting a summary here.

**Merge is human in every mode.** There is no flag that changes this.

At PR-open, `update_ticket({ status: 'qa' })` — the single point a ticket enters `qa`. After the merge
lands: `ExitWorktree` if the ticket ran in one (native mode only — see §2a), then
`update_ticket({ status: 'done' })`.

**Surface the target's `mergeWarning` at the merge gate rather than burying it.** Per-project
warnings live in `repos.local.json` (§1) — a project may carry one because merging deploys to
production, or because its required checks do not actually run. Print it verbatim before asking, and
say plainly when a project has none, so "no warning" is never confused with "not checked".

**In foreign mode, add one line to the merge gate: which repo is about to be merged, by path.** The
approval a human gives at this gate is the last one, and from a session rooted somewhere else the
question "ready to merge?" does not on its own say *what*. The `gh` commands take §2a's `cd` form
like every other — `gh` resolves the repo from the cwd, so a bare `gh pr merge` here targets the
session's repository.

## 14. Hard stops — `auto` suppresses routine stops, never all stops

Stop, report, and wait on any of:

- A quality-gate failure not fixed in one pass.
- **A check the target repo defines that you could not run** (§9). Name it. Not-run is never reported
  as passed, and under `--continuous` this ends the loop like any other hard stop.
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
