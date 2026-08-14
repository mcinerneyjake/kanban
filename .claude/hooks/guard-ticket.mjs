// Launcher, not a copy — see guard-bash.mjs in this directory for why the file must exist here and
// why import failure blocks rather than allows (tkt-6e4c55c81208).
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
