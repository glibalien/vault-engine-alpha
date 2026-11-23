import { z } from 'zod';
const id = z.string().min(1).max(512);
export const homeRefreshGuardSchema = z.object({
  version: z.literal(1), vault_namespace: id, project_id: id, home_node_id: id, output_revision_id: id,
  home_version: z.number().int().nonnegative(), topology_hash: id, configuration_digest: id, corrections_digest: id,
  page_node_id: id.optional(), page_version: z.number().int().nonnegative().optional(),
}).strict();
export const homeRefreshRequestSchema = z.object({
  request_id: z.string().uuid(), confirm_paid: z.literal(true), guard: homeRefreshGuardSchema,
}).strict();
