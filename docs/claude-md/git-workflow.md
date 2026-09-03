# CLAUDE.md archive — git workflow, gates & worktrees

> **Archive — a record, not instructions.** This is prose lifted verbatim out of kanban's
> `CLAUDE.md` when that file was trimmed (`tkt-755358e09d94`, from commit `efcaea4`). It is kept
> because the incidents that paid for each rule are worth finding again, not because it governs
> anything. **`CLAUDE.md` is the only instruction file; where the two disagree, `CLAUDE.md` wins**,
> and nothing here should be read as still-current external state. Regenerate or diff against the
> source with `git show efcaea4:CLAUDE.md`.


---

## Concurrent sessions: one worktree each

Two sessions sharing one working tree is not safe — whichever stages a shared file first silently
absorbs the other's in-flight edits, and any commit lands on whatever branch the checkout happens to
be on, regardless of which session made it (`tkt-4b74943a319e`). **Give each concurrent session its
own git worktree.**

Use Claude Code's built-in support — do **not** hand-roll a convention. `EnterWorktree` creates
`.claude/worktrees/<name>` on a branch cut from a fresh `origin/main`; `ExitWorktree` removes it (and
auto-removes it if nothing changed). The Agent tool takes `isolation: "worktree"` for the same thing.
`.claude/worktrees` is gitignored — no trailing slash, so the rule matches a SYMLINKED worktree too
(the `gitignore` audit check rejects the slashed form) — and a worktree never shows up as untracked here.

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
> **Who runs it depends on the mode.** By default Jake runs it himself. In the `/kanban-workflow` skill's `--gates auto-commit` / `--gates auto-pr`, he has pre-authorized the skill to run it, lifting only the "Jake personally" part. **The tracked skill now implements that** (`tkt-abaff4ebd8b3`): its §10 runs the review — target repo named, effort calibrated, `record_review` at the end — and its §9 folds this repo's mutation check and red-first rule into the skill's quality gate in every mode. Its gate table carries a **review** gate no level can skip. **Do not read that table's shape from this paragraph** — read `skillContract.test.mjs`, which fails the gate if the columns or any cell drift from the allowlist it carries; a hand-copy here is exactly what went stale last time. (The claim this replaces — "nothing in it invokes `/code-review`" — is best read as wrong when written rather than as one that aged out: it described the since-deleted `~/.claude/` copy, so it is now unverifiable by any means, and the first *tracked* `SKILL.md` (`145cdd1`) already invoked one.) **Two limits, both load-bearing.** No test asserts that a *run* obeys the table — whether a review actually happened on a given ticket is the `record_review` question below, unchanged by this. And this is a claim about the tracked **file**: per **Project structure**, that copy has never been observed loading, so until the one-invocation probe named there is run, "the skill does X" means "the file says X". **The skill is no longer machine-local** (`tkt-e18d0c20d6b6`): it lives at `.claude/skills/kanban-workflow/SKILL.md`, tracked here, so a change to it is a reviewable diff and a fresh clone gets it — unlike `guard-subagent-gates` and the `track-steps` writer, which keep that caveat. What a fresh clone does *not* get is its gitignored `repos.local.json` (see **Project structure**). **The merge gate stays human in every mode.**
>
> **The review gate is not enforced today — but it is enforceable, and the mechanism is already installed.** Note first that *no* gate here is enforced in the sense of "approval was obtained": `guard-bash` blocks dangerous **shapes** of the `git` commands (a commit on `main`, a force-push), never the absence of a confirmation, and it does not inspect `gh` at all — so `gh pr create` and `gh pr merge` both pass it untouched, leaving only the commit gate's `git commit` and the PR gate's `git push` in its path at all.
>
> What makes the review gate different is *precision*, not possibility. The pinned package ships a `record_review` MCP tool (allowlisted in `.claude/settings.json`) that appends a `review` milestone to `events/<id>.jsonl`, and the `/kanban-workflow` skill already calls it — so a `PreToolUse` hook could refuse a `git push` on a ticket with no such event. The reason that is not a gate yet, and it is worse than imprecision: `review` has **two writers**, and one of them fires automatically. `hooks/track-steps.mjs`'s `recordsFor` pushes `review: reached` on *every passing commit* (genuinely gated on the outcome only since v0.21.0 — before it, every command recorded `passed`, so a *failing* commit produced one too), so the milestone is present on nearly every ticket whether or not a review happened — the package's own `verify/rules.js` classifies it `AMBIGUOUS` and says "its presence witnesses neither one." It also carries no sha, so it cannot say *what* was reviewed. **Gating on the event as it stands would be a rubber stamp**, which is why the fix is to bind to content (`tkt-55080f378279`) rather than to wire a hook against today's record. Binding the gate to content is `tkt-55080f378279`. **Until then, do not report the review gate as enforced — and do not report it as unenforceable either.** There is also no CI substitute: the `code-review` workflow is `disabled_manually` as of 2026-08-17, so the review gate is the only *automated-tooling* review this repo gets, alongside the human diff-read in step 6 (see **3. PR**).

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

