import { z } from 'zod';
import type { CoreDeps } from '../core.js';
import { withScope, type ToolHandler, type ToolResult } from '../auth/with-scope.js';
import { homeRefreshGuardSchema, homeRefreshRequestSchema } from '../home-refresh-schema.js';
import { previewHomeRefresh } from '../home-refresh-preview.js';
import { executeHomeRefresh, readHomeRefreshStatus } from '../home-refresh.js';
import type { HomeRefreshRequest } from '../home-refresh-types.js';
export const previewHomeRefreshInput = { output_revision_id: z.string().min(1).max(512) };
export const homeRefreshStatusInput = { request_id: z.string().uuid() };
export const refreshProjectHomeInput = { request_id: z.string().uuid(), confirm_paid: z.literal(true), guard: homeRefreshGuardSchema };
async function safely(action: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try { return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: await action() }) }] }; } catch (error) {
    const code = error instanceof z.ZodError ? 'INVALID_ARGUMENT' : error instanceof Error
      && ['REQUEST_CONFLICT', 'REQUEST_NOT_FOUND', 'GUARD_CONFLICT', 'STORAGE_UNAVAILABLE', 'READINESS_UNAVAILABLE'].includes(error.message) ? error.message : 'REFRESH_UNAVAILABLE';
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code,
      message: code === 'GUARD_CONFLICT' ? 'The preview is no longer current. Preview again before confirming.' : 'Refresh request could not be completed. Check the request or retry status.' } }) }] };
  }
}
export function makePreviewHomeRefreshHandler(deps: CoreDeps): ToolHandler<{ output_revision_id: string }> {
  return withScope('curate:read', args => safely(() => previewHomeRefresh(deps, z.object(previewHomeRefreshInput).strict().parse(args).output_revision_id)));
}
export function makeRefreshProjectHomeHandler(deps: CoreDeps): ToolHandler<HomeRefreshRequest> {
  return withScope('curate:trigger', args => safely(() => executeHomeRefresh(deps, homeRefreshRequestSchema.parse(args))));
}
export function makeHomeRefreshStatusHandler(deps: CoreDeps): ToolHandler<{ request_id: string }> {
  return withScope('curate:read', args => safely(() => readHomeRefreshStatus(deps, z.object(homeRefreshStatusInput).strict().parse(args).request_id)));
}
