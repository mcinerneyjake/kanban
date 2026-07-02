import express from 'express';
import { ticketsRouter } from './routes/tickets.js';
import { eventsRouter } from './routes/events.js';
import { intakeRouter } from './routes/intake.js';
import { boardRouter } from './routes/board.js';
import { streamRouter } from './routes/stream.js';
import { errorHandler } from './middleware/asyncWrap.js';

// Assembles the Express app from the resource routers. Layering:
//   route (wiring) -> controller (parse/validate/shape) -> service (logic/IO).
// This module owns neither business logic nor the port bind (see index.ts).
export const app = express();
app.use(express.json({ limit: '256kb' }));

// tickets CRUD and the ticket telemetry endpoints both live under /api/tickets;
// their paths don't collide (/:id vs /:id/events, /:id/review).
app.use('/api/tickets', ticketsRouter);
app.use('/api/tickets', eventsRouter);
app.use('/api/intake', intakeRouter);
app.use('/api/stream', streamRouter);
app.use('/api', boardRouter);

// Last: catches errors thrown before a wrap()ed handler (e.g. a malformed JSON
// body rejected by express.json) and keeps them on the { error } JSON contract.
app.use(errorHandler);
