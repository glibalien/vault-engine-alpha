import type { OutputReceipt } from './provenance-types.js';
export type HomeRefreshGuard = {
  version: 1; vault_namespace: string; project_id: string; home_node_id: string;
  output_revision_id: string; home_version: number; topology_hash: string;
  configuration_digest: string; corrections_digest: string;
  /** Only when the target is a sub-page. The fields above keep describing the wiki's home. */
  page_node_id?: string; page_version?: number;
};
export type HomeRefreshPhase = 'queued' | 'preparing' | 'dispatch_intent' | 'stage_pending' | 'publishing' | 'awaiting_recovery' | 'committed' | 'conflict' | 'failed' | 'uncertain';
export type HomeRefreshRequest = { request_id: string; guard: HomeRefreshGuard; confirm_paid: true };
export type HomeRefreshUsage = { input: number; output: number; cacheWrite: number; cacheRead: number };
export type HomeRefreshStatus = {
  request_id: string; phase: HomeRefreshPhase; message: string; created_at: string; updated_at: string;
  replaces_output_revision_id: string; output: OutputReceipt | null; usage: HomeRefreshUsage | null;
};
export type HomeRefreshPreview = {
  eligible: boolean; reasons: Array<{ code: string; message: string }>; guard: HomeRefreshGuard | null;
  /** What a rebuild rewrites: the wiki's home, or the one sub-page named by the page fields. */
  target_kind: 'home' | 'page'; page_title: string | null; page_path: string | null;
  project_title: string | null; home_title: string | null; home_path: string | null;
  model: { ref: string; provider: string; max_output_tokens: number } | null; sections: string[];
};
export type HomeRefreshApi = {
  preview(outputRevisionId: string): Promise<HomeRefreshPreview>;
  execute(request: HomeRefreshRequest): Promise<HomeRefreshStatus>;
  status(requestId: string): Promise<HomeRefreshStatus>;
};
export const isHomeRefreshTerminal = (phase: HomeRefreshPhase): boolean =>
  ['committed', 'conflict', 'failed', 'uncertain'].includes(phase);
