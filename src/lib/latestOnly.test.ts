import { describe, it, expect } from 'vitest';
import { latestOnly, settleLatest } from './latestOnly.js';

// A promise whose resolution this test controls, so the ORDER of two overlapping fetches is chosen rather
// than raced. The bug only appears when the older request finishes last.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('latestOnly', () => {
  it('lets a lone claim through', () => {
    expect(latestOnly().claim()()).toBe(true);
  });

  it('invalidates an older claim as soon as a newer one is made', () => {
    const gate = latestOnly();
    const first = gate.claim();
    expect(first()).toBe(true); // still newest at this point
    const second = gate.claim();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('invalidates everything in flight on supersede', () => {
    const gate = latestOnly();
    const claim = gate.claim();
    gate.supersede();
    expect(claim()).toBe(false);
  });
});

describe('settleLatest — the project-switch race', () => {
  // The exact scenario in the ticket: filter A→B, and A is the slower of the two.
  it('drops a stale response that resolves AFTER a newer one', async () => {
    const gate = latestOnly();
    const writes: string[] = [];
    const a = deferred<string>();
    const b = deferred<string>();

    const first = settleLatest(() => a.promise, gate, (d) => writes.push(d), (e) => writes.push(`err:${e}`));
    const second = settleLatest(() => b.promise, gate, (d) => writes.push(d), (e) => writes.push(`err:${e}`));

    b.resolve('project-B');   // the newer request answers first…
    a.resolve('project-A');   // …and the older one lands afterwards
    await Promise.all([first, second]);

    expect(writes).toEqual(['project-B']); // last-write-wins would give ['project-B', 'project-A']
  });

  it('drops a stale REJECTION too, so A\'s failure cannot surface under B', async () => {
    const gate = latestOnly();
    const writes: string[] = [];
    const a = deferred<string>();
    const b = deferred<string>();

    const first = settleLatest(() => a.promise, gate, (d) => writes.push(d), (e) => writes.push(`err:${e}`));
    const second = settleLatest(() => b.promise, gate, (d) => writes.push(d), (e) => writes.push(`err:${e}`));

    b.resolve('project-B');
    a.reject(new Error('project A timed out'));
    await Promise.all([first, second]);

    expect(writes).toEqual(['project-B']);
  });

  it('still delivers the newest response when it is the slower one', async () => {
    // The control for the fix's own failure mode: gating must not turn into dropping everything.
    const gate = latestOnly();
    const writes: string[] = [];
    const a = deferred<string>();
    const b = deferred<string>();

    const first = settleLatest(() => a.promise, gate, (d) => writes.push(d), () => { /* unused */ });
    const second = settleLatest(() => b.promise, gate, (d) => writes.push(d), () => { /* unused */ });

    a.resolve('project-A');   // stale, answers first — dropped
    b.resolve('project-B');   // newest, answers last — must land
    await Promise.all([first, second]);

    expect(writes).toEqual(['project-B']);
  });

  it('delivers a lone failure', async () => {
    const writes: string[] = [];
    await settleLatest(() => Promise.reject(new Error('boom')), latestOnly(), () => { /* unused */ }, (e) => writes.push(e));
    expect(writes).toEqual(['boom']);
  });

  it('stringifies a non-Error rejection rather than reporting "undefined"', async () => {
    const writes: string[] = [];
    await settleLatest(() => Promise.reject('plain string'), latestOnly(), () => { /* unused */ }, (e) => writes.push(e));
    expect(writes).toEqual(['plain string']);
  });

  // Three overlapping requests within ONE effect run — what setInterval produces when a response outlives
  // the poll period. A per-effect `let ignore` flag (the fix the ticket suggests) does NOT catch this:
  // all three share one flag, so the oldest response would still write.
  it('keeps only the newest of three interval-triggered fetches', async () => {
    const gate = latestOnly();
    const writes: string[] = [];
    const d = [deferred<string>(), deferred<string>(), deferred<string>()];
    const runs = d.map((x, i) => settleLatest(() => x.promise, gate, () => writes.push(`poll-${i}`), () => { /* unused */ }));

    d[2].resolve('c');
    d[0].resolve('a');
    d[1].resolve('b');
    await Promise.all(runs);

    expect(writes).toEqual(['poll-2']);
  });
});
