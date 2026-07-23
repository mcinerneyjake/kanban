// Shim: the service now lives in the `ticket-workflow` package (tkt-66f0e22efd5e).
// Named re-exports, not `export *` — a barrel would leak the package's whole
// surface through this module AND would silently drop a symbol the package later
// removes; naming them makes that a compile error here instead.
// Note the board root now resolves via the package's paths.ts
// (BOARD_DIR_OVERRIDE ?? CLAUDE_PROJECT_DIR ?? cwd), not __dirname.
export {
  getTicketsDir,
  HttpError,
  listTickets,
  listProjects,
  getTicket,
  createTicket,
  updateTicket,
  archiveStaleTickets,
  searchTickets,
  summarize,
  summarizeBoard,
  deleteTicket,
} from 'ticket-workflow';
