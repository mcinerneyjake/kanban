# Demo board — curated, public-safe corpus for the replay-viewer traces

These 10 tickets are a **fictionalized-but-realistic, public-safe** snapshot of this project's own
backlog (MCP server, guard hook, definition-of-done gate, intake agent, cost model, e2e, the
`list_tickets` overflow bug, drag-and-drop, a11y, and the replay viewer itself). They exist to be the
corpus the intake agent searches when recording the demo traces shown in the portfolio replay viewer
(`portfolio-site/src/content/traces/ai-native-workflow/`).

Why a curated board: recording against the **real** central board would put private, non-shareable
ticket titles into the `retrieval` step, which the viewer displays. This board is safe to show by
construction — nothing here is sensitive, and the `tkt-` ids match the real id convention so the
agent's prose references resolve cleanly.

## Regenerating the three traces

Recording **mutates** state (a create/update run writes a ticket; runs also append to `runs/` and
`events/`), so isolate **all three** dir overrides to throwaway copies — never point them at the real
board. Reset the board from this pristine seed between runs. Requires a local OpenAI-compatible endpoint
serving a chat model (`LLM_MODEL`, e.g. `openai/gpt-oss-20b`) and an embeddings model (`EMBED_MODEL`);
the traces were recorded against `gpt-oss-20b`.

```bash
SEED=test-support/demo-board
WORK=$(mktemp -d); EVT=$(mktemp -d); RUNS=$(mktemp -d)
cp "$SEED"/*.md "$WORK"/          # fresh copy per run (create/update mutate it)

TICKETS_DIR_OVERRIDE="$WORK" EVENTS_DIR_OVERRIDE="$EVT" RUNS_DIR_OVERRIDE="$RUNS" \
  npm run agent:record -- --out traces/create.json \
  "Add a keyboard shortcut that opens a quick-jump palette, so you can go straight to any ticket by typing part of its id or title."
```

The three notes used (each run reset from the seed first):

- **create** — the quick-jump palette note above → no existing match → the agent creates a ticket.
- **update** — *"We hit the list_tickets overflow for real today: with around 440 tickets the tool
  returned a truncated payload … it should fail loudly instead of quietly truncating, and we should
  document the status and project filters as the workaround."* → matches the open `list_tickets` bug →
  the agent updates it.
- **decline** — add `--decline`, note *"We should add a safety hook that blocks dangerous git commands
  like force-pushing or committing straight to main."* → matches the **done** guard-hook ticket → the
  agent proposes a duplicate and the reviewer declines it.

Outcomes are **model-decided, not deterministic** — expect to re-run until each comes out clean (the
update note must add *new* detail or the model no-ops; the decline note must duplicate *done* work so
the model's summary coherently explains the decline). Then copy the validated JSON into the portfolio
repo's vendored trace modules.
