import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Board-project → on-disk repo-root resolution for terminal-session confinement.
// The kanban repo root is always allowed (the board's MCP + workflow live here);
// other projects are supplied via config so no machine-specific absolute path is
// committed to source.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// server/ sits directly under the repo root.
export function kanbanRoot(): string {
  return path.resolve(__dirname, '..');
}

interface ProjectMap { [name: string]: string }

// KANBAN_TERMINAL_PROJECTS is a JSON object {projectName: absolutePath}. Malformed
// config or a relative path is ignored (kanban-only), never a fatal boot error.
function parseProjectMap(raw: string): ProjectMap {
  try {
    const data: unknown = JSON.parse(raw);
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const out: ProjectMap = {};
      for (const [name, dir] of Object.entries(data)) {
        if (typeof dir === 'string' && path.isAbsolute(dir)) out[name] = dir;
      }
      return out;
    }
  } catch {
    /* malformed JSON → kanban-only */
  }
  return {};
}

export function projectRoots(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const roots: Record<string, string> = { kanban: kanbanRoot() };
  const raw = env.KANBAN_TERMINAL_PROJECTS;
  if (raw) Object.assign(roots, parseProjectMap(raw));
  return roots;
}
