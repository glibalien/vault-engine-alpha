import { connectEngine, type EngineConnection } from '../engine/transport.js';
import { unwrapEnvelope } from '../engine/client.js';
import { PluginSettingsClient } from '../engine/settings-client.js';
import type { VaultPluginSettings } from '../settings.js';
import type { CallFn } from '../engine/types.js';
import type { ModelProvider } from '@vault/settings-registry';
import { toggleArgs, type CatalogEntry, type DiscoveredModelRow } from './discover-format.js';
import type { ModelPricingInput } from './price-modal.js';

export type DiscoverResult =
  | { ok: true; rows: DiscoveredModelRow[] }
  | { ok: false; message: string };
export type AddResult = { ok: true; title: string } | { ok: false; message: string };
export type ToggleResult = { ok: true } | { ok: false; message: string };

/** The engine-call seam the models modal drives — injectable so the modal is
 *  testable without a live engine (mirrors search's `Searcher`). Backed by a
 *  single lazily-opened connection, reused for one modal session and closed on
 *  modal onClose. */
export interface ModelService {
  discover(provider: ModelProvider, query: string): Promise<DiscoverResult>;
  /** `pricing` (USD per million tokens) sets the price of a model with no list price. */
  add(provider: ModelProvider, model: string, pricing?: ModelPricingInput): Promise<AddResult>;
  toggle(title: string, currentEnabled: boolean): Promise<ToggleResult>;
  catalog(): Promise<CatalogEntry[]>;
  close(): Promise<void>;
}

const DISCOVER_LIMIT = 30;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type ConnectFn = (engineUrl: string, token: string) => Promise<EngineConnection>;
type ServiceSettings = Pick<VaultPluginSettings, 'engineUrl' | 'token'>;

/**
 * A ModelService backed by one lazily-opened engine connection. A thrown error
 * (failed connect / dead transport) clears the cached connection so the next
 * call can reconnect. `connect` is injectable for tests.
 */
export function makeModelService(settings: ServiceSettings, connect: ConnectFn = connectEngine): ModelService {
  let connPromise: Promise<EngineConnection> | null = null;

  const call: CallFn = async (tc) => {
    try {
      if (!connPromise) connPromise = connect(settings.engineUrl, settings.token);
      const conn = await connPromise;
      return await conn.call(tc);
    } catch (e) {
      connPromise = null; // allow a reconnect on the next call
      throw e;
    }
  };

  // One settings read per modal session serves the catalog and the model notes' folder.
  let settingsClient: PluginSettingsClient | null = null;
  const settingsOf = () => (settingsClient ??= new PluginSettingsClient(call)).effective();

  return {
    async discover(provider, query) {
      try {
        const res = await call({ name: 'discover-models', arguments: { provider, query, limit: DISCOVER_LIMIT } });
        const env = unwrapEnvelope<{ models: DiscoveredModelRow[]; total_before_limit: number }>(res);
        if (!env.ok || !env.data) return { ok: false, message: env.error?.message ?? 'discover-models failed' };
        return { ok: true, rows: env.data.models };
      } catch (e) {
        return { ok: false, message: errMsg(e) };
      }
    },

    async add(provider, model, pricing) {
      try {
        const res = await call({ name: 'add-model', arguments: { provider, model, ...(pricing ? { pricing } : {}) } });
        const env = unwrapEnvelope<{ title: string; entry: unknown }>(res);
        if (!env.ok || !env.data) return { ok: false, message: env.error?.message ?? 'add-model failed' };
        return { ok: true, title: env.data.title };
      } catch (e) {
        return { ok: false, message: errMsg(e) };
      }
    },

    async toggle(title, currentEnabled) {
      try {
        const { settingsDir } = await settingsOf();
        const { getNode, setFields } = toggleArgs(title, currentEnabled, settingsDir);
        const nodeRes = await call({ name: 'get-node', arguments: getNode });
        const nodeEnv = unwrapEnvelope<{ id: string }>(nodeRes);
        if (!nodeEnv.ok || !nodeEnv.data) return { ok: false, message: nodeEnv.error?.message ?? `could not load "${title}"` };
        const updRes = await call({ name: 'update-node', arguments: { node_id: nodeEnv.data.id, set_fields: setFields } });
        const updEnv = unwrapEnvelope<unknown>(updRes);
        if (!updEnv.ok) return { ok: false, message: updEnv.error?.message ?? 'update-node failed' };
        return { ok: true };
      } catch (e) {
        return { ok: false, message: errMsg(e) };
      }
    },

    async catalog() {
      const { catalog } = await settingsOf();
      return catalog.map((e) => ({ title: e.title, provider: e.provider, enabled: e.enabled }));
    },

    async close() {
      if (!connPromise) return;
      const pending = connPromise;
      connPromise = null;
      try {
        await (await pending).close();
      } catch {
        // a failed/aborted connection has nothing to close
      }
    },
  };
}
