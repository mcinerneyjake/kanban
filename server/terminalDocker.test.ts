import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnDockerCli } from './terminalDocker.js';

// A stand-in for a spawned child: .on('error'|'exit', …) is all the seam uses.
function fakeChild() {
  return new EventEmitter();
}

describe('spawnDockerCli', () => {
  it('remove force-removes the container, name as a discrete argv entry (no shell)', () => {
    const spawn = vi.fn(() => fakeChild());
    spawnDockerCli(spawn).remove('kanban-term-abc');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('docker', ['rm', '-f', 'kanban-term-abc'], { stdio: 'ignore' });
  });

  it('a hostile container name stays ONE literal arg — never interpolated into a shell', () => {
    const spawn = vi.fn(() => fakeChild());
    const hostile = 'x; rm -rf ~ #';
    spawnDockerCli(spawn).remove(hostile);
    // The whole string is ONE argv entry, never parsed by a shell.
    expect(spawn).toHaveBeenCalledWith('docker', ['rm', '-f', hostile], { stdio: 'ignore' });
  });

  it('remove swallows a spawn error (a missing container is not fatal)', () => {
    const child = fakeChild();
    spawnDockerCli(() => child).remove('gone');
    expect(() => child.emit('error', new Error('no such container'))).not.toThrow();
  });

  it('removeSync uses spawnSync with an argv array (for the exit hook)', () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    spawnDockerCli(undefined, spawnSync).removeSync('kanban-term-xyz');
    expect(spawnSync).toHaveBeenCalledWith('docker', ['rm', '-f', 'kanban-term-xyz'], { stdio: 'ignore' });
  });

  it('run spawns docker with the given args + env and resolves the exit code', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const p = spawnDockerCli(spawn).run(['run', '--rm', 'img', 'true'], { env: { X: '1' } });
    expect(spawn).toHaveBeenCalledWith('docker', ['run', '--rm', 'img', 'true'], { stdio: 'ignore', env: { X: '1' } });
    child.emit('exit', 0);
    expect(await p).toBe(0);
  });

  it('run resolves null when docker cannot spawn', async () => {
    const child = fakeChild();
    const p = spawnDockerCli(() => child).run(['run', 'img']);
    child.emit('error', new Error('ENOENT'));
    expect(await p).toBeNull();
  });
});
