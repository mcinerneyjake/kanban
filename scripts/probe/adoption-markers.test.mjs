import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  MARKERS, stripFences, classifyDoc, assertInstruments, scanBoard,
} from './adoption-markers.mjs';

// tkt-6d0d8a0fe2d2. The defects this file pins: a `.history/` snapshot double-counting a live
// ticket's marker, and an unfenced template counting paperwork as adoption — each shown against a
// reconstructed broken variant, so the lie is watched, not asserted from memory. The review round
// added four more, each executed before fixing: raw-text project extraction, toggle-based fence
// closing, marker cross-matching, and the typo'd-scope clean zero.

const CLI = fileURLToPath(new URL('./adoption-markers.mjs', import.meta.url));

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-probe-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ticket = (project, body) => `---\ntitle: t\nproject: ${project}\n---\n\n${body}\n`;
const RED_FIRST = 'Tests: 1 added — repro name (written first, observed red)';
const MUTATION = 'Tests: 2 added — coverage; mutation: src/lib/x.ts:40 flipped, observed red';
const NONE_CATCHABLE = 'Tests: 2 added — coverage; mutation: none catchable — only e2e drives it';

function board(files) {
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(tmp, 'tickets', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return tmp;
}

describe('classifyDoc', () => {
  it('counts each marker only on a Tests: line', () => {
    expect(classifyDoc(ticket('kanban', RED_FIRST))).toMatchObject({ redFirst: true, mutationCheck: false });
    expect(classifyDoc(ticket('kanban', MUTATION))).toMatchObject({ redFirst: false, mutationCheck: true });
    expect(classifyDoc(ticket('kanban', 'the marker written first, observed red, and mutation: x flipped, observed red')))
      .toMatchObject({ redFirst: false, mutationCheck: false });
  });

  it('a wrapped continuation line does not carry the Tests: anchor — it silently counts as nothing', () => {
    const doc = ticket('kanban', 'Tests: 10 added — a description that wraps\nonto the next line; mutation: f.mjs:48 flipped, observed red');
    expect(classifyDoc(doc)).toMatchObject({ redFirst: false, mutationCheck: false, noneCatchable: false });
  });

  it('the none-catchable escape hatch is its own category — an escape-hatch user is not a non-adopter', () => {
    expect(classifyDoc(ticket('kanban', NONE_CATCHABLE)))
      .toMatchObject({ mutationCheck: false, noneCatchable: true });
  });

  it('a red-first line whose test NAME contains "mutation: " counts once, not twice', () => {
    const doc = ticket('kanban', 'Tests: 1 added — mutation: harness repro (written first, observed red)');
    expect(classifyDoc(doc)).toMatchObject({ redFirst: true, mutationCheck: false });
    // the pre-review regex, reconstructed: no `flipped,` requirement — the inflation, watched
    expect(/^Tests:.*mutation: .*observed red/m.test(doc)).toBe(true);
  });

  it('never counts the audit-fix phrase, which shares no literal with any marker', () => {
    const doc = ticket('kanban', 'Tests: 3 fixed — pinned lengths; emptying-mutation control went red, reverted');
    expect(classifyDoc(doc)).toMatchObject({ redFirst: false, mutationCheck: false, noneCatchable: false });
  });

  it('a fenced template is paperwork, not adoption — and the unstripped classifier lies here', () => {
    const doc = ticket('kanban', `Record it as:\n\`\`\`\n${RED_FIRST}\n${MUTATION}\n\`\`\``);
    expect(classifyDoc(doc)).toMatchObject({ redFirst: false, mutationCheck: false });

    // the broken variant: same regexes, no fence stripping — the pre-probe hand-rolled counter
    const naive = { redFirst: MARKERS.redFirst.test(doc), mutationCheck: MARKERS.mutationCheck.test(doc) };
    expect(naive).toEqual({ redFirst: true, mutationCheck: true }); // the lie, watched
  });

  it('only a matching run of the SAME fence character closes a fence — ~~~ inside ``` is content', () => {
    const doc = ticket('kanban', `\`\`\`\n~~~\n${RED_FIRST}\n\`\`\``);
    expect(classifyDoc(doc)).toMatchObject({ redFirst: false });
    // the broken variant: any fence marker toggles — the ~~~ "closes" and the template re-exposes
    let fenced = false;
    const naiveStripped = doc.split('\n').map((l) => {
      if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return ''; }
      return fenced ? '' : l;
    }).join('\n');
    expect(MARKERS.redFirst.test(naiveStripped)).toBe(true); // the lie, watched
  });

  it('an unclosed fence blanks to EOF — malformed bodies fail toward not-counted', () => {
    expect(classifyDoc(ticket('kanban', `\`\`\`\n${RED_FIRST}`))).toMatchObject({ redFirst: false });
    expect(stripFences('a\n```\nb\nc')).toBe('a\n\n\n');
  });

  it('project comes from parsed frontmatter, not a match-anywhere regex over the raw text', () => {
    // a fenced frontmatter EXAMPLE in the body must not set the scoping field
    const noProject = `---\ntitle: t\n---\n\nAn example:\n\`\`\`\nproject: kanban\n\`\`\`\n${RED_FIRST}\n`;
    expect(classifyDoc(noProject).project).toBeNull();
    // a js-yaml-quoted value scopes by VALUE, not by its quoted spelling
    expect(classifyDoc(`---\nproject: 'kanban'\n---\n${RED_FIRST}\n`).project).toBe('kanban');
    // an unfenced body project: line (one live ticket has one) still must not set it
    expect(classifyDoc(`---\ntitle: t\n---\n\nproject: kanban\n${RED_FIRST}\n`).project).toBeNull();
  });
});

describe('assertInstruments', () => {
  it('passes on the shipped classifier', () => {
    expect(() => assertInstruments()).not.toThrow();
  });

  it('throws on a misclassifying classifier — the throw path watched red, not assumed', () => {
    const blind = () => ({ project: 'kanban', redFirst: false, mutationCheck: false, noneCatchable: false });
    expect(() => assertInstruments(blind)).toThrow(/misclassified/);
    const projectless = (doc) => ({ ...classifyDoc(doc), project: null });
    expect(() => assertInstruments(projectless)).toThrow(/lost its project field/);
  });
});

describe('scanBoard', () => {
  it('counts per marker with ids, scoped to the requested project, reporting the unattributed', () => {
    const root = board({
      'tkt-aaa.md': ticket('kanban', RED_FIRST),
      'tkt-bbb.md': ticket('kanban', MUTATION),
      'tkt-ccc.md': ticket('kanban', NONE_CATCHABLE),
      'tkt-ddd.md': ticket('portfolio-site', RED_FIRST), // wrong project: never counted
      'tkt-eee.md': `---\ntitle: no project\n---\n\n${RED_FIRST}\n`, // unattributed: visible, not counted
    });
    const got = scanBoard(root);
    expect(got).toMatchObject({ scanned: 5, matchedProject: 3, unattributed: 1 });
    expect(got.redFirst).toEqual({ count: 1, ids: ['tkt-aaa'] });
    expect(got.mutationCheck).toEqual({ count: 1, ids: ['tkt-bbb'] });
    expect(got.noneCatchable).toEqual({ count: 1, ids: ['tkt-ccc'] });
    expect(scanBoard(root, { project: 'portfolio-site' }).redFirst.count).toBe(1);
  });

  it('excludes .history snapshots — where the recursive naive walker double-counts', () => {
    const root = board({
      'tkt-aaa.md': ticket('kanban', RED_FIRST),
      '.history/tkt-aaa/2026-08-17T00-00-00Z.md': ticket('kanban', RED_FIRST),
      '.history/tkt-gone/2026-08-01T00-00-00Z.md': ticket('kanban', MUTATION), // ghost of a deleted ticket
    });
    const got = scanBoard(root);
    expect(got.scanned).toBe(1);
    expect(got.redFirst.count).toBe(1);
    expect(got.mutationCheck.count).toBe(0);

    // the broken variant: the tkt-a98723f627df trigger's walker, which recurses everything
    const naiveWalk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? naiveWalk(path.join(d, e.name)) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []
    ));
    const naiveFiles = naiveWalk(path.join(root, 'tickets'));
    expect(naiveFiles).toHaveLength(3); // the mutation applied: it really does see the snapshots
    const naiveRedFirst = naiveFiles
      .filter((f) => MARKERS.redFirst.test(fs.readFileSync(f, 'utf8'))).length;
    expect(naiveRedFirst).toBe(2); // the double-count, watched
  });

  it('refuses to report on a board it cannot scan', () => {
    expect(() => scanBoard(tmp)).toThrow(/no tickets\/ directory/);
    fs.mkdirSync(path.join(tmp, 'tickets'));
    expect(() => scanBoard(tmp)).toThrow(/scanned 0 ticket files/);
  });

  it('refuses a scope that selects nothing — a typo\'d project is not zero adoption', () => {
    const root = board({
      'tkt-aaa.md': ticket('kanban', RED_FIRST),
      'tkt-zzz.md': ticket('equipment-schedule', 'Tests: none — docs only'),
    });
    expect(() => scanBoard(root, { project: 'kanbn' })).toThrow(/matched 0 of 2/);
    // the contrast that defines legitimate zero: matchedProject > 0, no markers
    const legit = scanBoard(root, { project: 'equipment-schedule' });
    expect(legit.matchedProject).toBe(1);
    expect(legit.redFirst.count).toBe(0);
  });
});

describe('CLI', () => {
  it('prints the JSON report for a scannable board', () => {
    const root = board({ 'tkt-aaa.md': ticket('kanban', MUTATION) });
    const out = execFileSync(process.execPath, [CLI, root], { encoding: 'utf8' });
    expect(JSON.parse(out)).toMatchObject({
      project: 'kanban',
      mutationCheck: { count: 1, ids: ['tkt-aaa'] },
      redFirst: { count: 0, ids: [] },
    });
  });

  it('exits 2, not 0, on an unscannable board or an unmatchable --project', () => {
    const status = (args) => {
      try {
        execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
        return 0;
      } catch (err) {
        return err.status;
      }
    };
    expect(status([tmp])).toBe(2);
    const root = board({ 'tkt-aaa.md': ticket('kanban', RED_FIRST) });
    expect(status([root, '--project=kanbn'])).toBe(2);
  });
});
