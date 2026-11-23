import { expect, it, vi } from 'vitest';
import { hasType, ProjectWikiIndex, type ProjectWikiSources } from '../../src/wiki/project-wikis.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function index(over: Partial<ProjectWikiSources> = {}) {
  let now = 0;
  const sources = { projectType: vi.fn(async () => 'project'), projectWikis: vi.fn(async () => ['Has Wiki']), ...over };
  const idx = new ProjectWikiIndex(() => sources, () => now);
  return { idx, sources, advance: (ms: number) => { now += ms; } };
}

it('reads types as Engine does', () => {
  expect(hasType(['project', 'note'], 'project')).toBe(true);
  expect(hasType('[[project]]', 'project')).toBe(true);
  expect(hasType(['[[client]]'], 'project')).toBe(false);
  expect(hasType(undefined, 'project')).toBe(false);
});

it('reads an unquoted [[link]] as Engine does, under any type key (#445, #482)', () => {
  // types: [[project]] unquoted, as Obsidian's frontmatter cache gives it: a nested list.
  expect(hasType([['project']], 'project')).toBe(true);
  expect(hasType(['[[project|Projects]]'], 'project')).toBe(true);
  // types:\n  - [[client]]\n  - [[project]]: each unquoted item is a nested list.
  expect(hasType([[['client']], [['project']]], 'project')).toBe(true);
});

it('offers a project note whose type key holds an unquoted [[link]]', async () => {
  const { idx } = index();
  await flush();
  expect(idx.offers([['project']], 'New')).toBe(true);
});

it('offers project notes without a wiki, once it has read the Curator', async () => {
  const { idx, sources } = index();
  expect(idx.offers(['project'], 'Has Wiki')).toBe(true);
  await flush();
  expect(idx.offers(['project'], 'Has Wiki')).toBe(false);
  expect(idx.offers(['project'], 'New')).toBe(true);
  expect(idx.offers(['note'], 'New')).toBe(false);
  expect(sources.projectType).toHaveBeenCalledTimes(1);
  expect(sources.projectWikis).toHaveBeenCalledTimes(1);
});

it('uses Engine\'s configured project type, and reads the Curator only for project notes', async () => {
  const { idx, sources } = index({ projectType: vi.fn(async () => 'engagement') });
  idx.offers(['note'], 'Note');
  await flush();
  expect(sources.projectWikis).not.toHaveBeenCalled();
  expect(idx.offers(['project'], 'Old')).toBe(false);
  expect(idx.offers(['engagement'], 'New')).toBe(true);
});

it('offers nothing when the vault map\'s project kind is none', async () => {
  const { idx, sources } = index({ projectType: vi.fn(async () => null) });
  idx.offers(['project'], 'New');
  await flush();
  expect(idx.offers(['project'], 'New')).toBe(false);
  expect(sources.projectWikis).toHaveBeenCalledTimes(1);
});

it('rereads when stale, and waits out the same interval after a failure', async () => {
  const { idx, sources, advance } = index({ projectWikis: vi.fn(async () => { throw new Error('down'); }) });
  idx.offers(['project'], 'A');
  await flush();
  idx.offers(['project'], 'A');
  expect(sources.projectWikis).toHaveBeenCalledTimes(1);
  advance(301_000);
  idx.offers(['project'], 'A');
  expect(sources.projectWikis).toHaveBeenCalledTimes(2);
  expect(sources.projectType).toHaveBeenCalledTimes(1);
});

it('keeps a wiki marked during a read that started before it', async () => {
  let release!: (titles: string[]) => void;
  const { idx } = index({ projectWikis: vi.fn(() => new Promise<string[]>(resolve => { release = resolve; })) });
  idx.offers(['project'], 'New');
  idx.markHasWiki('New');
  expect(idx.offers(['project'], 'New')).toBe(false);
  release([]);
  await flush();
  expect(idx.offers(['project'], 'New')).toBe(false);
});

it('forgets everything, and ignores reads in flight, when reset', async () => {
  let release!: (titles: string[]) => void;
  const { idx, sources } = index({ projectWikis: vi.fn(() => new Promise<string[]>(resolve => { release = resolve; })) });
  idx.offers(['project'], 'A');
  idx.reset();
  release(['A']);
  await flush();
  expect(idx.offers(['project'], 'A')).toBe(true);
  expect(sources.projectWikis).toHaveBeenCalledTimes(2);
});
