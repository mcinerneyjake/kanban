import express from 'express';
import { ticketsRouter } from './routes/tickets.js';
import { eventsRouter } from './routes/events.js';
import { intakeRouter } from './routes/intake.js';
import { boardRouter } from './routes/board.js';
import { economicsRouter } from './routes/economics.js';
import { streamRouter } from './routes/stream.js';
import { terminalRouter } from './routes/terminal.js';
import { errorHandler } from './middleware/asyncWrap.js';

// Assembles the app from resource routers. Layering: route -> controller ->
// service. No business logic or port bind here (see index.ts).
export const app = express();
app.use(express.json({ limit: '256kb' }));

// tickets CRUD + telemetry both under /api/tickets; paths don't collide (/:id vs /:id/events, /:id/review).
app.use('/api/tickets', ticketsRouter);
app.use('/api/tickets', eventsRouter);
app.use('/api/intake', intakeRouter);
app.use('/api/stream', streamRouter);
app.use('/api', boardRouter);
app.use('/api', economicsRouter);

// Dev-only embedded terminal token endpoint; the WS transport itself is attached in index.ts.
if (process.env.KANBAN_TERMINAL === '1') app.use('/api', terminalRouter);

// Last: catches errors thrown before a wrap()ed handler (e.g. malformed JSON) and keeps the { error } contract.
app.use(errorHandler);
