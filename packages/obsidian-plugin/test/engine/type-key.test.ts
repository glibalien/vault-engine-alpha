import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings.js';

const conn = { call: vi.fn(), close: vi.fn(async () => {}), listTools: vi.fn(async () => []) };
vi.mock('../../src/engine/transport.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  connectEngine: vi.fn(async () => conn),
}));
const { connectEngine } = await import('../../src/engine/transport.js');
const { EngineTypeKey, noteTypes, readEngineTypeKey } = await import('../../src/engine/type-key.js');

const envelope = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const settings = { ...DEFAULT_SETTINGS, engineUrl: 'https://engine/mcp', token: 'engine-token' };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

it('reads the type key get-settings reports, and closes the connection', async () => {
  conn.call.mockResolvedValueOnce(envelope({ ok: true, data: { settingsDir: 'Settings', typeKey: 'kind', domains: {} } }));
  expect(await readEngineTypeKey(settings)).toBe('kind');
  expect(connectEngine).toHaveBeenCalledWith('https://engine/mcp', 'engine-token');
  expect(conn.call).toHaveBeenCalledWith({ name: 'get-settings', arguments: { domain: 'engine' } });
  expect(conn.close).toHaveBeenCalled();
});

it('reads types from an Engine that reports no type key', async () => {
  conn.call.mockResolvedValueOnce(envelope({ ok: true, data: { settingsDir: 'Settings', domains: {} } }));
  expect(await readEngineTypeKey(settings)).toBe('types');
});

it('fails when Engine refuses, so the last known key stays', async () => {
  conn.call.mockResolvedValueOnce(envelope({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } }));
  await expect(readEngineTypeKey(settings)).rejects.toThrow(/did not report/);
});

it('is types until Engine answers, then keeps the key without asking again', async () => {
  const read = vi.fn(async () => 'kind');
  const key = new EngineTypeKey(read);
  expect(key.current()).toBe('types');
  await flush();
  expect(key.current()).toBe('kind');
  key.current();
  expect(read).toHaveBeenCalledTimes(1);
});

it('waits before asking again after a failure, and forgets the key on reset', async () => {
  let now = 0;
  const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('down')).mockResolvedValue('kind');
  const key = new EngineTypeKey(read, () => now);
  key.current();
  await flush();
  expect(key.current()).toBe('types');
  expect(read).toHaveBeenCalledTimes(1);
  now += 601_000;
  key.current();
  await flush();
  expect(key.current()).toBe('kind');
  key.reset();
  expect(key.current()).toBe('types');
  await flush();
  expect(read).toHaveBeenCalledTimes(3);
});

it('says when a read finds another key, and only then', async () => {
  const changed = vi.fn();
  const kind = new EngineTypeKey(async () => 'kind', Date.now, changed);
  kind.current();
  await flush();
  expect(changed).toHaveBeenCalledWith('kind');
  const same = vi.fn();
  const types = new EngineTypeKey(async () => 'types', Date.now, same);
  types.current();
  await flush();
  expect(same).not.toHaveBeenCalled();
});

it('reads a note\'s types as Engine and the Analyzer do, one reading for every key (#445, #482)', () => {
  // An unquoted [[link]] is a nested list in YAML and in Obsidian's frontmatter cache.
  expect(noteTypes([['project']])).toEqual(['project']);
  expect(noteTypes(['project', '[[note]]', 3, [['meeting']], null])).toEqual(['project', 'note', '3', 'meeting']);
  expect(noteTypes('[[project]]')).toEqual(['project']);
  expect(noteTypes(['[[meeting|Meetings]]', [['task | Tasks']], 3, true])).toEqual(['meeting', 'task', '3', 'true']);
  expect(noteTypes(['project', '[[project]]', [['project|P']]])).toEqual(['project']);
  expect(noteTypes('meeting')).toEqual(['meeting']);
  // A mapping or a list other than a link is no type.
  expect(noteTypes({ a: 'project' })).toEqual([]);
  expect(noteTypes([{ a: 1 }, null, ['a', 'b']])).toEqual([]);
  expect(noteTypes(undefined)).toEqual([]);
});
