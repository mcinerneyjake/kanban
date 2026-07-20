import { describe, it, expect } from 'vitest';
import {
  isAllowedOrigin, isValidToken, buildSessionEnv, allowedRootsFor,
  buildDetachedRunArgs, buildAttachArgs, dtachSocket, resolveSessionCommand, authorizeUpgrade,
  authorizeReattach, parseClientFrame, parseTicketParam, parseSessionParam, isValidSessionId,
  rootMountArgs, type CredMount,
} from './terminalAuth.js';

import type { Ticket } from '../shared/constants.js';

// A valid crypto.randomUUID()-shaped session id, used for the detached run label + dtach socket.
const SID = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';

const KANBAN = '/repo/kanban';
const PORTFOLIO = '/repo/portfolio-site';
const PROJECT_ROOTS = { kanban: KANBAN, 'portfolio-site': PORTFOLIO };
const CRED: CredMount = { hostHome: '/host/home', containerHome: '/kanban-home' };

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tkt-0123456789ab', title: 'Do the thing', type: 'feature', priority: 'high',
    status: 'in-progress', order: 1, created: 'x', updated: 'x', body: '',
    project: 'kanban', blockers: [], parent: null, dueDate: null, assignee: null,
    ...overrides,
  };
}

describe('isAllowedOrigin', () => {
  it('allows localhost dev origins', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3001')).toBe(true);
  });
  it('rejects a foreign origin, a wrong port, and undefined', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('http://localhost:8080')).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(false);
  });
});

describe('isValidToken', () => {
  it('accepts an exact match', () => {
    expect(isValidToken('abc', 'abc')).toBe(true);
  });
  it('rejects wrong, empty, or null — and never authorizes on an empty expected', () => {
    expect(isValidToken('nope', 'abc')).toBe(false);
    expect(isValidToken(null, 'abc')).toBe(false);
    expect(isValidToken(undefined, 'abc')).toBe(false);
    expect(isValidToken('', '')).toBe(false); // misconfig must not authorize
    expect(isValidToken('x', '')).toBe(false);
  });
});

describe('buildSessionEnv', () => {
  it('keeps allowlisted keys and forces TERM', () => {
    const env = buildSessionEnv({ PATH: '/usr/bin', HOME: '/home/j', TERM: 'dumb' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/j');
    expect(env.TERM).toBe('xterm-256color');
  });
  it('drops secret-shaped keys not on the allowlist', () => {
    const env = buildSessionEnv({
      PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'z',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('GITHUB_TOKEN' in env).toBe(false);
    expect('AWS_SECRET_ACCESS_KEY' in env).toBe(false);
  });
  it('keeps DOCKER_ daemon-selection vars (not secrets, needed to reach the daemon)', () => {
    const env = buildSessionEnv({ PATH: '/usr/bin', DOCKER_HOST: 'tcp://x', DOCKER_CONTEXT: 'colima' });
    expect(env.DOCKER_HOST).toBe('tcp://x');
    expect(env.DOCKER_CONTEXT).toBe('colima');
  });
});

describe('allowedRootsFor', () => {
  it('shell mode (no ticket) → kanban only', () => {
    expect(allowedRootsFor({ ticket: null, projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN })).toEqual([KANBAN]);
  });
  it('kanban ticket → kanban only', () => {
    expect(allowedRootsFor({ ticket: ticket({ project: 'kanban' }), projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN }))
      .toEqual([KANBAN]);
  });
  it('cross-project ticket → project root first, then kanban', () => {
    expect(allowedRootsFor({ ticket: ticket({ project: 'portfolio-site' }), projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN }))
      .toEqual([PORTFOLIO, KANBAN]);
  });
  it('unmapped project → kanban-only fallback, never the whole disk', () => {
    expect(allowedRootsFor({ ticket: ticket({ project: 'mystery' }), projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN }))
      .toEqual([KANBAN]);
  });
});

describe('buildDetachedRunArgs', () => {
  const base = {
    roots: [KANBAN], sessionId: SID, credMount: CRED, image: 'kanban-terminal', containerName: 'kanban-term-1',
  };

  it('mounts each allowed root', () => {
    const joined = buildDetachedRunArgs({ ...base, roots: [PORTFOLIO, KANBAN] }).join(' ');
    expect(joined).toContain(`${PORTFOLIO}:${PORTFOLIO}`);
    expect(joined).toContain(`${KANBAN}:${KANBAN}`);
  });
  it('mounts the persistent HOME + sets HOME, and never passes the token as an -e var', () => {
    const args = buildDetachedRunArgs(base);
    expect(args.join(' ')).toContain(`${CRED.hostHome}:${CRED.containerHome}`);
    expect(args.join(' ')).toContain(`HOME=${CRED.containerHome}`);
    expect(args.some((a: string) => a.includes('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(false);
    expect(args.some((a: string) => a.includes('ANTHROPIC'))).toBe(false);
  });
  it('does not mount any non-allowed host path (roots, HOME, or named node_modules volumes only)', () => {
    const args = buildDetachedRunArgs(base);
    const mounts = args.filter((_: string, i: number) => args[i - 1] === '-v');
    for (const mount of mounts) {
      const src = mount.split(':')[0];
      // A host path must be an allowed root or the HOME dir; node_modules sources are named
      // volumes (no host path), so a wrong-platform host node_modules can't leak in.
      const ok = src === KANBAN || src === CRED.hostHome || src.startsWith('kanbanterm-nm-');
      expect(ok).toBe(true);
    }
  });
  it('shadows each root node_modules with a named volume and passes the install dirs', () => {
    const joined = buildDetachedRunArgs({ ...base, roots: [PORTFOLIO, KANBAN] }).join(' ');
    expect(joined).toContain(`:${PORTFOLIO}/node_modules`);
    expect(joined).toContain(`:${KANBAN}/node_modules`);
    expect(joined).toContain(`KANBAN_INSTALL_DIRS=${PORTFOLIO}:${KANBAN}`);
  });
  it('runs DETACHED (-d, no --rm/-it), names + labels the container, and runs claude under dtach', () => {
    const args = buildDetachedRunArgs(base);
    expect(args.slice(0, 2)).toEqual(['run', '-d']);
    expect(args).not.toContain('-it');
    expect(args).not.toContain('--rm'); // must persist independent of the `docker run` client
    expect(args[args.indexOf('--name') + 1]).toBe('kanban-term-1');
    expect(args[args.indexOf('--label') + 1]).toBe(`kanban.session=${SID}`); // discoverable after a restart
    expect(args[args.indexOf('-w') + 1]).toBe(KANBAN);
    const imgIdx = args.indexOf('kanban-terminal');
    expect(args.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
  });
  it('throws loudly on empty roots rather than mounting nothing', () => {
    expect(() => buildDetachedRunArgs({ ...base, roots: [] })).toThrow(/non-empty/);
  });
});

describe('buildAttachArgs / dtachSocket', () => {
  it('execs an interactive dtach attach on the session socket (winch redraw)', () => {
    expect(buildAttachArgs('kanban-term-1', SID)).toEqual(
      ['exec', '-it', 'kanban-term-1', 'dtach', '-a', dtachSocket(SID), '-E', '-r', 'winch'],
    );
  });
  it('dtachSocket is a per-session path under /tmp', () => {
    expect(dtachSocket(SID)).toBe(`/tmp/kanban-term-${SID}.dtach`);
  });
});

describe('rootMountArgs', () => {
  it('mounts each root, shadows its node_modules with a volume, and passes the install dirs', () => {
    const joined = rootMountArgs([PORTFOLIO, KANBAN]).join(' ');
    expect(joined).toContain(`${PORTFOLIO}:${PORTFOLIO}`);
    expect(joined).toContain(`:${PORTFOLIO}/node_modules`);
    expect(joined).toContain(`:${KANBAN}/node_modules`);
    expect(joined).toContain(`KANBAN_INSTALL_DIRS=${PORTFOLIO}:${KANBAN}`);
  });
  it('gives paths that differ only by a separator DISTINCT volumes (no lossy collision)', () => {
    const volA = rootMountArgs(['/repo/a/b']).find((a) => a.includes(':/repo/a/b/node_modules'))?.split(':')[0];
    const volB = rootMountArgs(['/repo/a-b']).find((a) => a.includes(':/repo/a-b/node_modules'))?.split(':')[0];
    expect(volA).toBeDefined();
    expect(volB).toBeDefined();
    expect(volA).not.toBe(volB); // a lossy /↔- substitution would have collided these
  });
});

describe('resolveSessionCommand', () => {
  const common = {
    sessionId: SID,
    getTicket: async (id: string) => ticket({ id }),
    projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN, credMount: CRED,
    image: 'kanban-terminal', containerName: 'kanban-term-1',
  };

  it('no ticket → detached claude under dtach + a matching attach, no prefill (never a raw shell)', async () => {
    const { runArgs, attachArgs, socket, prefill, roots } = await resolveSessionCommand({ ...common });
    const imgIdx = runArgs.indexOf('kanban-terminal');
    expect(runArgs.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
    expect(runArgs).not.toContain('bash');
    expect(runArgs).not.toContain('--add-dir'); // variadic arg would swallow input; confinement is via mounts
    expect(attachArgs).toEqual(['exec', '-it', 'kanban-term-1', 'dtach', '-a', dtachSocket(SID), '-E', '-r', 'winch']);
    expect(socket).toBe(dtachSocket(SID));
    expect(prefill).toBeUndefined();
    expect(roots).toEqual([KANBAN]); // the transport pre-installs deps for these
  });
  it('rejects a malformed ticket id and never calls getTicket', async () => {
    let called = false;
    await expect(resolveSessionCommand({
      ...common, ticket: 'tkt-BADID',
      getTicket: async (id) => { called = true; return ticket({ id }); },
    })).rejects.toThrow(/Invalid ticket id/);
    expect(called).toBe(false);
  });
  it('propagates an unknown-ticket rejection from getTicket', async () => {
    await expect(resolveSessionCommand({
      ...common, ticket: 'tkt-0123456789ab',
      getTicket: async () => { throw new Error('Ticket not found: tkt-0123456789ab'); },
    })).rejects.toThrow(/not found/);
  });

  // Integration seam (id → getTicket → seed prefill): the real id + title must survive the
  // lookup into the prefill — no field dropped/mangled at the boundary. The command stays
  // bare claude (the prefill is typed in by the transport, not passed as an arg).
  it('carries the real ticket id and title into the prefill (fidelity invariant)', async () => {
    const { runArgs, prefill } = await resolveSessionCommand({
      ...common, ticket: 'tkt-0123456789ab',
      getTicket: async (id) => ticket({ id, title: 'Fix the CSV export crash' }),
    });
    const imgIdx = runArgs.indexOf('kanban-terminal');
    expect(runArgs.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
    expect(prefill).toContain('tkt-0123456789ab');
    expect(prefill).toContain('Fix the CSV export crash');
  });

  // The prefill is TYPED into the pty, so a title with a CR/LF would auto-submit and ESC could
  // inject a control sequence. A board-controlled title must never carry a control byte through.
  it('strips control chars from the title so the prefill cannot auto-submit or inject', async () => {
    const CR = String.fromCharCode(13), LF = String.fromCharCode(10), ESC = String.fromCharCode(27);
    const title = `evil"${CR}${LF}rm -rf${ESC}[2J then more`;
    const { prefill } = await resolveSessionCommand({
      ...common, ticket: 'tkt-0123456789ab',
      getTicket: async (id) => ticket({ id, title }),
    });
    expect(prefill).toBeDefined();
    // No CR/LF (would submit) or ESC/C0 controls (would inject a sequence) survive into the prefill.
    const controls = [...(prefill ?? '')].filter((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
    expect(controls).toEqual([]);
  });
});

// End-to-end seam: the ticket id the widget puts on the WS URL (encodeURIComponent) must
// survive parse → lookup → seed into the spawned command. Drives the REAL chain, stubbing
// only getTicket — so a drop/mangle anywhere from URL to argv fails here (per CLAUDE.md).
describe('ticket-param round trip (widget URL → server parse → seeded command)', () => {
  it('threads the id from the ?ticket= query all the way into the seed', async () => {
    const id = 'tkt-0123456789ab';
    const title = 'Fix the CSV export crash';
    const rawUrl = `/terminal-ws?ticket=${encodeURIComponent(id)}`; // what TerminalWidget builds
    const parsed = parseTicketParam(rawUrl);
    expect(parsed).toBe(id);

    const { runArgs, prefill } = await resolveSessionCommand({
      ticket: parsed, sessionId: SID, getTicket: async (tid) => ticket({ id: tid, title }),
      projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN, credMount: CRED,
      image: 'kanban-terminal', containerName: 'kanban-term-1',
    });
    // The command stays bare claude-under-dtach; the id + title thread through to the prefill.
    const imgIdx = runArgs.indexOf('kanban-terminal');
    expect(runArgs.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
    expect(prefill).toContain(id);
    expect(prefill).toContain(title);
  });
  it('no ?ticket= → shell/bare session (null, not a crash)', () => {
    expect(parseTicketParam('/terminal-ws')).toBeNull();
    expect(parseTicketParam('')).toBeNull();
  });
});

describe('authorizeUpgrade', () => {
  const base = {
    path: '/terminal-ws', wsPath: '/terminal-ws', origin: 'http://localhost:5173',
    token: 'secret', expected: 'secret', activeSessions: 0, maxSessions: 2,
  };
  it('accepts a fully valid upgrade', () => {
    expect(authorizeUpgrade(base)).toEqual({ ok: true });
  });
  it('ignores a non-terminal path (404 so HMR/others pass through)', () => {
    const d = authorizeUpgrade({ ...base, path: '/other' });
    expect(d).toEqual({ ok: false, status: 404, reason: 'not the terminal path' });
  });
  it('rejects a bad origin (403)', () => {
    expect(authorizeUpgrade({ ...base, origin: 'https://evil.example' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeUpgrade({ ...base, origin: undefined })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a bad/missing token (403)', () => {
    expect(authorizeUpgrade({ ...base, token: 'wrong' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeUpgrade({ ...base, token: null })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects once the session cap is reached (503)', () => {
    expect(authorizeUpgrade({ ...base, activeSessions: 2 })).toMatchObject({ ok: false, status: 503 });
  });
});

describe('isValidSessionId', () => {
  it('accepts a crypto.randomUUID()-shaped v4 id', () => {
    expect(isValidSessionId('3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c')).toBe(true);
  });
  it('rejects malformed, wrong-version, null, and non-string ids', () => {
    expect(isValidSessionId('not-a-uuid')).toBe(false);
    expect(isValidSessionId('3f8a1c2d-4b5e-1f6a-8b9c-0d1e2f3a4b5c')).toBe(false); // version nibble not 4
    expect(isValidSessionId('3f8a1c2d-4b5e-4f6a-7b9c-0d1e2f3a4b5c')).toBe(false); // variant nibble not 8/9/a/b
    expect(isValidSessionId('tkt-0123456789ab')).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });
});

describe('parseSessionParam', () => {
  it('reads the ?session= id the widget puts on the WS URL, null when absent', () => {
    const id = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
    expect(parseSessionParam(`/terminal-ws?session=${id}`)).toBe(id);
    expect(parseSessionParam(`/terminal-ws?ticket=tkt-0123456789ab&session=${id}`)).toBe(id);
    expect(parseSessionParam('/terminal-ws')).toBeNull();
    expect(parseSessionParam('')).toBeNull();
  });
});

describe('authorizeReattach', () => {
  const base = {
    origin: 'http://localhost:5173', token: 'secret', expected: 'secret',
    lookup: 'found' as const,
  };
  it('accepts a detached session on a valid origin + token', () => {
    expect(authorizeReattach(base)).toEqual({ ok: true });
  });
  it('accepts an attached-elsewhere lookup (reload race → last-writer-wins takeover)', () => {
    expect(authorizeReattach({ ...base, lookup: 'attached-elsewhere' })).toEqual({ ok: true });
  });
  it('rejects a bad origin (403)', () => {
    expect(authorizeReattach({ ...base, origin: 'https://evil.example' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeReattach({ ...base, origin: undefined })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a bad/missing token (403) — id is not a capability without the token', () => {
    expect(authorizeReattach({ ...base, token: 'wrong' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeReattach({ ...base, token: null })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a not-found lookup (404, defensive — caller routes unknown ids to new sessions)', () => {
    expect(authorizeReattach({ ...base, lookup: 'not-found' })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('parseClientFrame', () => {
  it('parses input and resize frames', () => {
    expect(parseClientFrame('{"t":"i","d":"ls\\n"}')).toEqual({ t: 'i', d: 'ls\n' });
    expect(parseClientFrame('{"t":"r","cols":120,"rows":40}')).toEqual({ t: 'r', cols: 120, rows: 40 });
  });
  it('parses the terminate frame', () => {
    expect(parseClientFrame('{"t":"e"}')).toEqual({ t: 'e' });
  });
  it('drops malformed, mistyped, or unknown frames', () => {
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
    expect(parseClientFrame('{"t":"i"}')).toBeNull();          // missing d
    expect(parseClientFrame('{"t":"r","cols":"80","rows":24}')).toBeNull(); // cols not a number
    expect(parseClientFrame('{"t":"x"}')).toBeNull();          // unknown type
  });
  it('rejects non-positive / non-integer resize dims (node-pty would throw → server crash)', () => {
    expect(parseClientFrame('{"t":"r","cols":0,"rows":0}')).toBeNull();     // FitAddon on a hidden pane
    expect(parseClientFrame('{"t":"r","cols":-5,"rows":10}')).toBeNull();
    expect(parseClientFrame('{"t":"r","cols":80.5,"rows":24}')).toBeNull(); // non-integer
  });
  it('clamps oversized resize dims to the max', () => {
    expect(parseClientFrame('{"t":"r","cols":99999,"rows":99999}')).toEqual({ t: 'r', cols: 1000, rows: 1000 });
  });
});
