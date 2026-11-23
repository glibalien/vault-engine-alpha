import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { vaultSettingsFrom } from '@vault/settings-registry';
import {
  DEFAULT_VAULT_MAP, VaultMapIndex, connectionVaultMap, readVaultMap, vaultMapFrom, type VaultMap,
} from '../../src/engine/vault-map.js';

const envelope = (body: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }] }) as CallToolResult;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** get-settings from an Engine older than the vault map, as the current installation answers it:
 *  no vault domain and no settingsDir; wiki at its defaults (nothing stored), curator with three
 *  active project statuses. */
const OLDER_ENGINE = {
  domains: {
    wiki: { effective: {
      projectType: 'project', taskType: 'task', meetingType: 'meeting', personType: 'person', companyType: 'company',
      wikiType: 'wiki', dueField: 'due', peopleField: 'people involved', companyField: 'company', wikiDir: 'Wikis',
      statusField: 'status', statusOpen: ['open', 'in-progress'], statusDone: ['done'], statusBlocked: ['blocked'],
      statusIgnored: ['dropped'], statusBacklog: ['backlog'],
    } },
    curator: { effective: { activeStatuses: ['open', 'in-progress', 'next'], topicDir: null, projectStatusField: 'status' } },
    chat: { effective: {} },
  },
};

describe('vaultMapFrom', () => {
  it('reads an older Engine as the map\'s defaults, with the curator\'s project statuses, and the Settings folder', () => {
    const map = vaultMapFrom(OLDER_ENGINE);
    expect(map.settingsDir).toBe('Settings');
    expect(map.vault).toEqual({ ...vaultSettingsFrom(undefined), projectActiveStatuses: ['open', 'in-progress', 'next'] });
    // Every name the plugin reads is today's.
    expect(map.vault).toMatchObject({
      taskType: 'task', taskStatusField: 'status', taskDoneStatuses: ['done'], taskTickStatus: 'done', taskUntickStatus: 'open',
      dueField: 'due', dateField: 'date', scheduledField: 'scheduled', priorityField: 'priority',
      wikiType: 'wiki', projectType: 'project',
    });
  });

  it('reads the vault domain, keeps none as null, and takes the reported settings folder', () => {
    const map = vaultMapFrom({ settingsDir: 'Config', domains: { vault: { effective: { taskType: 'todo', wikiType: null } } } });
    expect(map.settingsDir).toBe('Config');
    expect(map.vault.taskType).toBe('todo');
    expect(map.vault.wikiType).toBeNull();
  });

  it('defaults when the payload is missing', () => {
    expect(vaultMapFrom(undefined)).toEqual(DEFAULT_VAULT_MAP);
    expect(DEFAULT_VAULT_MAP).toEqual({ vault: vaultSettingsFrom(undefined), settingsDir: 'Settings', timeZone: null });
  });

  it('takes Curator\'s time zone for the calendar, and none when it is empty or not reported (#574)', () => {
    expect(vaultMapFrom(OLDER_ENGINE).timeZone).toBeNull();
    const withTz = (tz: unknown) => vaultMapFrom({ domains: { ...OLDER_ENGINE.domains, curator: { effective: { tz } } } }).timeZone;
    expect(withTz('America/New_York')).toBe('America/New_York');
    expect(withTz(' Europe/Paris ')).toBe('Europe/Paris');
    expect(withTz('')).toBeNull();
    expect(withTz(null)).toBeNull();
  });
});

describe('readVaultMap', () => {
  it('makes one get-settings call for every domain', async () => {
    const call = vi.fn(async () => envelope({ ok: true, data: OLDER_ENGINE }));
    expect(await readVaultMap(call)).toEqual(vaultMapFrom(OLDER_ENGINE));
    expect(call).toHaveBeenCalledWith({ name: 'get-settings', arguments: {} });
  });

  it('fails on an error envelope, so the last known map stays', async () => {
    const call = vi.fn(async () => envelope({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }));
    await expect(readVaultMap(call)).rejects.toThrow('boom');
  });
});

describe('VaultMapIndex', () => {
  const OTHER: VaultMap = vaultMapFrom({ domains: { vault: { effective: { taskType: 'todo' } } } });

  function index(read: () => Promise<VaultMap>) {
    let now = 0;
    const idx = new VaultMapIndex(vi.fn(read), () => now);
    return { idx, read: vi.mocked((idx as unknown as { read: () => Promise<VaultMap> }).read), advance: (ms: number) => { now += ms; } };
  }

  it('serves the defaults until a read lands, then the read map', async () => {
    const { idx } = index(async () => OTHER);
    expect(idx.current()).toBe(DEFAULT_VAULT_MAP);
    idx.refresh();
    await flush();
    expect(idx.current()).toEqual(OTHER);
  });

  it('reads at most once per ten minutes, and waits that long after a failure too', async () => {
    let fail = true;
    const { idx, read, advance } = index(async () => { if (fail) throw new Error('down'); return OTHER; });
    idx.refresh(); idx.refresh();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(idx.current()).toBe(DEFAULT_VAULT_MAP);
    fail = false;
    idx.refresh();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    advance(600_000);
    expect(await idx.load()).toEqual(OTHER);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known map when a later read fails', async () => {
    let fail = false;
    const { idx, advance } = index(async () => { if (fail) throw new Error('down'); return OTHER; });
    await idx.load();
    fail = true;
    advance(600_000);
    expect(await idx.load()).toEqual(OTHER);
  });

  it('tells subscribers when the map changes, not when a read finds the same map', async () => {
    const { idx, advance } = index(async () => OTHER);
    const listener = vi.fn();
    const unsubscribe = idx.subscribe(listener);
    await idx.load();
    expect(listener).toHaveBeenCalledTimes(1);
    advance(600_000);
    await idx.load();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    advance(600_000);
    await idx.load();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reads again at once when reset, ignoring a read in flight from the old connection', async () => {
    const releases: Array<(map: VaultMap) => void> = [];
    const { idx, read } = index(() => new Promise<VaultMap>((resolve) => { releases.push(resolve); }));
    const first = idx.load();
    idx.reset();
    expect(read).toHaveBeenCalledTimes(2);
    releases[0]!(OTHER);
    await first;
    expect(idx.current()).toBe(DEFAULT_VAULT_MAP);
    const NEW = vaultMapFrom({ domains: { vault: { effective: { taskType: 'chore' } } } });
    releases[1]!(NEW);
    expect(await idx.load()).toEqual(NEW);
  });

  it('keeps the last known map for open views until the read after a reset lands', async () => {
    const releases: Array<(map: VaultMap) => void> = [];
    let first = true;
    const { idx } = index(() => {
      if (first) { first = false; return Promise.resolve(OTHER); }
      return new Promise<VaultMap>((resolve) => { releases.push(resolve); });
    });
    await idx.load();
    const listener = vi.fn();
    idx.subscribe(listener);
    idx.reset();
    expect(idx.current()).toEqual(OTHER);
    expect(listener).not.toHaveBeenCalled();
    releases[0]!(DEFAULT_VAULT_MAP);
    await flush();
    expect(idx.current()).toBe(DEFAULT_VAULT_MAP);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('connectionVaultMap', () => {
  it('serves an open view the map of the Engine it is connected to, whatever the settings switch to', async () => {
    const oldEngine = vi.fn(async () => envelope({ ok: true, data: { domains: { vault: { effective: { taskStatusField: 'status' } } } } }));
    const newEngine: VaultMap = vaultMapFrom({ domains: { vault: { effective: { taskStatusField: 'state' } } } });
    // The plugin-wide map, already read from the old Engine.
    let global = vaultMapFrom({ domains: { vault: { effective: { taskStatusField: 'status' } } } });
    const plugin = new VaultMapIndex(async () => global);
    await plugin.load();

    const view = connectionVaultMap(oldEngine, plugin.current());
    // Until its own read lands, the view starts from the plugin's last known map.
    expect(view.current().vault.taskStatusField).toBe('status');
    await view.load();
    expect(oldEngine).toHaveBeenCalledWith({ name: 'get-settings', arguments: {} });

    // The settings switch to another Engine: the plugin-wide map follows it, the open view does not.
    global = newEngine;
    plugin.reset();
    await flush();
    expect(plugin.current().vault.taskStatusField).toBe('state');
    expect(view.current().vault.taskStatusField).toBe('status');
  });

  it('starts an index from a given map instead of the defaults', () => {
    const seed = vaultMapFrom({ domains: { vault: { effective: { taskType: 'todo' } } } });
    expect(new VaultMapIndex(() => new Promise<VaultMap>(() => {}), Date.now, seed).current()).toBe(seed);
  });
});
