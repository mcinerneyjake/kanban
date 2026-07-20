#!/usr/bin/env node
// node-pty ships its prebuilt `spawn-helper` WITHOUT the executable bit, so pty.fork
// fails at runtime with "posix_spawnp failed". npm's tar extraction doesn't restore the
// bit and a fresh `npm ci` re-breaks it, so re-apply +x on every install (idempotent,
// no-op where a prebuild/path is absent — e.g. Linux CI only has its own triple).
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.join('node_modules', 'node-pty');
const helpers = [
  ...['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'linux-x64-musl']
    .map((triple) => path.join(root, 'prebuilds', triple, 'spawn-helper')),
  path.join(root, 'build', 'Release', 'spawn-helper'), // source-built fallback
];

let fixed = 0;
for (const helper of helpers) {
  if (existsSync(helper)) { chmodSync(helper, 0o755); fixed++; }
}
console.log(`[postinstall] node-pty spawn-helper +x applied to ${fixed} file(s)`);
