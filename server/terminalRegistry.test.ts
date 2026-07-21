import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalRegistry } from './terminalRegistry.js';
import { parsePsLines } from './terminalDocker.js';
import { filterAdoptable } from './terminalAuth.js';
import { authorizeReattach, isValidSessionId, parseSessionParam } from './terminalAuth.js';

// Fakes standing in for node-pty / ws so the whole lifecycle runs with no real docker or sockets.
function makePty(cols = 80, rows = 24) {
  const resizes: Array<[number, number]> = [];
  return {
    cols, rows,
    write: vi.fn(),
    resize(c: number, r: number) { resizes.push([c, r]); },
    kill: vi.fn(),
    resizes,
  };
}
function makeWs() {
  return { readyState: 1, send: vi.fn(), close: vi.fn() };
}

const GRACE_MS = 60_000;
const NUDGE_MS = 50;
const ID = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';

function makeRegistry() {
  const killContainer = vi.fn();
  const cleanupSession = vi.fn();
  const registry = new TerminalRegistry({ graceMs: GRACE_MS, nudgeMs: NUDGE_MS, killContainer, cleanupSession });
  return { registry, killContainer, cleanupSession };
}

// Create a session and finish its (synchronous, in-test) boot: reserve the slot, attach the pty.
function boot(registry: TerminalRegistry, id: string, container: string) {
  const ws = makeWs();
  const pty = makePty();
  registry.create(id, container, ws);
  registry.attachPty(id, pty);
  return { ws, pty };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TerminalRegistry lifecycle', () => {
  it('reserves a slot on create and reports it via size()/has()', () => {
    const { registry } = makeRegistry();
    registry.create(ID, 'cont-1', makeWs());
    expect(registry.size()).toBe(1);
    expect(registry.has(ID)).toBe(true);
    expect(registry.lookup(ID)).toBe('attached-elsewhere'); // socket still bound
  });

  it('a socket dropped BEFORE the pty spawns frees the slot immediately (no grace)', () => {
    const { registry, killContainer } = makeRegistry();
    const ws = makeWs();
    registry.create(ID, 'cont-1', ws);
    registry.detach(ID, ws); // client vanished mid-setup
    expect(registry.size()).toBe(0);
    expect(killContainer).toHaveBeenCalledWith('cont-1');
  });

  it('dispose runs cleanupSession(id) after killing the container (S4: remove the per-session HOME)', () => {
    const { registry, killContainer, cleanupSession } = makeRegistry();
    const { ws } = boot(registry, ID, 'cont-1');
    registry.detach(ID, ws);
    vi.advanceTimersByTime(GRACE_MS); // grace expires → dispose
    expect(killContainer).toHaveBeenCalledWith('cont-1');
    expect(cleanupSession).toHaveBeenCalledWith(ID);
  });

  it('dispose is idempotent for cleanupSession — a second terminate does not re-clean', () => {
    const { registry, cleanupSession } = makeRegistry();
    boot(registry, ID, 'cont-1');
    registry.terminate(ID);
    registry.terminate(ID); // already disposed → no-op
    expect(cleanupSession).toHaveBeenCalledTimes(1);
  });

  it('detach holds the container for the grace window, then disposes if no reattach', () => {
    const { registry, killContainer } = makeRegistry();
    const { ws, pty } = boot(registry, ID, 'cont-1');

    registry.detach(ID, ws);
    expect(registry.lookup(ID)).toBe('found'); // detached, awaiting reattach
    expect(pty.kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(registry.size()).toBe(1); // still within grace

    vi.advanceTimersByTime(1);
    expect(registry.size()).toBe(0);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith('cont-1');
  });

  it('detach after the container started but BEFORE the pty attaches → grace, not dispose (review)', () => {
    const { registry, killContainer } = makeRegistry();
    const ws = makeWs();
    const entry = registry.create(ID, 'cont-1', ws);
    entry.containerStarted = true; // container is up; pty not yet attached (the dtach-wait window)

    registry.detach(ID, ws);
    expect(registry.lookup(ID)).toBe('found'); // detached + gracing, NOT disposed
    expect(registry.size()).toBe(1);
    expect(killContainer).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRACE_MS); // no reattach → grace expiry disposes
    expect(registry.size()).toBe(0);
    expect(killContainer).toHaveBeenCalledWith('cont-1');
  });

  it('adopt registers a detached container (no pty/ws) and reaps it after grace if unclaimed (S3a)', () => {
    const { registry, killContainer } = makeRegistry();
    registry.adopt(ID, 'cont-1');
    expect(registry.has(ID)).toBe(true);
    expect(registry.lookup(ID)).toBe('found'); // detached, awaiting reattach
    expect(registry.size()).toBe(1);
    vi.advanceTimersByTime(GRACE_MS);
    expect(registry.size()).toBe(0);
    expect(killContainer).toHaveBeenCalledWith('cont-1');
  });

  it('a reattach to an adopted container cancels its grace and exposes the containerName (pty null → caller spawns a fresh exec)', () => {
    const { registry, killContainer } = makeRegistry();
    registry.adopt(ID, 'cont-1');
    const entry = registry.reattach(ID, makeWs());
    expect(entry?.containerName).toBe('cont-1');
    expect(entry?.pty).toBeNull();
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(registry.size()).toBe(1); // grace cancelled → not reaped
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('adopt never clobbers an already-known session', () => {
    const { registry } = makeRegistry();
    boot(registry, ID, 'cont-live');
    registry.adopt(ID, 'cont-other');
    expect(registry.get(ID)?.containerName).toBe('cont-live');
  });

  it('reapDetached NEVER reclaims an adopted survivor (a live session to restore, review F1)', () => {
    const { registry, killContainer } = makeRegistry();
    registry.adopt(ID, 'cont-adopted'); // detached survivor (currentWs null), but adopted
    expect(registry.reapDetached()).toBe(false);
    expect(registry.has(ID)).toBe(true);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('reapDetached CAN reclaim a survivor once reattached then abandoned (adopted cleared on attach, review G1)', () => {
    const { registry } = makeRegistry();
    registry.adopt(ID, 'cont-1');
    registry.reattach(ID, makeWs());
    registry.attachPty(ID, makePty()); // fresh exec attached → no longer an unclaimed survivor
    registry.detach(ID, registry.get(ID)?.currentWs ?? makeWs());
    // Now it's an ordinary detached (grace) entry → reclaimable to free a slot.
    expect(registry.reapDetached()).toBe(true);
  });

  // Mandatory adoption round-trip seam (CLAUDE.md): a survivor's session id threads from raw
  // `docker ps` output → parsePsLines → filterAdoptable → registry.adopt → a reattachable entry,
  // with source id == the id you reattach under and the containerName preserved (review G7).
  it('adoption seam: threads a survivor session id to a reattachable entry, dropping non-ours', () => {
    const { registry } = makeRegistry();
    const survivor = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
    // What `docker ps --format '{{.Names}}\t{{.Label "kanban.session"}}'` prints: one of our
    // survivors + one unrelated container (wrong name prefix) that must NOT be adopted.
    const rows = parsePsLines(`kanban-term-77aa\t${survivor}\nsome-other-box\t${survivor}\n`);
    filterAdoptable(rows, (id) => registry.has(id)).forEach(({ name, session }) => registry.adopt(session, name));

    expect(registry.size()).toBe(1); // exactly the survivor, not the foreign container
    expect(registry.has(survivor)).toBe(true);
    const entry = registry.reattach(survivor, makeWs());
    expect(entry?.containerName).toBe('kanban-term-77aa'); // id → containerName round-trips
    expect(entry?.pty).toBeNull();                          // adopted → caller spawns a fresh exec
  });

  it('reattach within grace reuses the same pty + container, cancels grace, and never takes a 2nd slot', () => {
    const { registry, killContainer } = makeRegistry();
    const { ws: wsA, pty } = boot(registry, ID, 'cont-1');

    registry.detach(ID, wsA);
    const wsB = makeWs();
    const entry = registry.reattach(ID, wsB);

    expect(entry).not.toBeNull();
    expect(entry?.pty).toBe(pty);              // SAME pty, not a fresh boot
    expect(entry?.containerName).toBe('cont-1'); // SAME container
    expect(entry?.currentWs).toBe(wsB);
    expect(registry.size()).toBe(1);           // no second slot consumed

    // Grace was cancelled: advancing past it must NOT dispose the reattached session.
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(registry.size()).toBe(1);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('reattach issues the two-step SIGWINCH nudge (shrink one row, then restore next tick)', () => {
    const { registry } = makeRegistry();
    const { ws, pty } = boot(registry, ID, 'cont-1'); // 80x24
    registry.detach(ID, ws);

    registry.reattach(ID, makeWs());
    expect(pty.resizes).toEqual([[80, 23]]); // shrink immediately

    vi.advanceTimersByTime(NUDGE_MS);
    expect(pty.resizes).toEqual([[80, 23], [80, 24]]); // restore on the next tick → guaranteed signal
  });

  it('reattach during a reload race (socket still attached) takes over last-writer-wins', () => {
    const { registry } = makeRegistry();
    const { ws: wsA, pty } = boot(registry, ID, 'cont-1');
    expect(registry.lookup(ID)).toBe('attached-elsewhere');

    const wsB = makeWs();
    const entry = registry.reattach(ID, wsB); // new WS beat the old close

    expect(wsA.close).toHaveBeenCalledTimes(1); // stale socket closed
    expect(entry?.currentWs).toBe(wsB);
    expect(entry?.pty).toBe(pty);
    expect(registry.size()).toBe(1);
  });

  it('a stale close AFTER a reattach is ignored (does not detach the newer socket)', () => {
    const { registry } = makeRegistry();
    const { ws: wsA, pty } = boot(registry, ID, 'cont-1');
    const wsB = makeWs();
    registry.reattach(ID, wsB);

    registry.detach(ID, wsA); // the old socket's close arrives late
    expect(registry.lookup(ID)).toBe('attached-elsewhere'); // still bound to wsB, no grace started
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(registry.size()).toBe(1);
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it('terminate disposes immediately, bypassing the grace window', () => {
    const { registry, killContainer } = makeRegistry();
    const { pty } = boot(registry, ID, 'cont-1');

    registry.terminate(ID);
    expect(registry.size()).toBe(0);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith('cont-1');
  });

  it('dispose is idempotent (pty exit after an explicit terminate does not double-kill)', () => {
    const { registry, killContainer } = makeRegistry();
    const { pty } = boot(registry, ID, 'cont-1');
    registry.terminate(ID);
    registry.dispose(ID); // e.g. pty.onExit firing from the kill above
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledTimes(1);
  });

  it('disposeIfCurrent tears down the live entry but NOT a successor that reused the id (review #2)', () => {
    const { registry, killContainer } = makeRegistry();
    const first = boot(registry, ID, 'cont-1');
    const firstEntry = registry.get(ID);
    if (!firstEntry) throw new Error('unreachable');

    // The original session is freed and the same client id is reused by a brand-new session.
    registry.terminate(ID);
    const second = boot(registry, ID, 'cont-2');

    // A stale in-flight openSession for the FIRST session resumes and tries to dispose by id.
    registry.disposeIfCurrent(ID, firstEntry);

    expect(registry.has(ID)).toBe(true);          // the successor survived
    expect(registry.get(ID)?.containerName).toBe('cont-2');
    expect(second.pty.kill).not.toHaveBeenCalled();
    expect(killContainer).not.toHaveBeenCalledWith('cont-2');
    expect(first.pty.kill).toHaveBeenCalledTimes(1); // only the original was killed (by terminate)
  });

  it('reapDetached reclaims a grace-held session so it never blocks a new one (review #3)', () => {
    const { registry } = makeRegistry();
    const a = boot(registry, ID, 'cont-1');
    const otherId = '11111111-2222-4333-8444-555566667777';
    boot(registry, otherId, 'cont-2');

    registry.detach(ID, a.ws); // session A is now detached (reloading / closed tab in grace)
    expect(registry.size()).toBe(2);

    expect(registry.reapDetached()).toBe(true); // frees the detached one
    expect(registry.has(ID)).toBe(false);
    expect(registry.has(otherId)).toBe(true);   // the live one is untouched
    expect(registry.size()).toBe(1);
  });

  it('reapDetached does nothing (returns false) when every session is live', () => {
    const { registry } = makeRegistry();
    boot(registry, ID, 'cont-1'); // attached
    expect(registry.reapDetached()).toBe(false);
    expect(registry.size()).toBe(1);
  });

  it('cancelNudge drops the pending restore so a client resize is not clobbered (review #5)', () => {
    const { registry } = makeRegistry();
    const { ws, pty } = boot(registry, ID, 'cont-1'); // 80x24
    registry.detach(ID, ws);

    registry.reattach(ID, makeWs());
    expect(pty.resizes).toEqual([[80, 23]]); // shrink

    registry.cancelNudge(ID);          // a real client resize arrived → it's authoritative
    vi.advanceTimersByTime(NUDGE_MS);
    expect(pty.resizes).toEqual([[80, 23]]); // NO restore-to-24 clobber
  });

  it('runs cleanup (prefill teardown) exactly once on dispose', () => {
    const { registry } = makeRegistry();
    const { ws } = boot(registry, ID, 'cont-1');
    const cleanup = vi.fn();
    const entry = registry.get(ID);
    if (entry) entry.cleanup = cleanup;
    registry.detach(ID, ws);
    vi.advanceTimersByTime(GRACE_MS);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

// End-to-end seam: the id the widget puts on the WS URL must survive parse → shape-guard →
// registry lookup → authorizeReattach → the reattach that reuses the running pty. Drives the REAL
// functions, stubbing only the pty/ws — so a drop/mangle anywhere from URL to pty-reuse fails here
// (per CLAUDE.md's mandatory round-trip rule). Fidelity invariant: the id that reattaches is the
// exact id the client sent.
describe('reattach seam (widget URL → parse → lookup → authorize → pty reuse)', () => {
  it('threads the session id from ?session= all the way into reusing the same pty', () => {
    const { registry } = makeRegistry();
    const { ws, pty } = boot(registry, ID, 'cont-1');
    registry.detach(ID, ws);

    // What the reloaded TerminalWidget builds (session + ticket, encoded).
    const rawUrl = `/terminal-ws?ticket=${encodeURIComponent('tkt-0123456789ab')}&session=${ID}`;
    const parsed = parseSessionParam(rawUrl);
    expect(parsed).toBe(ID);                       // no mangle at the URL boundary
    expect(isValidSessionId(parsed)).toBe(true);
    if (!isValidSessionId(parsed)) throw new Error('unreachable'); // narrow for TS

    expect(registry.has(parsed)).toBe(true);
    const decision = authorizeReattach({
      origin: 'http://localhost:5173', token: 'secret', expected: 'secret', lookup: registry.lookup(parsed),
    });
    expect(decision.ok).toBe(true);

    const entry = registry.reattach(parsed, makeWs());
    expect(entry?.pty).toBe(pty);                  // reused the running session, not a fresh boot
    expect(entry?.containerName).toBe('cont-1');
  });

  it('a grace-expired id is not-found → routes to a NEW session, not a rejected reattach', () => {
    const { registry } = makeRegistry();
    const { ws } = boot(registry, ID, 'cont-1');
    registry.detach(ID, ws);
    vi.advanceTimersByTime(GRACE_MS); // grace lapses → session gone

    expect(registry.has(ID)).toBe(false); // caller falls through to the new-session (authorizeUpgrade) path
    expect(registry.lookup(ID)).toBe('not-found');
  });
});
