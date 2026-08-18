// Hand-written pair to the .mjs shim (the shared/terminalSeed.d.mts pattern). Every name resolves
// against the pinned package's own types, so a pin bump that drops one fails `tsc` — the runtime
// export list is asserted separately in server/packageContract.test.ts.
export { sweep, testBlocks, screenBlock, assertInstruments, controlFailures, CONTROLS, HITS } from 'ticket-workflow';
