import { describe, expect, it, vi } from 'vitest';
import { Engine, type EngineClientFactory } from '../src/engine.js';
import { vaultOf, type Config } from '../src/config.js';
import { createProjectWikiDescription, removeWikiDescription } from '../src/server-bootstrap.js';
import { asksForWiki, clearWikiField } from '../src/wiki-field.js';

describe('asksForWiki', () => {
  it('accepts YAML true and the text "true", and nothing else', () => {
    for (const value of [true, 'true', ' TRUE ', 'True']) expect(asksForWiki(value)).toBe(true);
    for (const value of [false, 'false', 'yes', 1, null, undefined, '', ['true'], { value: true }]) expect(asksForWiki(value)).toBe(false);
  });
});

describe('clearWikiField', () => {
  function engine(value: unknown) {
    return {
      readNodeField: vi.fn(async (_id: string, _field: string) => value),
      updateNodeFields: vi.fn(async (_id: string, _fields: Record<string, unknown>, _title?: string) => {}),
    };
  }

  it('removes wiki: true through update-node (null removes a field)', async () => {
    const e = engine(true);
    expect(await clearWikiField(e, 'p-1', 'Atlas', 'wiki')).toEqual({ outcome: 'cleared' });
    expect(e.readNodeField).toHaveBeenCalledWith('p-1', 'wiki');
    expect(e.updateNodeFields).toHaveBeenCalledWith('p-1', { wiki: null }, 'Atlas');
  });

  it('clears the field it is given (the vault map\'s wikiFlagField)', async () => {
    const e = engine(true);
    expect(await clearWikiField(e, 'p-1', 'Atlas', 'make wiki')).toEqual({ outcome: 'cleared' });
    expect(e.readNodeField).toHaveBeenCalledWith('p-1', 'make wiki');
    expect(e.updateNodeFields).toHaveBeenCalledWith('p-1', { 'make wiki': null }, 'Atlas');
  });

  it('leaves a field that does not ask for a wiki as it is', async () => {
    for (const value of [undefined, false, 'later']) {
      const e = engine(value);
      expect(await clearWikiField(e, 'p-1', 'Atlas', 'wiki')).toEqual({ outcome: 'not_set' });
      expect(e.updateNodeFields).not.toHaveBeenCalled();
    }
  });

  it('reports a failed read or write instead of throwing', async () => {
    const unreadable = engine(true);
    unreadable.readNodeField.mockRejectedValueOnce(new Error('engine down'));
    expect(await clearWikiField(unreadable, 'p-1', 'Atlas', 'wiki')).toEqual({ outcome: 'not_cleared', reason: 'engine down' });
    const unwritable = engine(true);
    unwritable.updateNodeFields.mockRejectedValueOnce(new Error('VALIDATION_FAILED'));
    expect(await clearWikiField(unwritable, 'p-1', 'Atlas', 'wiki')).toEqual({ outcome: 'not_cleared', reason: 'VALIDATION_FAILED' });
  });
});

describe('Engine.listNodesWithField', () => {
  const config = { engineUrl: 'http://localhost:3334', engineToken: 't' } as Config;
  function factory(pages: Array<Array<Record<string, unknown>>>, calls: Array<Record<string, unknown>>): EngineClientFactory {
    return () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          calls.push({ name: req.name, ...req.arguments });
          const nodes = pages[calls.length - 1] ?? [];
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes, total: nodes.length }, warnings: [] }) }] };
        },
      },
    });
  }

  it('reads nodes of the type that have the field, with its value, in one query-nodes call', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const nodes = [{ id: 'p-1', title: 'Atlas', fields: { wiki: true } }, { id: 'p-2', title: 'Beacon', fields: { wiki: { value: 'true' } } }];
    const found = await new Engine(config, factory([nodes], calls)).listNodesWithField('initiative', 'wiki');
    expect(found).toEqual([{ id: 'p-1', title: 'Atlas', value: true }, { id: 'p-2', title: 'Beacon', value: 'true' }]);
    expect(calls).toEqual([{ name: 'query-nodes', types: ['initiative'], fields: { wiki: { exists: true } }, include_fields: ['wiki'],
      select: ['id', 'title'], sort_by: 'title', limit: 200, offset: 0 }]);
  });

  it('pages past query-nodes\' 200-node cap', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `p-${from + i}`, title: `P${from + i}`, fields: { wiki: true } }));
    const found = await new Engine(config, factory([page(0, 200), page(200, 3)], calls)).listNodesWithField('project', 'wiki');
    expect(found).toHaveLength(203);
    expect(calls.map(c => c.offset)).toEqual([0, 200]);
  });
});

describe('tool descriptions name the wiki request field', () => {
  // The descriptions as they read with the default field, which gives the text from before the vault map
  // (create-project-wiki's since #544 promises no sweep build).
  const CREATE_BEFORE = 'Start keeping a wiki for a project note. Project wikis exist only when requested: this registers the project (scheduled sweeps maintain registered wikis only while curator-status reports wiki_reconciliation_mode "live") and creates an empty home page with live task sections when none exists (free). It then queues the first curation and replies at once with first_build "queued": the wiki usually fills in within a few minutes, within the daily budget. If the budget is spent, or the wiki was already paused (answered at once as skipped), the first build does not run and the empty home stays: build it later with curate-project-wiki and force, which leaves a paused wiki paused. curator-status shows the outcome. Do not call again to check; a repeat call while that build is queued or running replies first_build "in_progress" and starts nothing. Idempotent: re-calling for an existing wiki just confirms it. Use dry_run to see what would happen. A person can ask for the same thing by setting wiki: true on the project note, and so can an AI caller with the Engine\'s update-node: the Curator checks for that field every 15 minutes and registers the wiki through this same path (refusals go in the Curator journal). Removing the field does nothing. To stop maintaining a project wiki use remove-wiki; to pause it use set-wiki-paused. Requires the curate:trigger scope.';
  const REMOVE_BEFORE = 'Stop curating a topic or project wiki — deregister it so the nightly sweep skips it for good. Also clears that wiki\'s pause flag, standing corrections, and page requests. Use this, not set-wiki-paused, when a wiki was created by mistake or is finished for good; pausing leaves the registration in place. Takes the topic or project title exactly as listed in curator-status — not the "<title> Wiki" page title. Does NOT delete the wiki pages from the vault; the response names the pages left behind so they can be deleted deliberately. On a project wiki it also removes wiki: true from the project note (best-effort; wiki_field says whether it did), so the Curator doesn\'t register the wiki again. Requires the curate:trigger scope.';

  it('reads exactly as before with the default field', () => {
    expect(createProjectWikiDescription('wiki')).toBe(CREATE_BEFORE);
    expect(removeWikiDescription('wiki')).toBe(REMOVE_BEFORE);
    expect(createProjectWikiDescription(vaultOf({}).wikiFlagField)).toBe(CREATE_BEFORE);
  });

  it('names a designated field, and says nothing of asking from the note when it is none', () => {
    expect(createProjectWikiDescription('make wiki')).toContain('by setting make wiki: true on the project note');
    expect(removeWikiDescription('make wiki')).toContain('it also removes make wiki: true from the project note');
    const create = createProjectWikiDescription(null);
    const remove = removeWikiDescription(null);
    for (const text of [create, remove]) {
      expect(text).not.toMatch(/: true|wiki_field|that field/);
      expect(text).toMatch(/\. Requires the curate:trigger scope\.$/);
    }
    expect(create).toBe(CREATE_BEFORE.replace(/ A person can ask .* Removing the field does nothing\./, ''));
    expect(remove).toBe(REMOVE_BEFORE.replace(/ On a project wiki .* register the wiki again\./, ''));
  });
});
