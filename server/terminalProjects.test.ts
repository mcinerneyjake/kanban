import { describe, it, expect } from 'vitest';
import { projectRoots, kanbanRoot } from './terminalProjects.js';

// The board's own key is runtime-UNOBSERVABLE through allowedRootsFor: it appends kanbanRoot
// unconditionally, so { kanban: root } and { hardpack: root } resolve byte-identically. The key-set
// assertions are therefore the only ones that witness the rename; the path assertions below cover
// config merging and are not load-bearing for it (tkt-28f8ec229dde).
describe('projectRoots', () => {
  it('keys the board on its project name, not the legacy one', () => {
    expect(Object.keys(projectRoots({}))).toEqual(['hardpack']);
  });

  it('merges configured projects alongside the board key', () => {
    const env = { KANBAN_TERMINAL_PROJECTS: JSON.stringify({ 'portfolio-site': '/abs/portfolio' }) };
    expect(Object.keys(projectRoots(env)).sort()).toEqual(['hardpack', 'portfolio-site']);
    expect(projectRoots(env)['portfolio-site']).toBe('/abs/portfolio');
    expect(projectRoots(env).hardpack).toBe(kanbanRoot());
  });

  it('lets config override the board root without renaming the key', () => {
    const env = { KANBAN_TERMINAL_PROJECTS: JSON.stringify({ hardpack: '/abs/elsewhere' }) };
    expect(Object.keys(projectRoots(env))).toEqual(['hardpack']);
    expect(projectRoots(env).hardpack).toBe('/abs/elsewhere');
  });

  it('falls back to the board key alone on malformed or unusable config', () => {
    for (const raw of ['not json', '[]', 'null', '"str"', JSON.stringify({ rel: 'relative/path' })]) {
      expect(Object.keys(projectRoots({ KANBAN_TERMINAL_PROJECTS: raw })), raw).toEqual(['hardpack']);
    }
  });

  it('ignores an empty env var rather than emitting an empty key set', () => {
    expect(Object.keys(projectRoots({ KANBAN_TERMINAL_PROJECTS: '' }))).toEqual(['hardpack']);
  });
});
