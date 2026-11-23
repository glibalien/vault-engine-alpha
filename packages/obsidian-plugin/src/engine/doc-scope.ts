import type { App } from 'obsidian';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CallFn } from '../engine/types.js';
import type { DocScope } from '@vault/board-core';
export type { DocScope } from '@vault/board-core';

function parseNodeId(result: CallToolResult): string | null {
  const first = result.content?.[0] as { type: string; text?: string } | undefined;
  if (typeof first?.text !== 'string') return null;
  try {
    const env = JSON.parse(first.text) as { ok: boolean; data?: { id?: string } };
    return env.ok ? (env.data?.id ?? null) : null;
  } catch {
    return null;
  }
}

export function makeDocScope(app: App, call: CallFn): DocScope {
  // Cache path → node id; `get-node` returns the node flat (incl. id).
  const cache = new Map<string, string | null>();
  return {
    currentKey() {
      return app.workspace.getActiveFile()?.path ?? null;
    },
    async current() {
      const path = app.workspace.getActiveFile()?.path ?? null;
      if (!path) return null;
      if (cache.has(path)) return cache.get(path) ?? null;
      let id: string | null = null;
      try {
        id = parseNodeId(await call({ name: 'get-node', arguments: { file_path: path } }));
      } catch {
        id = null;
      }
      cache.set(path, id);
      return id;
    },
    subscribe(cb) {
      const a = app.workspace.on('active-leaf-change', cb);
      const b = app.workspace.on('file-open', cb);
      return () => { app.workspace.offref(a); app.workspace.offref(b); };
    },
  };
}
