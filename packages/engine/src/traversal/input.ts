import { z } from 'zod';
import type { ErrorCode } from '../mcp/tools/errors.js';
export const TRAVERSAL_LIMITS = {
  nodes: 500,
  edges: 2000,
  relationships: 10000,
  request_bytes: 16384,
  response_bytes: 1048576,
} as const;
export class TraversalError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function traversalCapacity(
  stage: 'nodes' | 'edges' | 'relationships' | 'response_bytes',
  observed: number,
): never {
  throw new TraversalError(
    'INVALID_PARAMS',
    'Traversal capacity exceeded; reduce depth or choose another root.',
    {
      reason: 'QUERY_LIMIT_EXCEEDED',
      stage,
      limit: TRAVERSAL_LIMITS[stage],
      observed_at_least: observed,
    },
  );
}
export const traversalRequestSchema = z
  .object({
    root_id: z.string().min(1).max(256),
    field: z.string().min(1).max(1024),
    direction: z.enum(['incoming', 'outgoing']),
    max_depth: z.number().int().min(1).max(8).default(4),
    include_fields: z
      .array(z.string().min(1).max(1024))
      .max(5)
      .refine(
        (v) => new Set(v).size === v.length,
        'Projection names must be unique',
      )
      .default([]),
  })
  .strict();
export function parseTraversalRequest(
  input: unknown,
): z.infer<typeof traversalRequestSchema> {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    /* Rejected below. */
  }
  if (
    json === undefined ||
    Buffer.byteLength(json, 'utf8') > TRAVERSAL_LIMITS.request_bytes
  )
    throw new TraversalError(
      'INVALID_PARAMS',
      'Traversal arguments exceed the byte limit or are not JSON.',
    );
  if (
    input &&
    typeof input === 'object' &&
    Object.keys(input).some(
      (k) => !Object.hasOwn(traversalRequestSchema.shape, k),
    )
  )
    throw new TraversalError('INVALID_PARAMS', 'Unknown traversal argument.');
  const parsed = traversalRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new TraversalError(
      'INVALID_PARAMS',
      'Invalid traversal request shape or limit.',
    );
  return parsed.data;
}
