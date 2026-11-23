import { makeClient } from '@vault/query-core';
import { connectEngine, type EngineConnection } from '../engine/transport.js';
import type { VaultPluginSettings } from '../settings.js';
import { searchVault, SEARCH_RESULT_LIMIT, type SearchResult } from './search.js';

export interface Searcher {
  search(query: string): Promise<SearchResult>;
  close(): Promise<void>;
}

type ConnectFn = (engineUrl: string, token: string) => Promise<EngineConnection>;
type SearcherSettings = Pick<VaultPluginSettings, 'engineUrl' | 'token' | 'searchMode'>;

/** A Searcher backed by a single lazily-opened engine connection, reused for the
 *  lifetime of one modal session. `connect` is injectable for tests. A thrown
 *  error (failed connect or dead transport) clears the cached connection so the
 *  next keystroke can reconnect. */
export function makeEngineSearcher(settings: SearcherSettings, connect: ConnectFn = connectEngine): Searcher {
  let connPromise: Promise<EngineConnection> | null = null;

  return {
    async search(query: string): Promise<SearchResult> {
      try {
        if (!connPromise) connPromise = connect(settings.engineUrl, settings.token);
        const conn = await connPromise;
        return await searchVault(makeClient(conn.call), query, settings.searchMode, SEARCH_RESULT_LIMIT);
      } catch (e) {
        connPromise = null; // allow a reconnect on the next keystroke
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async close(): Promise<void> {
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
