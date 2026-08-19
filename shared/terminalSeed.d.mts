// Types for terminalSeed.mjs — the implementation must stay .mjs so bare-`node` scripts can import
// it, so the TS side gets its types from here (tkt-812b2b71acbe).
export function seedHomePath(env?: NodeJS.ProcessEnv): string;
export function sessionsRootPath(env?: NodeJS.ProcessEnv): string;
export function validateSetupToken(
  token: unknown,
  options?: { force?: boolean },
): { ok: boolean; reason: string | null };
export const SEED_SIZE_WARN_BYTES: number;
export const SEED_ENTRY_LIMIT: number;
export function measureDirBytes(dir: string, remaining?: { entries: number }): number;
export function measureSeedSize(env?: NodeJS.ProcessEnv): {
  dir: string;
  bytes: number | null;
  error: string | null;
};
export function describeSeedSize(input?: {
  bytes?: number | null;
  error?: string | null;
  dir?: string;
  warnBytes?: number;
}): { level: 'ok' | 'warn'; message: string };
export const SEED_HOME_KEEP: string[];
export const SEED_CLAUDE_KEEP: string[];
export function validateGithubToken(
  token: unknown,
  options?: { force?: boolean },
): { ok: boolean; reason: string | null };
