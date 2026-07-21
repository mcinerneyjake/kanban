// Manual sweep for leftover embedded-terminal session containers (S3b, tkt-b4412f11b790).
//
// The in-process reaper only runs while the dev server is up. Quitting the server (rather than
// letting it restart) leaves detached session containers running until the next boot re-adopts and
// reaps them. Run `npm run terminal:clean` to force-remove them now. Scoped to THIS checkout's
// containers (kanban.root label) so a second checkout's sessions on the same daemon are untouched.
//
// ⚠️  This removes EVERY matching container UNCONDITIONALLY — it has no view of the registry (it's a
// separate process). Intended to be run with the dev server DOWN. If run while the server is up, it
// will kill any live attached session for this checkout. That is why the reaper (which does consult
// the registry) is the in-process path; this is the blunt server-down escape hatch.

import { spawnDockerCli } from '../server/terminalDocker.js';
import { kanbanRoot } from '../server/terminalProjects.js';
import { SESSION_LABEL_KEY, SESSION_CREATED_LABEL_KEY, ROOT_LABEL_KEY } from '../server/terminalAuth.js';

async function main(): Promise<void> {
  const docker = spawnDockerCli();
  const root = kanbanRoot();
  const rows = await docker.ps(
    SESSION_LABEL_KEY, SESSION_CREATED_LABEL_KEY,
    [SESSION_LABEL_KEY, `${ROOT_LABEL_KEY}=${root}`], 'terminal:clean',
  );
  if (rows.length === 0) {
    console.log('[terminal:clean] no leftover session containers for this checkout.');
    return;
  }
  console.log('[terminal:clean] ⚠️  removing ALL matching containers — a live session for this checkout would be killed. Run with the dev server down.');
  console.log(`[terminal:clean] removing ${rows.length} leftover session container(s):`);
  for (const row of rows) {
    console.log(`  - ${row.name} (session ${row.session})`);
    docker.remove(row.name);
  }
}

main().catch((err: unknown) => {
  console.error('[terminal:clean] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
