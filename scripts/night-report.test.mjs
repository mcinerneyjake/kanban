import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, jsonOr, resolveOwner, renderTicket, EXIT, REPORT_USAGE } from './night-report.mjs';

// Fixtures inside the repo, never os.tmpdir(): no suite writes outside the workspace.
const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), '.tmp-test');

const ID = 'tkt-aaaaaaaaaaaa';
let root;

function sink() {
  const chunks = [];
  return { write: (t) => chunks.push(t), get text() { return chunks.join(''); } };
}

function seedOutstanding(status = 'qa') {
  const dir = join(root, '.night-run', '2026-09-03T01-00-00-000Z');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      startedAt: 'x',
      queue: [ID],
      results: [{ id: ID, before: 'todo', after: 'qa', level: 'ok', text: 'PR open, awaiting your merge' }],
      exit: 0,
    }),
  );
  mkdirSync(join(root, 'tickets'), { recursive: true });
  writeFileSync(join(root, 'tickets', `${ID}.md`), `---\nid: ${ID}\nstatus: ${status}\n---\n\nbody\n`);
}

// A gh double driven by the argv shape, so each test states only the responses it cares about.
function fakeGh(responses) {
  return (args) => {
    if (args[0] === 'repo') return responses.owner ?? { status: 0, stdout: 'someowner\n', stderr: '' };
    if (args[0] === 'search') return responses.search ?? { status: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'pr') return responses.checks ?? { status: 0, stdout: '[]', stderr: '' };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

const PR = {
  number: 83,
  url: 'https://example.invalid/pull/83',
  state: 'merged',
  title: 'Some title',
  repository: { nameWithOwner: 'someowner/other-repo' },
};

beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, 'night-report-cli-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const runMain = (argv, responses) => {
  const out = sink();
  const err = sink();
  const code = main(argv, { gh: fakeGh(responses ?? {}), resolveRoot: () => root, out, err });
  return { code, out: out.text, err: err.text };
};

describe('night:report', () => {
  it('prints verdict, status, PR identity and every check name with its conclusion', () => {
    seedOutstanding('qa');
    const { code, out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: {
        status: 0,
        stdout: JSON.stringify([
          { name: 'gate', state: 'SUCCESS', bucket: 'pass' },
          { name: 'branch-name', state: 'FAILURE', bucket: 'fail' },
        ]),
        stderr: '',
      },
    });

    expect(code).toBe(EXIT.ok);
    expect(out).toContain(`${ID}  status: qa`);
    expect(out).toContain('verdict (2026-09-03T01-00-00-000Z): ok');
    expect(out).toContain('someowner/other-repo#83 [merged]');
    expect(out).toContain('https://example.invalid/pull/83');
    expect(out).toContain('check gate: SUCCESS');
    expect(out).toContain('check branch-name: FAILURE');
  });

  // The whole reason this uses `gh search prs`: a rolled-up verdict is exactly what a disabled
  // workflow makes wrong, so no line may claim one.
  it('never prints a rolled-up green/red verdict', () => {
    seedOutstanding('qa');
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: { status: 0, stdout: JSON.stringify([{ name: 'gate', state: 'SUCCESS', bucket: 'pass' }]), stderr: '' },
    });

    expect(out).not.toMatch(/\ball checks pass(ed|ing)?\b/i);
    expect(out).not.toMatch(/\bgreen\b/i);
    expect(out).not.toMatch(/\bready to merge\b/i);
  });

  it('calls it out when a PR reports no checks, rather than reading empty as green', () => {
    seedOutstanding('qa');
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: { status: 0, stdout: '[]', stderr: '' },
    });

    expect(out).toContain('no checks reported');
    expect(out).toContain('disabled workflow contributes none');
  });

  it('reports a checks lookup that failed instead of dropping the PR', () => {
    seedOutstanding('qa');
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: { status: 1, stdout: '', stderr: 'no checks reported on the feat/x branch' },
    });

    expect(out).toContain('checks could NOT be listed');
    expect(out).toContain('no checks reported on the feat/x branch');
  });

  it('prints every full-text match, because not all of them are the ticket\'s PR', () => {
    seedOutstanding('qa');
    const other = { ...PR, number: 66, repository: { nameWithOwner: 'someowner/kanban' }, title: 'Mentions it' };
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR, other]), stderr: '' },
    });

    expect(out).toContain('2 PR(s) mention this id');
    expect(out).toContain('full-text search');
    expect(out).toContain('someowner/other-repo#83');
    expect(out).toContain('someowner/kanban#66');
  });

  it('does not read an empty search as proof that no PR exists', () => {
    seedOutstanding('qa');
    const { out } = runMain([], { search: { status: 0, stdout: '[]', stderr: '' } });

    expect(out).toContain('not proof none exists');
  });

  it('reports a failed search rather than an empty result', () => {
    seedOutstanding('qa');
    const { out } = runMain([], { search: { status: 1, stdout: '', stderr: 'gh: authentication required' } });

    expect(out).toContain('PR search FAILED');
    expect(out).toContain('authentication required');
    expect(out).not.toContain('not proof none exists');
  });

  it('still names the outstanding tickets when the owner cannot be resolved, and exits non-zero', () => {
    seedOutstanding('qa');
    const { code, out, err } = runMain([], { owner: { status: 1, stdout: '', stderr: 'gh: not logged in' } });

    expect(code).toBe(EXIT.unusable);
    expect(err).toContain('could not resolve the GitHub owner');
    expect(out).toContain(ID);
    expect(out).toContain('PR state NOT checked');
  });

  it('says plainly when nothing is outstanding', () => {
    const { code, out } = runMain([]);
    expect(code).toBe(EXIT.ok);
    expect(out).toContain('no night-run tickets are outstanding');
  });

  it('surfaces a run directory with no summary.json', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    const { out } = runMain([]);
    expect(out).toContain('NO summary.json');
    expect(out).toContain('2026-09-03T02-00-00-000Z');
  });

  it('warns that merges are blocked while a run is active', () => {
    mkdirSync(join(root, '.night-run'), { recursive: true });
    writeFileSync(join(root, '.night-run', 'ACTIVE'), '123');
    const { out } = runMain([]);
    expect(out).toContain('ACTIVE');
  });

  it('exits non-zero when the primary checkout cannot be located', () => {
    const out = sink();
    const err = sink();
    const code = main([], { gh: fakeGh({}), resolveRoot: () => null, out, err });
    expect(code).toBe(EXIT.unusable);
    expect(err.text).toContain('could not locate the primary checkout');
  });

  it('never offers to merge', () => {
    seedOutstanding('qa');
    const { out } = runMain([], { search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' } });
    expect(out).toContain('does not merge');
    expect(out).not.toMatch(/gh pr merge --squash/);
  });
});

describe('night:report argument handling', () => {
  it('accepts an explicit owner and skips the lookup', () => {
    expect(resolveOwner(() => { throw new Error('gh must not be called'); }, 'given')).toEqual({ ok: true, owner: 'given' });
  });

  it('rejects an unknown argument and a valueless --owner', () => {
    expect(parseArgs(['--owner'])).toMatchObject({ ok: false });
    expect(parseArgs(['--nope'])).toMatchObject({ ok: false });
    expect(parseArgs(['--owner', 'x'])).toEqual({ ok: true, owner: 'x' });
    expect(parseArgs([])).toEqual({ ok: true, owner: null });
  });

  it('prints the usage on a bad argument', () => {
    const out = sink();
    const err = sink();
    expect(main(['--nope'], { gh: fakeGh({}), resolveRoot: () => root, out, err })).toBe(EXIT.usage);
    expect(err.text).toContain(REPORT_USAGE);
  });

  it('treats a non-array JSON body as a failure, not as an empty result', () => {
    expect(jsonOr({ status: 0, stdout: '{"not":"an array"}', stderr: '' })).toMatchObject({ ok: false });
    expect(jsonOr({ status: 0, stdout: '[]', stderr: '' })).toEqual({ ok: true, value: [] });
    expect(jsonOr({ status: -1, stdout: '', stderr: '' }).why).toContain('gh exited -1');
  });

  it('renders a ticket whose board status could not be read', () => {
    const lines = renderTicket({ id: ID, status: null, verdicts: [] }, { ok: true, matches: [] });
    expect(lines[0]).toContain('UNREADABLE on the board');
  });
});

describe('night:report never reports a scan it could not complete as clean', () => {
  it('exits non-zero and refuses the "nothing outstanding" claim when a run dir has no summary', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    const { code, out } = runMain([]);

    expect(code, 'an incomplete scan exited 0, the permissive answer').toBe(EXIT.unusable);
    expect(out).toContain('this is not a clean board');
    expect(out).not.toContain('no night-run tickets are outstanding');
  });

  it('exits non-zero when `.night-run/` itself cannot be read', () => {
    writeFileSync(join(root, '.night-run'), 'not a directory');
    const { code, out } = runMain([]);

    expect(code).toBe(EXIT.unusable);
    expect(out).toContain('could not be read');
    expect(out).not.toContain('no night-run tickets are outstanding');
  });

  it('still exits 0 on a genuinely clean, complete scan', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    writeFileSync(
      join(root, '.night-run', '2026-09-03T02-00-00-000Z', 'summary.json'),
      JSON.stringify({ startedAt: 'x', queue: [], results: [], exit: 0 }),
    );
    const { code, out } = runMain([]);

    expect(code, 'a complete scan with nothing outstanding must stay exit 0').toBe(EXIT.ok);
    expect(out).toContain('no night-run tickets are outstanding');
  });

  it('reports a run that died before recording an exit code', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    writeFileSync(
      join(root, '.night-run', '2026-09-03T02-00-00-000Z', 'summary.json'),
      JSON.stringify({ startedAt: 'x', queue: [], results: [], exit: null }),
    );
    const { code, out } = runMain([]);

    expect(code).toBe(EXIT.unusable);
    expect(out).toContain('no exit code recorded');
  });
});
