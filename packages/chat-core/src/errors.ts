const MAX_REASON_CHARS = 500;

/** Text for a failed chat turn, as a host's error banner shows it.
 *
 *  Thrown errors keep their own `name: message`. For HTTP failures the OpenRouter
 *  provider already puts the upstream reason in the message ("[Alibaba] The
 *  content field is a required field."). An error OpenRouter reports inside the
 *  stream instead reaches the host as a plain object, `{ message, code, metadata:
 *  { raw, provider_name } }`, whose `message` is only the wrapper text ("Provider
 *  returned error") and which `String()` turns into "[object Object]". For that
 *  object, read the upstream reason from `metadata.raw`. Only `message`, `code`,
 *  `metadata.raw` and `metadata.provider_name` are read. */
export function chatErrorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return providerErrorText(err) ?? String(err);
}

function providerErrorText(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { message?: unknown; code?: unknown; metadata?: { raw?: unknown; provider_name?: unknown } | null };
  if (typeof e.message !== 'string') return undefined;
  const upstream = upstreamReason(e.metadata?.raw);
  const reason = upstream !== undefined && upstream !== e.message ? upstream : e.message;
  const provider = typeof e.metadata?.provider_name === 'string' && e.metadata.provider_name !== ''
    ? `[${e.metadata.provider_name}] ` : '';
  const code = typeof e.code === 'number' || (typeof e.code === 'string' && e.code !== '') ? ` ${e.code}` : '';
  return `Provider error${code}: ${provider}${capped(reason)}`;
}

/** The provider's own message inside `metadata.raw`, which is usually its JSON
 *  error body (as a string or already parsed) and sometimes plain text. */
function upstreamReason(raw: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return upstreamReason(parsed, depth + 1) ?? raw;
    } catch { /* plain text */ }
    return raw;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'details', 'msg']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'object' && value !== null) {
      const nested = upstreamReason(value, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function capped(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS)}…` : flat;
}
