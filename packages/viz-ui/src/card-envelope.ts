/** Envelope reader for the non-query cards (rowsFromCallResult is query-shaped). */
export interface CardEnvelope {
  ok: boolean; data?: unknown; error?: { message?: string };
  warnings?: Array<{ code?: string; message?: string }>;
}
export function readCardEnvelope(result: { content?: Array<{ type: string; text?: string }> }): CardEnvelope {
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') return { ok: false, error: { message: 'empty tool result' } };
  try { return JSON.parse(text) as CardEnvelope; }
  catch { return { ok: false, error: { message: 'non-JSON tool result' } }; }
}
