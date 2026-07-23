// Shim: write validation now lives in the `ticket-workflow` package (tkt-66f0e22efd5e).
// Named re-exports — see server/tickets.ts for why not `export *`.
export {
  UPDATE_STATUS_ENUM,
  CREATE_STATUS_ENUM,
  validatedStatus,
  extractTicketFields,
} from 'ticket-workflow';
