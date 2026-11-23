// An existing installation upgraded to the map-reading Curator code (#446): every name Curator
// used to hard-code is read from the vault map as the same name, so it behaves as before.
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { defaultsFor, SEED_MODELS } from '@vault/settings-registry';
import type { CuratorSettings, VaultSettings } from '@vault/settings-registry';
import { buildRuntimeConfig, CuratorSettingsClient, type EngineSettingsApi } from '../src/settings.js';
import { vaultOf, type BootstrapConfig, type Config } from '../src/config.js';
import { Engine, EngineError, type EngineClientFactory, type SettingsDomainPayload } from '../src/engine.js';
import { runMigrations } from '../src/db/migrate.js';
import { insertJournalEvent, type JournalEventInsert } from '../src/db/journal.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { writeJournalEntry } from '../src/journal/writer.js';
import { noteDate } from '../src/memory-sweep.js';
import { WikiFieldCheck } from '../src/wiki-field-check.js';

const CURATOR_DEFAULTS = defaultsFor('curator') as unknown as CuratorSettings;
const VAULT_DEFAULTS = defaultsFor('vault') as unknown as VaultSettings;

/** The curator domain as the installation stores it (generic values). */
const INSTALLED_CURATOR: CuratorSettings = {
  ...CURATOR_DEFAULTS,
  wikiReconciliationMode: 'live', tz: '',
  memorySweepEnabled: true, memorySweepTypes: ['meeting', 'daily-note', 'note'],
  conversationSweepEnabled: true, conversationCaptureMode: 'live',
  orgSweepEnabled: true, orgTypeExclude: ['wiki', 'transcript'],
  journalEnabled: true,
};

const payload = (effective: Record<string, unknown>): SettingsDomainPayload =>
  ({ effective, stored: {}, version: 1, seeded: true, issues: [] });

const bootstrap = (): BootstrapConfig => ({
  engineUrl: 'http://e', engineToken: 't', experiment: null, variant: null,
  llmKeys: { keys: { anthropic: 'ak' }, baseURLs: {} },
  oauthOwnerPassword: undefined, oauthIssuerUrl: undefined,
  curatorPort: 3335, curatorDbPath: ':memory:', memorySweepSince: null, conversationSweepSince: null,
});

/** What get-settings reports: Engine with the vault map (the first boot moved activeStatuses
 *  there), or an Engine older than the map, whose wiki domain has nothing stored. */
function settingsApi(withVaultDomain: boolean): EngineSettingsApi {
  const curator = withVaultDomain
    ? INSTALLED_CURATOR
    : { ...INSTALLED_CURATOR, activeStatuses: ['open', 'in-progress', 'next'], topicDir: null, projectStatusField: 'status' };
  const models = { catalog: SEED_MODELS, providers: { anthropic: true }, version: 1, issues: [] };
  const domains: Record<string, unknown> = withVaultDomain
    ? { curator: payload(curator as unknown as Record<string, unknown>), models,
      vault: payload({ ...VAULT_DEFAULTS, projectActiveStatuses: ['open', 'in-progress', 'next'] } as unknown as Record<string, unknown>) }
    : { curator: payload(curator as unknown as Record<string, unknown>), models,
      wiki: payload({ ...(defaultsFor('wiki') as Record<string, unknown>) }) };
  return {
    getSettings: async () => ({ settingsDir: 'Settings', domains }) as never,
    updateSettings: async () => ({ warnings: [] }),
  };
}

async function upgradedConfig(withVaultDomain: boolean): Promise<Config> {
  const { settings, catalog, settingsDir, vault } = await new CuratorSettingsClient(
    settingsApi(withVaultDomain), {} as NodeJS.ProcessEnv, () => {}).effective();
  return buildRuntimeConfig(bootstrap(), settings, catalog, { settingsDir, vault });
}

describe.each([true, false])('Curator map readers on an upgraded installation (vault domain reported: %s)', withVaultDomain => {
  it('read every name they used as a literal, and leave the stored curator settings as they were', async () => {
    const config = await upgradedConfig(withVaultDomain);
    expect(vaultOf(config)).toMatchObject({
      journalType: 'note', topicType: 'topic', wikiType: 'wiki', wikiFlagField: 'wiki', dateField: 'date',
      projectType: 'project', projectStatusField: 'status', taskStatusField: 'status',
    });
    expect(config).toMatchObject({
      settingsDir: 'Settings', activeStatuses: ['open', 'in-progress', 'next'], topicDir: null, wikiDir: 'Wikis',
      memorySweepTypes: ['meeting', 'daily-note', 'note'], orgTypeExclude: ['wiki', 'transcript'],
      journalEnabled: true, conversationCaptureMode: 'live', staleProjectStatus: 'backlog',
    });
  });

  it('send the same gap-fill query as before', async () => {
    const config = await upgradedConfig(withVaultDomain);
    const calls: Array<Record<string, unknown>> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push(req.arguments);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [
            { id: 'n', title: 'N', types: ['note'], fields: { status: 'open' } },
          ] } }) }] };
        },
      },
    });
    const out = await new Engine(config, factory).semanticRelated('q', 5, config);
    expect(calls).toEqual([{ query: 'q', include_fields: ['status'], without_fields: ['vault_engine_projection'],
      without_types: ['wiki'], without_path_prefix: 'Settings/', limit: 5 }]);
    expect(out[0]?.status).toBe('open');
  });

  it('find the journal note by title, and create it as a note when it is missing', async () => {
    const config = await upgradedConfig(withVaultDomain);
    const db = new Database(':memory:'); runMigrations(db);
    const created: Array<Record<string, unknown>> = [];
    const kinds: string[] = [];
    let exists = true;
    const engine = {
      getNodeByTitle: vi.fn(async (title: string) => {
        if (!exists) throw new EngineError('NOT_FOUND', `no node titled ${title}`);
        return { id: 'journal-node', title };
      }),
      ensureNoteSchema: async (type: string) => { kinds.push(type); },
      createNode: async (args: Record<string, unknown>) => { created.push(args); return { node_id: 'journal-node' }; },
      appendNodeBody: vi.fn(async () => {}),
    } as unknown as Engine;
    const deps = { engine, llm: { structuredCall: vi.fn() }, config, db, recorder: new ActionRecorder(db) };
    const event: JournalEventInsert = { ts: '2026-07-13T09:04:00.000Z', run_ref: 'r', trigger: 'scheduled', function: 'org-sweep',
      kind: 'action', action: 'typed', node_id: null, target: null, detail: 'typed', dry_run: 0 };

    insertJournalEvent(db, event);
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', new Date(event.ts), { modelLede: false });
    expect(engine.getNodeByTitle).toHaveBeenCalledWith('Curator Journal — 2026-07');
    expect(created).toEqual([]);

    exists = false;
    insertJournalEvent(db, event);
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', new Date(event.ts), { modelLede: false });
    expect(kinds).toEqual(['note']);
    expect(created).toEqual([expect.objectContaining({ title: 'Curator Journal — 2026-07', types: ['note'], directory: 'Wikis' })]);
    db.close();
  });

  it('read note dates from `date` and the wiki request from `wiki` on project notes', async () => {
    const config = await upgradedConfig(withVaultDomain);
    expect(noteDate({ date: '2020-10-30', written: '2021-01-01' }, 'Untitled', vaultOf(config).dateField)).toBe('2020-10-30');
    const db = new Database(':memory:'); runMigrations(db);
    const listNodesWithField = vi.fn(async () => []);
    await new WikiFieldCheck({ engine: { listNodesWithField }, db,
      vocabulary: async () => ({ projectType: config.projectType ?? null, wikiFlagField: vaultOf(config).wikiFlagField }),
      coreDeps: async () => { throw new Error('unused'); } }).run();
    expect(listNodesWithField).toHaveBeenCalledWith('project', 'wiki');
    db.close();
  });
});
