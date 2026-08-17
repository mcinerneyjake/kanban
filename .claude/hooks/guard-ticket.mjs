// Launcher, not a copy — see guard-bash.mjs in this directory for why the file must exist here and
// why import failure blocks rather than allows (tkt-6e4c55c81208).
//
// The launcher is where kanban's intake vocabulary belongs: the guard is wired at USER scope, so the
// package's shipped default has to be actionable in repos that have no `npm run agent` at all
// (tkt-0361525dbf9f). Set BEFORE the import, since the hook reads it per call off process.env.
//
// `--create-only` is load-bearing, not decoration: it drops update_ticket from the agent's toolset, so
// a mis-matched retrieval can only ever create a duplicate, never clobber an existing ticket's body.
// The message a blocked session reads is the one moment that guidance is needed, so it says so here
// rather than relying on the session having read CLAUDE.md.
process.env.TICKET_WORKFLOW_CREATE_REASON =
  'create_ticket is authored by the local intake agent, not Claude, so every new ticket carries a ' +
  'metered local-LLM usage record. Run `npm run agent -- --yes --create-only "<report>"` from the ' +
  'kanban checkout. `--create-only` is REQUIRED: it drops update_ticket from the agent\'s toolset so a ' +
  'mis-matched retrieval can only create a duplicate, never overwrite an existing ticket. ONE ISSUE ' +
  'PER RUN — a report covering several things gets sprayed into thin tickets, and an enumeration ' +
  'inside prose counts as several; make one run per issue and add sub-parts yourself with ' +
  'update_ticket. Then `get_ticket` the result and check its classification. If the local model is ' +
  'unavailable (agent exits non-zero / GET /api/intake/health is down), tell the user the local ' +
  'runtime is unavailable — do NOT author the ticket yourself, which would create an untracked one. ' +
  'update_ticket (summaries, structured fields, directed edits) and delete_ticket remain Claude\'s. ' +
  'See CLAUDE.md → Ticket creation flow.';

try {
  const { main } = await import('ticket-workflow/hooks/guard-ticket.mjs');
  if (typeof main !== 'function') {
    throw new TypeError('the installed ticket-workflow exports no callable main — pin too old?');
  }
  await main();
} catch (err) {
  process.stderr.write(
    `[guard-ticket] BLOCKED: could not run the guard from ticket-workflow (${err?.code ?? err?.message ?? 'import failed'}).\n` +
      'create_ticket stays blocked until this resolves — run `npm ci` from a plain terminal.\n',
  );
  process.exit(2);
}
