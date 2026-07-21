// Session registry for the detachable embedded terminal (tkt-dd308ec91efc). Holds the live
// pty/container sessions keyed by client-minted session id, and owns the detach/reattach/dispose
// lifecycle so a browser reload REATTACHES to the running Claude session instead of killing it.
//
// Pure-ish by design (mirrors terminalAuth vs terminal.ts): all side effects — killing the
// container, spawning the pty — are injected or held by the caller, and time is plain setTimeout,
// so the whole connect → detach → reattach chain is drivable in tests with a fake pty + fake
// timers and NO real docker/node-pty.

// The subset of node-pty's IPty the registry + transport touch. Narrow on purpose so a fake
// satisfies it. (write/resize are used by the transport via entry.pty; resize/kill by the registry.)
export interface PtyHandle {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

// The subset of the WS this module touches (identity compare + close stale + route output).
export interface ClientSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export interface TerminalEntry {
  pty: PtyHandle | null;        // null while the container is still starting (slot reserved)
  containerName: string;
  currentWs: ClientSocket | null;
  graceTimer?: ReturnType<typeof setTimeout>;
  nudgeTimer?: ReturnType<typeof setTimeout>; // pending second half of the reattach SIGWINCH nudge
  // True once the container is running — even before a pty attaches. A detach before this disposes
  // (nothing to keep); a detach after it graces, because a live container exists to reattach to.
  containerStarted: boolean;
  // True for a container adopted at boot (survived a restart). Distinguishes it from a still-booting
  // new session (both have pty null): only an adopted entry's reattach spawns a fresh exec, and an
  // adopted survivor is never reaped to free a cap slot (it's a live session to restore). (review F1/F2)
  adopted: boolean;
  attaching?: boolean;          // a reattach is mid-spawn — guards against a double-spawn (review F2)
  disposed: boolean;
  cleanup?: () => void;         // extra teardown (prefill timers/subscription) set by terminal.ts
}

export interface RegistryDeps {
  graceMs: number;              // how long a detached session survives awaiting a reattach
  nudgeMs: number;              // delay between the two-step SIGWINCH resize halves
  killContainer: (name: string) => void;
  // Extra per-session teardown keyed by id, run on dispose AFTER the container is killed — used to
  // remove the session's isolated HOME dir (S4, tkt-db09c3a52655). Optional so tests need not wire it.
  cleanupSession?: (id: string) => void;
}

export class TerminalRegistry {
  private readonly entries = new Map<string, TerminalEntry>();

  constructor(private readonly deps: RegistryDeps) {}

  size(): number { return this.entries.size; }
  has(id: string): boolean { return this.entries.has(id); }
  get(id: string): TerminalEntry | undefined { return this.entries.get(id); }
  values(): IterableIterator<TerminalEntry> { return this.entries.values(); }

  // Reserve a slot synchronously (before the async container setup) so the session cap can't be
  // undercounted while a new session is still booting. pty is filled in by attachPty once spawned.
  create(id: string, containerName: string, ws: ClientSocket): TerminalEntry {
    const entry: TerminalEntry = { pty: null, containerName, currentWs: ws, containerStarted: false, adopted: false, disposed: false };
    this.entries.set(id, entry);
    return entry;
  }

  attachPty(id: string, pty: PtyHandle): void {
    const entry = this.entries.get(id);
    // Clear `adopted` once a pty attaches: a restored survivor is now an ordinary live session, so
    // its grace slot becomes reclaimable again after it's later detached (review G1).
    if (entry && !entry.disposed) { entry.pty = pty; entry.containerStarted = true; entry.adopted = false; }
  }

  // Adopt a container that outlived an Express restart (rediscovered via docker ps). No socket or
  // pty yet — a reattach spawns a fresh exec into its surviving dtach session. Starts a grace timer
  // so an orphan nobody reattaches to is still reaped (S3a, tkt-5b21136f3317). No-op if already known.
  adopt(id: string, containerName: string): void {
    if (this.entries.has(id)) return;
    const entry: TerminalEntry = { pty: null, containerName, currentWs: null, containerStarted: true, adopted: true, disposed: false };
    this.entries.set(id, entry);
    entry.graceTimer = setTimeout(() => this.dispose(id), this.deps.graceMs);
  }

  // Socket-close handler. A reload drops the socket but the container must survive: null the
  // socket and start the grace window. Two guards: a stale socket whose entry was already rebound
  // by a faster reattach is ignored; a session that dropped before its CONTAINER started is freed
  // immediately (nothing running to preserve). Keyed on containerStarted, not pty: the container is
  // live throughout the (now longer) window before the pty attaches, so a reload there must grace
  // and reattach — not dispose a running container (review of tkt-00dd79b261d7).
  detach(id: string, ws: ClientSocket): void {
    const entry = this.entries.get(id);
    if (!entry || entry.disposed || entry.currentWs !== ws) return;
    entry.currentWs = null;
    if (!entry.containerStarted) { this.dispose(id); return; }
    entry.graceTimer = setTimeout(() => this.dispose(id), this.deps.graceMs);
  }

  // Rejoin a live session on the new socket. Synchronous (await-free) so no second upgrade can
  // interleave between the lookup and the rebind (TOCTOU). Returns the entry on success so the
  // caller can bind the new socket's message/close handlers, or null if the session is gone.
  reattach(id: string, ws: ClientSocket): TerminalEntry | null {
    const entry = this.entries.get(id);
    if (!entry || entry.disposed) return null;
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = undefined; }
    const stale = entry.currentWs;
    entry.currentWs = ws;
    if (stale && stale !== ws) { try { stale.close(); } catch { /* already closed */ } }
    this.repaint(entry);
    return entry;
  }

  // Classify a lookup for authorizeReattach: is the id a detached session, one still bound
  // (reload race), or gone? (has()+this together let terminal.ts route new vs reattach.)
  lookup(id: string): 'found' | 'attached-elsewhere' | 'not-found' {
    const entry = this.entries.get(id);
    if (!entry || entry.disposed) return 'not-found';
    return entry.currentWs ? 'attached-elsewhere' : 'found';
  }

  // Reclaim the oldest DETACHED (grace-held) session to make room for a new one, so a lingering
  // reload/closed-tab grace window can't block a fresh terminal at the cap. Live (attached)
  // sessions are never reaped. Returns whether a slot was actually freed.
  reapDetached(): boolean {
    for (const [id, entry] of this.entries) {
      // Never reclaim an ADOPTED survivor to free a cap slot — it's a live session waiting to be
      // restored, not a stale reload-grace entry. Only genuinely transient detached entries. (F1)
      if (!entry.disposed && !entry.adopted && entry.currentWs === null) { this.dispose(id); return true; }
    }
    return false;
  }

  // A real client resize arrived during the reattach nudge window → it's authoritative, so drop
  // the pending restore that would otherwise clobber the client's size back to pre-reload dims.
  cancelNudge(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.nudgeTimer) { clearTimeout(entry.nudgeTimer); entry.nudgeTimer = undefined; }
  }

  // Force the alt-screen TUI to redraw by raising SIGWINCH. Replaying buffered bytes is unsound
  // (mid-stream, can slice an escape sequence), so we nudge the pty size instead. Linux
  // tty_do_resize no-ops an UNCHANGED winsize, so shrink one row then restore next tick — this
  // guarantees a real size change (hence a signal) regardless of the post-reload size.
  private repaint(entry: TerminalEntry): void {
    const term = entry.pty;
    if (!term) return;
    const { cols, rows } = term;
    try {
      term.resize(cols, Math.max(1, rows - 1));
      // Restore next tick UNLESS a client resize cancels it (cancelNudge) — the shrink alone
      // already guarantees the SIGWINCH; the restore only undoes the -1 when the client is silent.
      if (entry.nudgeTimer) clearTimeout(entry.nudgeTimer);
      entry.nudgeTimer = setTimeout(() => {
        entry.nudgeTimer = undefined;
        if (!entry.disposed && entry.pty === term) {
          try { term.resize(cols, rows); } catch { /* pty gone */ }
        }
      }, this.deps.nudgeMs);
    } catch { /* pty gone */ }
  }

  // Immediate teardown, bypassing grace — used for an explicit {t:'e'} terminate and for pty exit.
  terminate(id: string): void { this.dispose(id); }

  // Dispose ONLY if `entry` is still the live session under `id`. A stale in-flight openSession
  // (whose entry was already freed and whose id may have been reused by a newer session) must not
  // tear down the newer entry — it disposes by identity, not by id alone.
  disposeIfCurrent(id: string, entry: TerminalEntry): void {
    if (this.entries.get(id) === entry) this.dispose(id);
  }

  // Idempotent: kill the pty + container, clear timers/extra teardown, drop the entry.
  dispose(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = undefined; }
    if (entry.nudgeTimer) { clearTimeout(entry.nudgeTimer); entry.nudgeTimer = undefined; }
    if (entry.cleanup) { try { entry.cleanup(); } catch { /* best effort */ } }
    if (entry.pty) { try { entry.pty.kill(); } catch { /* already exited */ } }
    this.deps.killContainer(entry.containerName);
    if (this.deps.cleanupSession) { try { this.deps.cleanupSession(id); } catch { /* best effort */ } }
    this.entries.delete(id);
  }
}
