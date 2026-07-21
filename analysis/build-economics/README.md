# Build economics — what it cost (and saved) to build this with Claude

A reconstruction, from Claude Code session telemetry, of the cost and time to build the **kanban repo
(app + `agent/` = agentic-rag-demo) + ticket-workflow** with Claude vs. by hand.

`kanban-savings.json` is a frozen, aggregates-only snapshot (`asOf` in the file). `analyze-kanban-savings.mjs`
is the script that produced it.

## Headline

**Publicly verifiable** (reproduce with `git` — see below):

| | |
|---|---|
| Merged PRs | **155** (154 kanban + 1 ticket-workflow) |
| Lines of code | **26,693** |
| Supervised hours (union wall-clock) | **~110** over 29 days |
| Velocity | **~5.3 PRs/day** |

**Self-reported** (from private local session transcripts — *not* independently reproducible):

| | |
|---|---|
| Claude cost (API list price) | **~$2,485** completed-only / ~$2,559 all sessions |
| Tokens / billed responses | 3.2B / 17,628 |

**Estimated savings** — the by-hand counterfactual is anchored on **155 merged PRs × a deliberately-low
2–3 hours each** (git-verifiable unit; adjust to taste):

| | |
|---|---|
| Time saved | **~200–355 hrs (~5–9 weeks)** |
| Value (engineering time avoided @ $100/hr) | **~$29k–$44k** |
| ROI (hand cost ÷ Claude cost) | **~12–19×** |

> The measured side is exact; the by-hand side is an estimate. Lead with the verifiable facts; treat the
> dollar figures as a labelled, conservative, self-measured estimate.

## Four measurement audits (why the naive numbers are wrong)

1. **Dedup by `message.id`.** Claude Code logs each streaming response multiple times (same id, growing
   `output_tokens`; input/cache constant). Counting each log line overcounts billed tokens **~2.4×**. We keep
   one record per `message.id` (the max-output/final one).
2. **Scope by repo.** The `tickets/` and `events/` dirs are a **central board across all projects**. We scope
   to this repo + ticket-workflow and exclude billed responses whose branch resolves to another repo's ticket
   (a ~$162 portfolio-site leak). Unattributed main-branch work (~45% of cost) is kept as in-repo.
3. **Counterfactual = merged PRs, not tickets.** Ticket counts are unreliable here (central board; the
   events-tracking hook was installed partway through, so a milestone-gated ticket count under-counted ~3×).
   Merged PRs are the git-verifiable unit.
4. **Supervision = union wall-clock.** Concurrent sessions are unioned (all top-level timestamps sorted
   together, capped gaps summed), not summed per-session — otherwise overlapping sessions double-count.

## Disclosures (limitations we can't fully resolve)

- **The dollar cost is self-reported** from private local transcripts and is not independently reproducible.
  Only PRs / LOC / supervised-hours / velocity are publicly verifiable.
- **The cost is a floor:** CI code-review API usage runs on GitHub Actions, not in local transcripts, and is
  not counted — so real Claude cost is somewhat higher (and true savings somewhat lower).
- Priced at standard list rates assuming **no >200K 1M-context premium**.
- Tokens are **measured**; the dollar figure is the **assumed** cloud-equivalent (list price).

## Reproduce

Publicly verifiable facts (anyone, any clone):

```sh
git log --oneline | grep -Ec '\(#[0-9]+\)'                 # merged PRs
git ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.css' '*.scss' '*.html' \
  | grep -Ev 'node_modules|dist/|\.min\.' | xargs wc -l | tail -1   # LOC
```

Full run (only on the machine whose `~/.claude` holds the sessions):

```sh
node analyze-kanban-savings.mjs        # regenerates kanban-savings.json in place
# env overrides: KANBAN_REPO, TW_REPO, OUT
```

The script emits **aggregates only** — no per-ticket titles, no absolute user paths — so the snapshot is safe
to keep in a public repo.

## Files

- `analyze-kanban-savings.mjs` — the analysis (parses transcripts, dedups, scopes, prices, PR-anchors).
- `kanban-savings.json` — the frozen aggregates-only snapshot the app + case study read from.
