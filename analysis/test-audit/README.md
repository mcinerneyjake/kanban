# Cross-repo test audit — roll-up (2026-08-18)

The deliverable of the 2026-08-17 test-audit initiative (`tkt-7bac51ae3cc6` close-out): six repos
audited for tests that cannot fail, on a tiered budget. Full treatment (candidate triage +
consequence-ranked mutation spot-checks) for the two focus repos; gap enumeration only for the rest.
Detail lives on each ticket; this file is the map.

**Verdicts.** *load-bearing* — the test went red when its path's authorizing line was flipped
(watched, not assumed) · *bandaid* — vacuous, or missed its mutation · *gap* — a consequential path
with no test · *tested* — a named test exists but no mutation ran (deferred tier; weaker than
load-bearing by design) · *unclassified* — not sampled, and said so. Counts are floors everywhere:
the probe under-detects by design (`scripts/probe/vacuous-baseline.json` → `_countsAreFloors`), and
the spot-checks sampled by consequence, not coverage.

## Results by repo

| repo | tier | candidates (before → after) | mutation cycles | verdicts |
|---|---|---|---|---|
| equipment-schedule | full | 25 → 11 (all accepts, recorded in the baseline) | 18 | 7 paths load-bearing · 1 bandaid fixed in-ticket · 1 gap (already ticketed) |
| copart-filter | full | 6 → 4 (all accepts, recorded) | 6 + pin controls | 6 paths load-bearing · 1 bandaid fixed · 1 gap filed |
| job-tracker | gap-enum | 8, ceilinged untriaged | 0 | 14/14 enumerated server paths tested; client untestable (`tkt-44fbaf2be33b`) |
| portfolio-site | gap-enum | 1, ceilinged untriaged | 0 | 8/10 tested · 1 gap filed · 1 fixed in-ticket |
| kanban | gap-enum | 0 (enforced row) | 0 new | 9/10 tested, 8 with a seen-red citation · 1 never-red filed · 1 untestable by design |
| ticket-workflow | gap-enum | 0 | 0 new | 10/10 tested, 6 with a seen-red or lived-failure citation |

Audit tickets: `tkt-6a2232768981` (ES triage) · `tkt-77046457a5df` (ES spot-check) ·
`tkt-98076f541a57` (copart) · `tkt-5375f6c372fa` (job-tracker) · `tkt-ac27a6397884`
(portfolio-site) · `tkt-2282af09404f` (kanban) · `tkt-cf29502c702d` (ticket-workflow).

## The findings that mattered

- **A fully-vacuous guard on live code** (equipment-schedule): the register's unit-companion test
  looped over fields carrying a `unit` — and zero registry fields carry one, so it had checked
  nothing since it landed while the production branch it "covered" shipped. Rewritten against a
  patched clone, with a tripwire that retires the clone the day a real unit ships.
- **A guard blind to the exact edit it guards against** (equipment-schedule): the `replaceName`
  data-loss sweep's regex truncated at a nested call's `)`, so a threaded fourth argument after one
  was invisible — proven by mutation, and the first fix (a hand-rolled scanner) re-opened the same
  hole one character class over. Rebuilt on the TypeScript parser with instrument controls and a
  src-wide only-these-callers sweep.
- **A pre-proven miss re-confirmed at HEAD** (equipment-schedule): the historical
  `void reloadSession(...)` busy-flag bug produces zero new failures today. Fix ticket
  `tkt-f0ddfc4eb102` already carries the full spec.
- **Type-system-aware triage cuts both ways** (copart-filter): two pins proposed by the audit were
  themselves rejected in review as unreachable — the collections they guarded cannot shrink and
  still compile. The reachable fix was extending a measured counts table with a completeness
  assertion, not adding pins.
- **The paths in this baseline had all rotted** (this repo): the 08-17 `projects/` consolidation
  left four rows pointing at nothing; the probe's refuse-to-sweep-nothing guard surfaced it as an
  error instead of a clean 0 — the fail-closed design paying for itself.

## Follow-ups filed by the audit

- `tkt-3bc2ab79d9e5` — copart-filter: `MAX_PAGE` clamp has no test anywhere (gap)
- `tkt-5653fa9faeda` — copart-filter: segment-counts containment check is weaker than it reads (two verified mechanisms)
- `tkt-da7045a4e04f` — portfolio-site: buildEconomics-sourced prose figures have no drift guard
- `tkt-617dd76e51e1` — kanban: `server/packageContract.test.ts` has never been observed red

Pre-existing tickets cited, not re-filed: `tkt-f0ddfc4eb102` (busy-flag test), `tkt-44fbaf2be33b`
(job-tracker client runner), the copart flake set (`tkt-093a61dddfe8`, `tkt-7e2bc0e5eed6`,
`tkt-04addb81b226`), `tkt-9cf7e4750354` (track-steps fail-open, verifiable red-first),
`tkt-63e3c3cc962a` (subagent Edit-blocking half), `tkt-8f27acdb0be5` (portfolio required checks).

## Bookkeeping

`scripts/probe/vacuous-baseline.json` was regenerated in the close-out: ceilings lowered
(equipment-schedule 25 → 11, copart-filter 5 → 4), triaged rows carry `accepted` lists so a future
sweep can tell an old accept from a new candidate at the same count, and
`scripts/probe/vacuous-ratchet.test.mjs` now pins all six ceilings plus the accepted-list/ceiling
correspondence — watched red on a planted raise before this merged. Only kanban's row is enforced
by a gate; the other five ceilings are held by that pin test alone until the probe ships to
consumers (`tkt-d88902f60f7c`'s follow-up).

Deferred-tier repos ending as "sweep ceilinged, mutation deferred" is a complete outcome of the
plan's cost decision, not an oversight. Un-deferring starts from each gap-enum ticket's table.
