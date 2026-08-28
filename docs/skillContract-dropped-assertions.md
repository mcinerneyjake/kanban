# `skillContract.test.mjs` — what the tkt-5a4ff25d4e74 trim dropped, and why

`skillContract.test.mjs` went from **1,604 lines / 124 tests** to **805 / 46** on 2026-08-27. This
file is the record the ticket's Done-when asks for: *every removed assertion is either preserved
elsewhere or recorded as deliberately dropped, with a reason.* It is also the rollback plan's Layer 2
— the trimmed material is relocated here rather than deleted, so restoring a binding means moving
text back, not reconstructing it. Total undo for the whole cleanup is `git diff pre-cleanup-2026-08-20`.

> **The counts in this file are generated, not transcribed** — the first draft got four of them wrong
> and a review caught it, in a repo whose own rule is *generate, don't transcribe*. Regenerate with:
>
> ```bash
> git show pre-cleanup-2026-08-20:skillContract.test.mjs > /tmp/old.mjs
> for f in /tmp/old.mjs skillContract.test.mjs; do
>   echo "$f: $(wc -l < $f) lines, $(grep -c '^[[:space:]]*it(' $f) tests"; done
> awk '/^describe\(/{n=0;h=$0} /^  it\(/{n++} /^\}\);/{if(h)print n, h; h=""}' /tmp/old.mjs
> ```

## The rule the cut applied

The ticket's own trim safety rule — *trim what a mechanism already enforces; keep what nothing else
can catch* — was written about prose. Its test-analogue is:

> **Keep a binding when a drift in it would be SILENT. Drop it when a run stops, or degrades
> visibly, on its own.**

That is the same reasoning as the fail-open tenet in `~/.claude/CLAUDE.md`: the checks worth paying
for are the ones whose absence looks like nothing having happened.

**Applying it correctly took two passes.** The first cut dropped two things this rule says to keep —
the menu's *recommended-must-be-first* control and the *startup ticket slot* — and a review found
both (see **Corrections**). Treat the rule as easy to state and easy to misapply.

## Kept (5 bindings)

| binding | what a silent drift buys | ticket |
|---|---|---|
| gate table | a level authorized to skip `review`, or to cross `merge` | `tkt-abaff4ebd8b3` |
| gate-level menu | §0 pre-fills an auto level, or lists one **first** | `tkt-34f8a4b467e7` |
| startup ↔ handoff `--gates` agreement | the next session is pre-granted a level nobody approved | `tkt-9fbe6c952590` |
| post-review **scope** table | the only detection half of the wrong-repo fail-open | `tkt-32f7c384bcad` |
| startup line carries **no** ticket slot | every session from that prompt works a ticket nobody chose | `tkt-71229c9290b8` |

## Dropped (2 bindings, plus one half)

### 1. The §15 per-ticket-type close table — `tkt-6dbfbd65a71c`

**Was:** `parseCloseTable` / `closeTableProblems`, 3 real-file assertions + **10** controls (~170
lines). Derived its rows from `TYPES` in `shared/constants.ts` so that adding a ticket type reddened
the suite rather than going unconsidered, and rejected any cell holding a skip value.

**Dropped because** the drift is not silent. §15 tells a run to read that table at every close, and
the wrap-up check is an `AskUserQuestion` a human answers — a missing row or a `skip` cell is read by
a person at the moment it matters. The `TYPES` derivation is the real loss: a new ticket type would
now reach §15 with no row and nothing would say so. **Mitigation, verified rather than assumed:**
`git log -S "export const TYPES" -- shared/constants.ts` returns only the initial commit, so `TYPES`
has never changed; and adding one is a `shared/constants.ts` edit whose own diff is the prompt to
update §15, which now says so in prose.

**Restore by** reinstating `CLOSE_VALUES`, `CLOSE_COLUMNS`, `parseCloseTable`, `closeTableProblems`
and the `import { TYPES } from './shared/constants.ts'`. Every other symbol they touch (`levelLabel`,
`gateValue`, `SKIP_WORD`, `splitRow`, `stripMarkup`) survives in the trimmed file.

### 2. §0's ticket-id argument surface — `tkt-ec08d8af98f3`

**Was:** `ticketArgProblems`, 2 real-file assertions + **12** controls (~150 lines). Asserted that §0
declares both spellings (`--ticket <id>` and the bare `tkt-[0-9a-f]{12}` shape), that the frontmatter
`argument-hint` names the flag, and that a declaration surviving only inside a code fence does not
count.

**Dropped because** the failure is loud by design. §0's own rules stop the run by name on a leftover
bare token, on a malformed id, and on two ids — that is the whole point of `tkt-ec08d8af98f3`'s
original finding. A lost declaration therefore surfaces as a **stop the user reads**, not as a silent
mis-parse. The `argument-hint` half degrades to a worse hint, not to a wrong action.

**Restore by** reinstating `ticketArgProblems`. `sliceSection` and `fenceMask`, which it needs, both
survive.

### 3. The **handoff** ticket slot — `tkt-71229c9290b8` (half of this binding; the startup half was kept)

**Was:** `TICKET_SLOT_SRC`, `NO_SLOT_PROBLEM`, `handoffTicketSlotProblems`, 1 real-file assertion +
**15** controls. Asserted §15's handoff invocation carries exactly one ticket slot.

**Dropped because** it degrades visibly rather than silently. A handoff that loses its slot prints an
invocation with no id; the next session re-ranks in §4 and reaches the same board — one re-derivation,
which is the friction `tkt-71229c9290b8` was filed against, not a wrong action.

**The startup half was NOT dropped** — see **Corrections** below for why the symmetric argument fails.

**Restore by** reinstating `TICKET_SLOT_SRC`, `NO_SLOT_PROBLEM` and `handoffTicketSlotProblems`. Note
the trimmed file keeps a `TICKET_SLOT` regex built inline for the startup check; a restore should
rebuild it from `TICKET_SLOT_SRC` so the two spellings cannot diverge.

**Not dropped with it:** the *"exactly one line-initial slash command per section"* rule that
`SKILL.md` §15 cites lives in `invocationOf`, which is kept for the startup/handoff binding.

## Controls that went, inside bindings that stayed

The **eight** `the checker itself` blocks held **106 of the 124** tests (menu 14, gate-table 12,
close 10, post-review 16, startup 23, ticket-argument 12, ticket-slot 15, startup-slot 4). The
trimmed file keeps, per surviving parser, a positive control plus the negative cases that pin either

- a **measured** past false-clean (a shape that actually returned `[]` against an earlier cut), or
- the *"cannot check must not read as clean"* direction, or
- a guard whose removal a mutation showed the suite would not otherwise catch.

Dropped were cases sampling shapes no defect ever took: an empty/dash-only cell, a level or check
listed twice, a row naming nothing known, a menu entry with no description, review ordered after
commit, a menu drifted out of §0, a `###` subsection boundary, and a non-command path line.

**Every measured false-clean was kept**, each carrying its incident inline as a terse comment:

| shape | where it measured clean |
|---|---|
| dropped `merge` column; `auto-pr … cross` for merge | first cut of `gateTableProblems`, skip-word denylist only |
| `n/a (docs-only)`, `optional — see §14`, `ask — skip if docs-only` | first cut's anchored `^…$` matcher |
| unparseable gate table clearing the recommendation | review finding on `gateMenuProblems` |
| a row with no cells reading as "asks at every gate" (`[].every()`) | `safestLevels` vacuity |
| `**scope** (skip in foreign mode)` — exemption on the row NAME | `tkt-32f7c384bcad` finding 4 |
| `did not run — except in foreign mode` / `(unless …)` | `tkt-32f7c384bcad` findings 5–6 |
| a fenced EXAMPLE table parsed as the real one | `parseScopeTable` pre-`fenceMask`; and **`parseSkill`**, see below |
| a deleted handoff invocation, and a handoff pre-filling an auto level | first cut mutated only the CLAUDE.md side |

## Corrections — what the trim got wrong, and how it was caught

A high-effort `/code-review` of the trim itself found eight issues. Three changed the outcome:

**The fenced-example false-clean was live on the gate table.** `fenceMask` guarded `parseScopeTable`
and `sliceSection` but not `parseSkill` or `parseMenu`. Measured: deleting §11–13's real table and
leaving a ```` ```markdown ```` copy of it made `gateTableProblems()` return `[]` — a clean report on
the file's most consequential binding. The gap pre-dated the trim; hoisting the `fenceMask` comment
and generalizing it is what turned a scoped note into a false guarantee. **Fixed**, not documented:
both parsers now mask, and a control pins it.

**Three surviving guards had no control at all**, each verified by mutation to leave the suite fully
green when neutralized: the `passes no --gates level` push (the only thing between a level-less pair
and a clean report, since the next line returns early on it), the skill-name equality check, and the
menu's *recommended-must-be-first* check. The last is the interesting one — by the cut's own rule it
should never have gone, since a menu listing `auto-pr` first with `manual` marked lower down
pre-authorizes crossing commit *and* PR-open and is indistinguishable from a correct menu at the
point of use.

**The startup ticket-slot drop rested on a rationale that only holds for a stale id.** The argument
was "a pasted id is a guess, and §5 premise validation catches it". But §5 stops only on a *failed*
premise: paste a **valid** `tkt-…` into CLAUDE.md's startup line — the natural error, since §15's
handoff block does carry a slot and its prose explains how to substitute one — and §5 passes, §0's
named-ticket path skips §4's ranking, and every session opened from that prompt works a ticket nobody
chose. That is a silent wrong action, not visible degradation. **`startupTicketSlotProblems` was
restored**; the handoff half's argument survived scrutiny and stayed dropped.

The lesson worth carrying: the rule *"keep what drifts silently"* is easy to state and easy to
misapply, and both misapplications here were found by mutating the surviving code rather than by
re-reading it.
