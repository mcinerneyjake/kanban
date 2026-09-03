# CLAUDE.md archive — probe discipline & writing these documents

> **Archive — a record, not instructions.** This is prose lifted verbatim out of kanban's
> `CLAUDE.md` when that file was trimmed (`tkt-755358e09d94`, from commit `efcaea4`). It is kept
> because the incidents that paid for each rule are worth finding again, not because it governs
> anything. **`CLAUDE.md` is the only instruction file; where the two disagree, `CLAUDE.md` wins**,
> and nothing here should be read as still-current external state. Regenerate or diff against the
> source with `git show efcaea4:CLAUDE.md`.


---

## Probe discipline

**The general rule — controls, the surprising-result tell, ranking by consequence — now lives in `~/.claude/CLAUDE.md` → *Prove the instrument before reporting its output*, and applies in every repo.** What follows is this repo's instance and its executable precedent (`tkt-d2267fb6bac4`).

This is where the rule was paid for: **~12 confident false results in one 2026-07-15 session**, including a case-sensitive `git log --grep` that undercounted AI-co-authored commits 3× and nearly got a *true* resume claim weakened (`tkt-ceebed633013`). Same shape as the fail-open guard and the transcribed trace — see memory `feedback_validate_probe_with_controls`.

- **Recurring, code-shaped probes get a tested probe with a built-in control that fails loud** — the executable precedent is `scripts/probe/repo-stats.mjs` (+ `.test.mjs`): trailer-aware commit counting whose `assertInstruments` throws rather than return a false zero, and whose test watches the reconstructed broken probe go red. It is also the source for the published repo stats (never hand-transcribe them — see `feedback_generate_dont_transcribe`).
- **The cross-repo sweep is `scripts/probe/vacuous-tests.mjs <root>`** — it takes any repo's path, so run it rather than rebuilding it, and read a `0` only beside another repo's non-zero.
- **Merged-but-undeleted branches: `scripts/probe/merged-branches.mjs <repo-path>`** (`tkt-0993b12650a1`). Ancestry is the wrong instrument — a squash-merge makes a branch's commits non-ancestors of `main`, so `git rev-list main..<branch>` called 11 of 13 branches live when 3 were. This asks GitHub for merged PRs instead, and requires the branch tip to still *be* the merged head: a name matching a merged PR does not mean the commits do. It prints a paste-ready `git branch -D`, which stays a **human** action (`guard-bash` blocks the agent, correctly — see **Concurrent sessions**).
- **NUL bytes in ticket files: `node scripts/probe/nul-bytes.mjs <board-path>`** (`tkt-0fc9ba1b86c2`). One stray NUL makes a ticket file classify as binary, and a binary-skipping grep silently drops it — the live board counted 745 archived one way and 746 the other, both plausible. **Plain `grep(1)` is not the culprit**: this session's `grep` is a shim that execs ugrep with `-I` (binary) and `--ignore-files` (gitignored), so the hazard is the wrapper, not grep. It names the file, byte offset and a marked excerpt, and **exits 2 rather than 0 when it cannot scan** — an absent or empty `tickets/` is never reported as clean. Read-only: it prints the repair rather than applying it, and the intended text is usually a two-character `\0` escape, so substitute rather than delete.
- **Adoption counts for the workflow markers: `node scripts/probe/adoption-markers.mjs [board-root]`** (`tkt-6d0d8a0fe2d2`). Counts the red-first and mutation-check markers on `Tests:` lines, project-scoped, excluding `tickets/.history/**` and fenced code blocks — the two contamination paths hand-rolled counters had: a `.history/` snapshot double-counts any ticket edited after its summary landed, and an unfenced template counts its own paperwork (the shape `tkt-a98723f627df`'s CORRECTION fixed once already). `assertInstruments` throws on a misclassifying control rather than emit a count, and an unscannable board exits 2, never 0. Promotion decisions (`tkt-a98723f627df`, `tkt-06b572e5f00e`) read this probe, never an ad-hoc grep.
- **Stale `in-progress` tickets: `node scripts/probe/stale-in-progress.mjs <board-root>`** (`tkt-3d25ae0626c6`). Reads the **board** — each `in-progress` ticket's `blockers` (resolving every blocker's *status*, never the array's presence) and the ticket's own prose — and never git. Git is the wrong instrument here: the audit this replaces read "no branch" as "no work", which is an unverified negative for any ticket whose deliverable is a human action, and it was wrong on `tkt-639be86eb24d` twice. For anything it cannot account for it prints that ticket's **body tail rather than a verdict**, because the phrase list is incomplete by construction and a human reading the actual words is the check on the instrument — so never change a ticket's status off its output. `assertInstruments` throws rather than emit a count. **Exit `2` is every incomplete scan** — absent or empty `tickets/`, an unreadable file, a crash — never 0, and deliberately not folded into `1`: a partial scan makes every count under-report, so reporting it as an advisory finding would read as a healthy board. Exit `1` is findings, and is **advisory**: `/kanban-workflow` §15 runs it at close and no exit code blocks the close. Each `ok` row names the line that excused it, because a false positive there silences an orphan — the prose phrase `blocked on` was removed for exactly that (it matched 73 of 1264 ticket files, including one heading whose own section says it is satisfied). It can never be a CI gate — `tickets/` is gitignored, so CI cannot see the board at all.
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

