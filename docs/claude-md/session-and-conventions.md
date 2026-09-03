# CLAUDE.md archive — session startup & conventions

> **Archive — a record, not instructions.** This is prose lifted verbatim out of kanban's
> `CLAUDE.md` when that file was trimmed (`tkt-755358e09d94`, from commit `efcaea4`). It is kept
> because the incidents that paid for each rule are worth finding again, not because it governs
> anything. **`CLAUDE.md` is the only instruction file; where the two disagree, `CLAUDE.md` wins**,
> and nothing here should be read as still-current external state. Regenerate or diff against the
> source with `git show efcaea4:CLAUDE.md`.


---

## Session startup (MANDATORY — always do this before anything else)

At the start of every session in this directory, run these steps before responding **when the opening message is a ticket or implementation request** (e.g. "work on X", "fix the bug in Y", "what's left on the board"):

1. Call `list_tickets` to load the board
2. Print a one-line summary: ticket counts by status (e.g. "3 backlog · 2 todo · 1 in-progress")
3. **Recommend the skill as the default path** — see **Recommending `/kanban-workflow`** below, which lists the three cases that suppress it. It owns the whole cycle (selection, premise validation, gates, close), so the steps that follow are the fallback for when it is declined or unavailable, not the primary route. It is a line of output, not a checkpoint: never withhold step 4's direct `start_ticket` behind it.
4. If the user's opening message names a specific ticket (e.g. "work on X", "start ticket Y"), match it against the board and call `start_ticket` directly — skip the selection prompt entirely.
5. Otherwise, if any tickets are `todo`, use `AskUserQuestion` to present a single-select prompt:
   - question: "Which ticket should we start?"
   - header: "Ticket"
   - One option per `todo` ticket: `label` = ticket title, `description` = `[priority] type`
   - Include a final option: label "Skip", description "Don't start a ticket right now"
6. When the user picks a ticket (not Skip), call `start_ticket` with its id — this marks it in-progress and returns the full body so implementation can begin immediately

If no tickets are `todo`, just show the summary and wait for instructions.

**Escape hatch:** If the opening message is a meta, analysis, planning, or configuration request with no ticket implied (e.g. "analyze my workflow", "explain how X works", "update a setting"), skip the board load and address it directly. When genuinely in doubt, do steps 1–2 (they're cheap) and then address the request — but don't force the board on a clearly non-ticket ask. **The recommendation in step 3 sits behind this hatch too** — it fires on the ticket-shaped path only. A front door that opens in front of "explain how X works" is worse than no front door, because it trains the reader to skip past it on the runs where it matters.

### Recommending `/kanban-workflow`

Print the invocation, on its own line, as the recommended way to proceed:

```
/kanban-workflow <project> --gates manual
```

Three things about that line (`tkt-9fbe6c952590`). **One clause of one of them is machine-checked:** `skillContract.test.mjs` pins the literal `--gates` level written *in this file*, requiring it to match `SKILL.md` §15's handoff and to be the level the gate table says asks at every gate. Everything else here is honor-system prose, like the red-first and mutation rules — including the rest of bullet 2, since "not inferred from how the request was phrased" is a claim about a *run*, and nothing observes a run.

- **`<project>` is substituted before printing.** A literal `<project>` is a defect, not a template: the skill's §0 reads the first bare token that is not a ticket id *as* the project name — and a literal `<project>` is not one — so it resolves against a project that is not on the board rather than falling through to §0's own project menu. This is the same obligation `SKILL.md` §15 puts on the handoff block, for the same reason.
- **`--gates manual` is fixed.** Not a level inferred from how the request was phrased, and not the level the last run happened to use. A gate level authorizes *one* run to cross gates on the human's behalf; a startup prompt that pre-filled an auto level would re-grant that authorization to a run nobody approved. `manual` crosses nothing, which is why pre-filling *it* costs no authorization.
- **It is a recommendation, not a redirect.** If the user would rather go straight at a ticket, continue with steps 4–6 — they reach the same board through the same tools.

**Suppress it entirely in these three cases.** A prompt that fires when the answer is already known is not a neutral cost: it teaches the reader to skip the line on the runs where it carries information.

1. **The opening message *is* the invocation.** `SKILL.md` §15 prints `/kanban-workflow <project> --gates manual`, usually followed by the next ticket's id (`tkt-71229c9290b8`), as the paste-ready resume block — so that command is by design the *next session's first message* — and it is ticket-shaped, so the escape hatch does not catch it. Recommending the command the user just ran is the most likely way this prompt ever fires, and the most useless.
2. **The skill is already running this session.** Already-running is not the same as declined, and only the latter would otherwise stop it.
3. **It was declined once already this session.** Ask once.

This is the open-session counterpart to `SKILL.md` §15's close handoff, and the two invocations are asserted to agree — see **Project structure** for what that test does and does not cover.


---

## Temporary scripts

Prefer the MCP tools for all ticket operations — never write a script to mark a ticket done or mutate ticket state; `update_ticket` does that, and `npm run ticket` covers it when the MCP server is down (above). Only when a genuine one-off needs the service layer directly (e.g. a bulk migration across the markdown files) write a script to the project root, run it with `node_modules/.bin/tsx <script>.ts`, then delete it. Do not use `/tmp` or the Claude scratchpad directory — relative imports won't resolve from outside the project root.


---

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


---

## Stack

React + Vite frontend, Express API, markdown files as the database (no SQL).
