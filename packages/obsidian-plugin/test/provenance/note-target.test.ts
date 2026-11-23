import { expect, it, vi } from 'vitest';
import { TFile, MarkdownView } from 'obsidian';
import { makeClient } from '@vault/query-core';
import {
  openExistingNode,
  LastMarkdownTarget,
} from '../../src/provenance/note-target.js';
it('opens the current existing file and refuses missing files without creating notes', async () => {
  const client = makeClient(async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { id: 'source', file_path: 'New.md' },
          warnings: [],
        }),
      },
    ],
  }));
  const openFile = vi.fn(async () => {}),
    create = vi.fn(),
    openLinkText = vi.fn();
  let file: TFile | null = null;
  const app = {
    vault: { getAbstractFileByPath: vi.fn(() => file), create },
    workspace: { getLeaf: () => ({ openFile }), openLinkText },
  };
  await expect(
    openExistingNode(app as never, client, 'source'),
  ).rejects.toThrow('not available locally');
  expect(create).not.toHaveBeenCalled();
  expect(openLinkText).not.toHaveBeenCalled();
  file = Object.assign(Object.create(TFile.prototype), {
    path: 'New.md',
    extension: 'md',
  });
  await openExistingNode(app as never, client, 'source');
  expect(openFile).toHaveBeenCalledWith(file);
});
it('ignores sidebar focus and follows the tracked file rename', () => {
  const file = Object.assign(Object.create(TFile.prototype), {
    path: 'Home.md',
    extension: 'md',
  });
  const view = Object.assign(Object.create(MarkdownView.prototype), { file });
  const tracker = new LastMarkdownTarget();
  tracker.record({ view } as never);
  tracker.record({ view: {} } as never);
  expect(tracker.currentPath()).toBe('Home.md');
  file.path = 'Renamed.md';
  expect(tracker.currentPath()).toBe('Renamed.md');
  tracker.clear();
  expect(tracker.currentPath()).toBeNull();
});
it('does not navigate after its caller invalidates a pending lookup', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((r) => (resolve = r));
  let current = true;
  const client = makeClient(async () => (await pending) as never);
  const openFile = vi.fn(async () => {});
  const file = Object.assign(Object.create(TFile.prototype), {
    path: 'New.md',
    extension: 'md',
  });
  const app = {
    vault: { getAbstractFileByPath: () => file },
    workspace: { getLeaf: () => ({ openFile }) },
  };
  const opening = openExistingNode(
    app as never,
    client,
    'source',
    () => current,
  );
  current = false;
  resolve({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { id: 'source', file_path: 'New.md' },
          warnings: [],
        }),
      },
    ],
  });
  await expect(opening).rejects.toThrow('Inspection context changed');
  expect(openFile).not.toHaveBeenCalled();
});
