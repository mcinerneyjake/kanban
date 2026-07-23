// Types for terminalSeed.mjs — the implementation must stay .mjs so bare-`node` scripts can import
// it, so the TS side gets its types from here (tkt-812b2b71acbe).
export function seedHomePath(env?: NodeJS.ProcessEnv): string;
export function sessionsRootPath(env?: NodeJS.ProcessEnv): string;
export function validateSetupToken(
  token: unknown,
  options?: { force?: boolean },
): { ok: boolean; reason: string | null };
