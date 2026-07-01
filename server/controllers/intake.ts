import type { Request, Response } from 'express';
import { getTicketIndex } from '../../agent/indexCache.js';
import { RuntimeChatClient } from '../../agent/llm.js';
import { proposeIntake } from '../../agent/propose.js';
import { HttpError } from '../tickets.js';
import type { IntakeSearchRequest, IntakeProposeRequest } from '../schemas/intake.js';

// Both intake endpoints depend on the local LLM runtime (embedder + chat model).
// When it is down the agent layer throws a plain Error — it is deliberately
// HTTP-agnostic (local-first). Translating "runtime unavailable" -> 503 is an
// HTTP concern, so it lives HERE, in one place, rather than being copy-pasted
// per endpoint. A real bug inside the agent still surfaces as its own message.
async function requireRuntime<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw new HttpError(503, `Intake unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function search(_req: Request, res: Response, input: IntakeSearchRequest): Promise<void> {
  const results = await requireRuntime(async () => {
    const index = await getTicketIndex();
    return index.search(input.query, input.limit);
  });
  res.json({ results });
}

export async function propose(_req: Request, res: Response, input: IntakeProposeRequest): Promise<void> {
  const proposal = await requireRuntime(async () => {
    const index = await getTicketIndex();
    return proposeIntake(input.report, { chat: RuntimeChatClient.fromEnv(), index });
  });
  res.json(proposal);
}

// Liveness probe for the drafting model. Never 503s — it reports availability so
// the create UI can fall back to manual entry.
export async function health(_req: Request, res: Response): Promise<void> {
  res.json({ available: await RuntimeChatClient.fromEnv().available() });
}
