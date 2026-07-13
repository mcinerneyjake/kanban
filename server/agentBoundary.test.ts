import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Architecture guard: the board must stay extractable from the agent. The agent
// may depend on the board (it retrieves over tickets/, uses the MCP tools), but
// the REVERSE edge — board code importing agent/ — is what makes `agent/` a
// build-time dependency of the board and blocks lifting it into its own repo.
// This test confines that reverse edge to a tiny, deliberate seam so extraction
// stays a bounded job rather than a whole-server rewrite. See tkt-c47f4c1eef18.
//
// If this fails: a new board file imported from agent/. Either route through one
// of the seam files below, or — if the coupling is truly warranted — add it here
// as a conscious decision, not a drift.
const ALLOWED = new Set([
  'server/controllers/intake.ts',    // the intake endpoints (search/propose/health)
  'server/controllers/economics.ts', // the run-log economics endpoint
  'server/index.ts',                 // best-effort index warm on boot (.catch swallows)
]);

// Board roots that must not depend on the agent (agent/ importing itself is fine
// and not scanned).
const ROOTS = ['src', 'server', 'shared', 'mcp'];

// A relative import whose path descends into agent/ — `from '../agent/…'`,
// `from '../../agent/…'`, etc.
const AGENT_IMPORT = /from\s+['"](?:\.\.?\/)+agent\//;

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('agent extraction boundary', () => {
  it('only the allowlisted seam files import from agent/', () => {
    const offenders = ROOTS
      .flatMap(sourceFiles)
      .filter((file) => AGENT_IMPORT.test(fs.readFileSync(file, 'utf8')))
      .filter((file) => !ALLOWED.has(file));

    expect(
      offenders,
      `board code outside the extraction seam imports from agent/ (see tkt-c47f4c1eef18): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
