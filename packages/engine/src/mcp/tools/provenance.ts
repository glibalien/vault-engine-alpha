import { z } from 'zod';
import { inspectProvenance } from '../../provenance/inspect.js';
import { findAffectedOutputs, impactSchema } from '../../provenance/impact.js';
import { previewProvenancePurge, commitProvenancePurge, purgeSchema } from '../../provenance/purge.js';
import type { InspectRequest } from '../../provenance/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { SettingsService } from '../../settings/service.js';
import { DEFAULT_PROVENANCE_LIMITS, ProvenanceError, readProvenanceLimits } from '../../provenance/limits.js';
import { ProvenanceService, transitionSchema } from '../../provenance/service.js';
import { prepareSchema, stageSchema } from '../../provenance/validation.js';
import type { PrepareRequest } from '../../provenance/types.js';
import { fail, ok } from './errors.js';

export function provenanceFailure(error: unknown) {
  if (!(error instanceof ProvenanceError)) return fail('INTERNAL_ERROR', 'Provenance operation failed');
  const code = error.reason === 'PROVENANCE_KEY_CONFLICT' || error.reason === 'PURGE_SCOPE_CHANGED' ? 'CONFLICT'
    : error.reason === 'PROVENANCE_OBSERVATION_CHANGED' ? 'STALE_NODE'
    : error.reason === 'PROVENANCE_LIMIT' ? 'INVALID_PARAMS' : 'VALIDATION_FAILED';
  return fail(code, error.reason, { details: { reason: error.reason } });
}

export function registerProvenance(server: McpServer, db: Database.Database, settings?: SettingsService): void {
  const service = new ProvenanceService(db, () => settings ? readProvenanceLimits(settings.engine()) : DEFAULT_PROVENANCE_LIMITS);
  server.tool('inspect-provenance', 'Inspect captured direct dependencies and retained input bytes. Metadata responses omit payload text. Retained inputs do not guarantee deterministic model replay.', {
    select: z.enum(['input_text', 'status', 'attempt', 'output', 'node', 'text', 'purge_receipts', 'refresh_target']),
    input_id: z.string().max(512).optional(),
    attempt_key: z.string().uuid().optional(), flow: z.enum(['project-home-v1', 'project-subpage-v1']).optional(), output_revision_id: z.string().max(512).optional(),
    node_id: z.string().max(512).optional(), payload_id: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(4096).optional(),
    include_comparisons: z.boolean().optional(),
    max_bytes: z.number().int().min(4).max(65536).optional(),
  }, async input => {
    try { return ok(inspectProvenance(db, input as InspectRequest, service.limits())); } catch (error) { return provenanceFailure(error); }
  });
  server.tool('find-affected-outputs', 'Find committed outputs with potentially changed direct inputs. A changed source does not prove an output false; dependency is not verified claim support.', impactSchema.shape, async input => {
    try { return ok(findAffectedOutputs(db, input)); } catch (error) { return provenanceFailure(error); }
  });
  server.tool('purge-provenance', 'Preview or deliberately purge complete composite input/output bundles. Removes retained provenance only, not current vault notes. Does not erase backups or physical storage.', purgeSchema.shape, async input => {
    try {
      if (input.dry_run) return ok(previewProvenancePurge(db, input.scope));
      if (!input.confirm || !input.scope_token) return fail('CONFIRMATION_REQUIRED', 'Confirm the reviewed provenance purge scope token.');
      return ok(commitProvenancePurge(db, { scope: input.scope, scope_token: input.scope_token, confirm: true }));
    } catch (error) { return provenanceFailure(error); }
  });
  server.tool('provenance-prepare', 'Validate and capture one bounded project home or subpage input bundle before model dispatch. Dry-run validates without retaining inputs.', prepareSchema.shape, async input => {
    try { return ok(service.prepare(input as PrepareRequest)); } catch (error) { return provenanceFailure(error); }
  });
  server.tool('provenance-stage-result', 'Stage one validated project contribution against its captured inputs. Does not publish wiki content.', stageSchema.shape, async input => {
    try { return ok(service.stage(input)); } catch (error) { return provenanceFailure(error); }
  });
  server.tool('provenance-transition', 'Record dispatch, fail, abandon or renew an active capture. Cannot commit outputs or revive unavailable captures.', transitionSchema.shape, async input => {
    try { return ok(service.transition(input)); } catch (error) { return provenanceFailure(error); }
  });
}
