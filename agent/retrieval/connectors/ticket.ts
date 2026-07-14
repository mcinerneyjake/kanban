import { listTickets } from '../../../server/tickets.js';
import { type Ticket } from '../../../shared/constants.js';
import { type Document } from '../retrieval.js';
import { type Connector } from './connector.js';

// The kanban board as a connector. Ticket-specific knowledge lives here and nowhere else: title+body is the embeddable text, `status` rides through in `meta`, `updated` feeds the index cache's change signature.
export class TicketConnector implements Connector<Ticket> {
  readonly source = 'kanban';

  pull(): Promise<Ticket[]> {
    return listTickets();
  }

  toDocument(t: Ticket): Document {
    return {
      id: t.id,
      source: this.source,
      title: t.title,
      text: `${t.title}\n\n${t.body}`.trim(),
      updated: t.updated,
      meta: { status: t.status },
    };
  }
}
