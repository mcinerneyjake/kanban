import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedBoard } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '..', 'seed');
const seedCount = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.md')).length;

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('seedBoard', () => {
  it('copies all seed tickets into an empty target', () => {
    const ticketsDir = path.join(tmp, 'tickets');
    const result = seedBoard({ seedDir: SEED_DIR, ticketsDir });
    expect(result.skipped).toBe(false);
    expect(result.copied).toBe(seedCount);
    expect(fs.readdirSync(ticketsDir).filter((f) => f.endsWith('.md')).length).toBe(seedCount);
  });

  it('skips when the target already has tickets (no clobber)', () => {
    const ticketsDir = path.join(tmp, 'tickets');
    fs.mkdirSync(ticketsDir, { recursive: true });
    fs.writeFileSync(path.join(ticketsDir, 'tkt-existing.md'), '---\ntitle: x\n---\n');
    const result = seedBoard({ seedDir: SEED_DIR, ticketsDir });
    expect(result.skipped).toBe(true);
    expect(result.copied).toBe(0);
    expect(fs.readdirSync(ticketsDir)).toEqual(['tkt-existing.md']);
  });
});
