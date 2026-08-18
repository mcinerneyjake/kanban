#!/usr/bin/env node
/**
 * Shim over the packaged vacuous-tests probe (tkt-05b1630bb53a). The engine — parser, controls,
 * sweep — lives in ticket-workflow (src/vacuous/) with its control suite; that suite runs at
 * upstream HEAD, so server/packageContract.test.ts asserts the PINNED build through this shim.
 * Counts are still FLOORS, not totals — see vacuous-baseline.json's _countsAreFloors.
 */
export { sweep, testBlocks, screenBlock, assertInstruments, controlFailures, CONTROLS, HITS } from 'ticket-workflow';

import { sweep } from 'ticket-workflow';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI preserved: `node scripts/probe/vacuous-tests.mjs <root>` prints the same JSON as
// `ticket-workflow vacuous <root>`. A broken instrument or an empty sweep throws and exits non-zero.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(sweep(process.argv[2] ?? process.cwd()), null, 2));
}
