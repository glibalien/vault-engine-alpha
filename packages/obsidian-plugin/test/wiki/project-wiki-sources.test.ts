import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings.js';

const conn = { call: vi.fn(), close: vi.fn(async () => {}), listTools: vi.fn(async () => []) };
vi.mock('../../src/engine/transport.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  connectEngine: vi.fn(async () => conn),
}));
const { connectEngine } = await import('../../src/engine/transport.js');
const { pluginProjectWikiSources } = await import('../../src/wiki/project-wikis.js');

const envelope = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const settings = { ...DEFAULT_SETTINGS, engineUrl: 'https://engine/mcp', token: 'engine-token', curatorUrl: 'https://curator/mcp', curatorToken: 'curator-token' };

it('reads the project kind from Engine\'s vault map with get-settings, and closes the connection', async () => {
  conn.call.mockResolvedValueOnce(envelope({ ok: true, data: { domains: { vault: { effective: { projectType: 'engagement' } } } } }));
  expect(await pluginProjectWikiSources(settings).projectType()).toBe('engagement');
  expect(connectEngine).toHaveBeenCalledWith('https://engine/mcp', 'engine-token');
  expect(conn.call).toHaveBeenCalledWith({ name: 'get-settings', arguments: {} });
  expect(conn.close).toHaveBeenCalled();
});

it('reports none when the vault map has no project kind', async () => {
  conn.call.mockResolvedValueOnce(envelope({ ok: true, data: { domains: { vault: { effective: { projectType: null } } } } }));
  expect(await pluginProjectWikiSources(settings).projectType()).toBeNull();
});

it('reads an older Engine\'s wiki.projectType', async () => {
  conn.call.mockResolvedValueOnce(envelope({ ok: true, data: { domains: { wiki: { effective: { projectType: 'engagement' } } } } }));
  expect(await pluginProjectWikiSources(settings).projectType()).toBe('engagement');
});

it('fails, so the last known type stays, when Engine reports none', async () => {
  conn.call.mockResolvedValueOnce(envelope({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } }));
  await expect(pluginProjectWikiSources(settings).projectType()).rejects.toThrow(/no project type/);
});

it('lists project wikis over the Curator connection, and closes it', async () => {
  conn.close.mockClear();
  conn.call.mockResolvedValueOnce(envelope({ project_wikis: [{ project: 'Alpha', root_node_id: 'a' }] }));
  expect(await pluginProjectWikiSources(settings).projectWikis()).toEqual(['Alpha']);
  expect(connectEngine).toHaveBeenLastCalledWith('https://curator/mcp', 'curator-token');
  expect(conn.close).toHaveBeenCalled();
});
