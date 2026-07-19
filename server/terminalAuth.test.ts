import { describe, it, expect } from 'vitest';
import {
  isAllowedOrigin, isValidToken, buildSessionEnv, allowedRootsFor,
  buildContainerArgs, resolveSessionCommand, type CredMount,
} from './terminalAuth.js';
import type { Ticket } from '../shared/constants.js';

const KANBAN = '/repo/kanban';
const PORTFOLIO = '/repo/portfolio-site';
const PROJECT_ROOTS = { kanban: KANBAN, 'portfolio-site': PORTFOLIO };
const CRED: CredMount = { hostFile: '/host/.cred.json', containerPath: '/root/.claude/.credentials.json' };

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

describe('buildContainerArgs', () => {
  const base = {
    roots: [KANBAN], credMount: CRED, image: 'kanban-terminal',
    containerName: 'kanban-term-1', innerCmd: ['bash', '-l'],
  };

  it('mounts each allowed root', () => {
    const joined = buildContainerArgs({ ...base, roots: [PORTFOLIO, KANBAN] }).join(' ');
    expect(joined).toContain(`${PORTFOLIO}:${PORTFOLIO}`);
    expect(joined).toContain(`${KANBAN}:${KANBAN}`);
  });
  it('mounts the credential file read-only and NEVER as an -e var', () => {
    const args = buildContainerArgs(base);
    expect(args.join(' ')).toContain(`${CRED.hostFile}:${CRED.containerPath}:ro`);
    expect(args.some((a) => a.includes('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(false);
    expect(args.some((a) => a.includes('ANTHROPIC'))).toBe(false);
  });
  it('does not mount any non-allowed host path', () => {
    const args = buildContainerArgs(base);
    const mounts = args.filter((_, i) => args[i - 1] === '-v');
    for (const mount of mounts) {
      const host = mount.split(':')[0];
      expect(host === KANBAN || host === CRED.hostFile).toBe(true);
    }
  });
  it('sets run/-it/--rm, name, workdir, image, then the inner command', () => {
    const args = buildContainerArgs(base);
    expect(args.slice(0, 3)).toEqual(['run', '-it', '--rm']);
    expect(args[args.indexOf('--name') + 1]).toBe('kanban-term-1');
    expect(args[args.indexOf('-w') + 1]).toBe(KANBAN);
    const imgIdx = args.indexOf('kanban-terminal');
    expect(args.slice(imgIdx + 1)).toEqual(['bash', '-l']);
  });
  it('throws loudly on empty roots rather than mounting nothing', () => {
    expect(() => buildContainerArgs({ ...base, roots: [] })).toThrow(/non-empty/);
  });
});

describe('resolveSessionCommand', () => {
  const common = {
    getTicket: async (id: string) => ticket({ id }),
    projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN, credMount: CRED,
    image: 'kanban-terminal', containerName: 'kanban-term-1',
  };

  it('no ticket → docker run of a shell', async () => {
    const { cmd, args } = await resolveSessionCommand({ ...common });
    expect(cmd).toBe('docker');
    const imgIdx = args.indexOf('kanban-terminal');
    expect(args.slice(imgIdx + 1)).toEqual(['bash', '-l']);
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

  // Integration seam (id → getTicket → seed prompt): the real id + title must survive
  // into the spawned command — no field dropped/mangled at the boundary.
  it('seeds claude with the real ticket id and title (fidelity invariant)', async () => {
    const { args } = await resolveSessionCommand({
      ...common, ticket: 'tkt-0123456789ab',
      getTicket: async (id) => ticket({ id, title: 'Fix the CSV export crash' }),
    });
    const joined = args.join(' ');
    expect(args).toContain('claude');
    expect(joined).toContain('tkt-0123456789ab');
    expect(joined).toContain('Fix the CSV export crash');
    expect(joined).toContain('--add-dir');
  });
});
