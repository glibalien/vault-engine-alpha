export interface ConversationWriteReceipt {
  toolCallId: string;
  toolName: 'create-node' | 'update-node' | 'batch-mutate';
  destinationNodeId?: string;
  destinationTitle?: string;
  writtenText: string;
  mode: 'create' | 'set-body' | 'append-body';
}

export interface ConversationSource {
  url: string;
  toolCallId?: string;
  label?: string;
}

export interface ConversationInspection {
  turns: Array<{ messageId: string; role: 'user' | 'assistant'; text: string }>;
  assistantChars: number;
  userChars: number;
  writeReceipts: ConversationWriteReceipt[];
  sources: ConversationSource[];
  droppedParts: number;
  coverageReliable: boolean;
  diagnostics: string[];
}

type RecordValue = Record<string, unknown>;
type WriterKind = 'direct' | 'unsupported';

const CONTENT_WRITERS = new Map<string, WriterKind>([
  ['create-node', 'direct'],
  ['update-node', 'direct'],
  ['batch-mutate', 'direct'],
  ['wiki-write', 'unsupported'],
  ['request-wiki-page', 'unsupported'],
  ['create-or-update-wiki', 'unsupported'],
  ['curate-project-wiki', 'unsupported'],
  ['reconcile-wiki-pages', 'unsupported'],
]);

const RESEARCH_TOOLS = new Set(['web-search', 'fetch-url']);
const MAX_SOURCES = 50;
const MAX_SOURCE_LENGTH = 2_048;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): RecordValue | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function terminalSuccess(part: RecordValue): boolean {
  const output = asRecord(part.output);
  return part.state === 'output-available' && output?.ok === true;
}

function outputData(part: RecordValue): RecordValue | null {
  const output = asRecord(part.output);
  return asRecord(output?.data);
}

function toolCallIdOf(part: RecordValue): string | undefined {
  return asNonEmptyString(part.toolCallId);
}

function bodyMode(input: RecordValue): ConversationWriteReceipt['mode'] | null {
  const hasSetBody = Object.prototype.hasOwnProperty.call(input, 'set_body');
  const hasAppendBody = Object.prototype.hasOwnProperty.call(input, 'append_body');
  if (hasSetBody && hasAppendBody) return null;
  if (hasSetBody) return typeof input.set_body === 'string' ? 'set-body' : null;
  if (hasAppendBody) return typeof input.append_body === 'string' ? 'append-body' : null;
  return null;
}

function receiptText(input: RecordValue, mode: ConversationWriteReceipt['mode']): string {
  if (mode === 'create') return input.body as string;
  return (mode === 'set-body' ? input.set_body : input.append_body) as string;
}

function resultForPart(part: RecordValue, index: number, expectedOperation: 'create' | 'update'): RecordValue | null {
  const data = outputData(part);
  const results = Array.isArray(data?.results) ? data.results : [];
  const matches = results.filter((candidate) => isRecord(candidate) && candidate.op_index === index);
  if (matches.length !== 1) return null;
  const result = asRecord(matches[0]);
  return result?.status === 'applied' && result.op === expectedOperation ? result : null;
}

function directReceipts(part: RecordValue, diagnostics: string[]): ConversationWriteReceipt[] | null {
  if (!terminalSuccess(part)) return [];
  const input = asRecord(part.input);
  const toolName = asString(part.toolName);
  const toolCallId = toolCallIdOf(part);
  if (input === null || toolCallId === undefined || toolName === undefined) {
    diagnostics.push(`malformed ${toolName ?? 'registered'} content writer`);
    return null;
  }
  if (input.dry_run === true) return [];

  if (toolName === 'create-node') {
    if (Object.prototype.hasOwnProperty.call(input, 'body') && typeof input.body !== 'string') {
      diagnostics.push('malformed create-node content writer: body must be a string');
      return null;
    }
    if (typeof input.body !== 'string') return [];
    if (input.body.trim() === '') {
      diagnostics.push('malformed create-node content writer: body must not be empty');
      return null;
    }
    const data = outputData(part);
    const destinationNodeId = asNonEmptyString(data?.node_id);
    if (destinationNodeId === undefined) {
      diagnostics.push('malformed create-node content writer: successful write has no destination node id');
      return null;
    }
    const receipt: ConversationWriteReceipt = {
      toolCallId,
      toolName,
      destinationNodeId,
      ...(asString(input.title) ? { destinationTitle: input.title as string } : {}),
      writtenText: input.body,
      mode: 'create',
    };
    return [receipt];
  }

  if (toolName === 'update-node') {
    const hasSetBody = Object.prototype.hasOwnProperty.call(input, 'set_body');
    const hasAppendBody = Object.prototype.hasOwnProperty.call(input, 'append_body');
    if ((hasSetBody && typeof input.set_body !== 'string') || (hasAppendBody && typeof input.append_body !== 'string')) {
      diagnostics.push('malformed update-node content writer: body must be a string');
      return null;
    }
    const mode = bodyMode(input);
    if (mode === null) {
      if (hasSetBody && hasAppendBody) diagnostics.push('malformed update-node content writer: set_body and append_body are mutually exclusive');
      return hasSetBody || hasAppendBody ? null : [];
    }
    if (receiptText(input, mode).trim() === '') {
      diagnostics.push('malformed update-node content writer: body must not be empty');
      return null;
    }
    const data = outputData(part);
    const destinationNodeId = asNonEmptyString(input.node_id) ?? asNonEmptyString(data?.node_id);
    if (destinationNodeId === undefined) {
      diagnostics.push('malformed update-node content writer: successful write has no destination node id');
      return null;
    }
    const destinationTitle = asString(input.set_title) ?? asString(input.title) ?? asString(data?.title);
    return [{
      toolCallId,
      toolName,
      destinationNodeId,
      ...(destinationTitle ? { destinationTitle } : {}),
      writtenText: receiptText(input, mode),
      mode,
    }];
  }

  if (toolName === 'batch-mutate') {
    if (!Array.isArray(input.operations)) {
      diagnostics.push('malformed batch-mutate content writer: operations must be an array');
      return null;
    }
    const receipts: ConversationWriteReceipt[] = [];
    let malformed = false;
    for (let operationIndex = 0; operationIndex < input.operations.length; operationIndex += 1) {
      const operation = asRecord(input.operations[operationIndex]);
      if (operation === null) {
        diagnostics.push('malformed batch-mutate content writer: operation must be an object');
        malformed = true;
        continue;
      }
      const op = asString(operation.op);
      const params = asRecord(operation.params);
      if (op !== 'create' && op !== 'update' && op !== 'delete') {
        diagnostics.push(`malformed batch-mutate content writer: unsupported operation ${op ?? 'unknown'}`);
        malformed = true;
        continue;
      }
      if (params === null) {
        diagnostics.push('malformed batch-mutate content writer: operation params must be an object');
        malformed = true;
        continue;
      }
      if (op === 'create') {
        if (!Object.prototype.hasOwnProperty.call(params, 'body')) continue;
        if (typeof params.body !== 'string') {
          diagnostics.push('malformed batch-mutate content writer: create body must be a string');
          malformed = true;
          continue;
        }
        if (params.body.trim() === '') {
          diagnostics.push('malformed batch-mutate content writer: create body must not be empty');
          malformed = true;
          continue;
        }
        const result = resultForPart(part, operationIndex, 'create');
        if (result === null) {
          diagnostics.push(`malformed batch-mutate content writer: missing applied result for operation ${operationIndex}`);
          malformed = true;
          continue;
        }
        const nodeId = asNonEmptyString(result?.node_id);
        if (nodeId === undefined) {
          diagnostics.push(`malformed batch-mutate content writer: operation ${operationIndex} has no destination node id`);
          malformed = true;
          continue;
        }
        receipts.push({
          toolCallId,
          toolName,
          destinationNodeId: nodeId,
          ...(asString(params.title) ? { destinationTitle: params.title as string } : {}),
          writtenText: params.body,
          mode: 'create',
        });
      } else if (op === 'update') {
        const hasSetBody = Object.prototype.hasOwnProperty.call(params, 'set_body');
        const hasAppendBody = Object.prototype.hasOwnProperty.call(params, 'append_body');
        if (!hasSetBody && !hasAppendBody) continue;
        if ((hasSetBody && typeof params.set_body !== 'string') || (hasAppendBody && typeof params.append_body !== 'string') || (hasSetBody && hasAppendBody)) {
          diagnostics.push('malformed batch-mutate content writer: update body is invalid');
          malformed = true;
          continue;
        }
        const writtenText = (hasSetBody ? params.set_body : params.append_body) as string;
        if (writtenText.trim() === '') {
          diagnostics.push('malformed batch-mutate content writer: update body must not be empty');
          malformed = true;
          continue;
        }
        const mode = hasSetBody ? 'set-body' : 'append-body';
        const result = resultForPart(part, operationIndex, 'update');
        if (result === null) {
          diagnostics.push(`malformed batch-mutate content writer: missing applied result for operation ${operationIndex}`);
          malformed = true;
          continue;
        }
        const nodeId = asNonEmptyString(params.node_id) ?? asNonEmptyString(result?.node_id);
        if (nodeId === undefined) {
          diagnostics.push(`malformed batch-mutate content writer: operation ${operationIndex} has no destination node id`);
          malformed = true;
          continue;
        }
        const title = asString(params.set_title) ?? asString(params.title) ?? asString(result?.title);
        receipts.push({
          toolCallId,
          toolName,
          destinationNodeId: nodeId,
          ...(title ? { destinationTitle: title } : {}),
          writtenText,
          mode,
        });
      }
    }
    if (malformed) return null;
    return receipts;
  }

  return null;
}

function canonicalUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function sourceCandidatesFromText(text: string): Array<{ value: string; label?: string }> {
  const candidates: Array<{ value: string; label?: string }> = [];
  const markdown = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
  for (const match of text.matchAll(markdown)) {
    candidates.push({ value: match[2], ...(match[1] ? { label: match[1] } : {}) });
  }
  const bare = /https?:\/\/[^\s<>()[\]]+/gi;
  for (const match of text.matchAll(bare)) {
    candidates.push({ value: match[0].replace(/[.,;!?]+$/u, '') });
  }
  return candidates;
}

function sourceCandidatesFromValue(value: unknown): string[] {
  const candidates: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (['url', 'source_url', 'href', 'link'].includes(key) && typeof child === 'string') candidates.push(child);
      else visit(child);
    }
  };
  visit(value);
  return candidates;
}

function addSource(
  sources: Map<string, ConversationSource>,
  candidate: string,
  diagnostics: string[],
  details: { toolCallId?: string; label?: string } = {},
): void {
  const url = canonicalUrl(candidate);
  if (url === null) {
    diagnostics.push(`source URL parse failure: ${candidate}`);
    return;
  }
  if (url.length > MAX_SOURCE_LENGTH) {
    diagnostics.push(`source URL exceeds ${MAX_SOURCE_LENGTH} characters`);
    return;
  }
  const existing = sources.get(url);
  if (existing === undefined) {
    sources.set(url, { url, ...(details.toolCallId ? { toolCallId: details.toolCallId } : {}), ...(details.label ? { label: details.label } : {}) });
  } else {
    if (existing.toolCallId === undefined && details.toolCallId !== undefined) existing.toolCallId = details.toolCallId;
    if (existing.label === undefined && details.label !== undefined) existing.label = details.label;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Kept local so the inspection subpath remains import-light and does not need
// Node's ambient type declarations (or a runtime dependency on a hash package).
function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9) + 63) >>> 6) << 6;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(words[i - 15]!, 7) ^ rotr(words[i - 15]!, 18) ^ (words[i - 15]! >>> 3);
      const s1 = rotr(words[i - 2]!, 17) ^ rotr(words[i - 2]!, 19) ^ (words[i - 2]! >>> 10);
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3;
    let e = h4; let f = h5; let g = h6; let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[i]! + words[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function inspectConversation(messages: readonly unknown[]): ConversationInspection {
  const turns: ConversationInspection['turns'] = [];
  const writeReceipts: ConversationWriteReceipt[] = [];
  const sources = new Map<string, ConversationSource>();
  const diagnostics: string[] = [];
  let assistantChars = 0;
  let userChars = 0;
  let droppedParts = 0;
  let coverageReliable = true;

  // Evidence identifiers are validated before extracting anything so a later
  // duplicate invalidates every occurrence instead of leaving a misleading
  // first receipt/turn in the evidence set.
  const messageIdIndexes = new Map<string, number[]>();
  const invalidMessageIndexes = new Set<number>();
  const toolCallIdCounts = new Map<string, number>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = asRecord(messages[messageIndex]);
    if (message === null || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const messageId = asNonEmptyString(message.id);
    if (messageId === undefined) {
      coverageReliable = false;
      invalidMessageIndexes.add(messageIndex);
      diagnostics.push(`message ${messageIndex} has no non-empty id`);
    } else {
      const indexes = messageIdIndexes.get(messageId) ?? [];
      indexes.push(messageIndex);
      messageIdIndexes.set(messageId, indexes);
    }
    if (message.role !== 'assistant') continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const partValue of parts) {
      const part = asRecord(partValue);
      const toolName = part?.type === 'dynamic-tool' ? asString(part.toolName) : undefined;
      if (toolName === undefined || (!RESEARCH_TOOLS.has(toolName) && !CONTENT_WRITERS.has(toolName))) continue;
      const toolCallId = part ? toolCallIdOf(part) : undefined;
      if (toolCallId === undefined) {
        coverageReliable = false;
        diagnostics.push(`assistant evidence tool-call has no non-empty id: ${toolName}`);
      } else {
        toolCallIdCounts.set(toolCallId, (toolCallIdCounts.get(toolCallId) ?? 0) + 1);
      }
    }
  }
  for (const [messageId, indexes] of messageIdIndexes) {
    if (indexes.length < 2) continue;
    coverageReliable = false;
    indexes.forEach((index) => invalidMessageIndexes.add(index));
    diagnostics.push(`duplicate message evidence id: ${messageId}`);
  }
  const duplicateToolCallIds = new Set<string>();
  for (const [toolCallId, count] of toolCallIdCounts) {
    if (count < 2) continue;
    coverageReliable = false;
    duplicateToolCallIds.add(toolCallId);
    diagnostics.push(`duplicate assistant evidence tool-call id: ${toolCallId}`);
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = asRecord(messages[messageIndex]);
    if (message === null || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (invalidMessageIndexes.has(messageIndex)) continue;
    const chunks: string[] = [];
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const partValue of parts) {
      const part = asRecord(partValue);
      if (part?.type === 'text' && typeof part.text === 'string') {
        const text = part.text.trim();
        if (text !== '') chunks.push(text);
        else droppedParts += 1;
        if (message.role === 'assistant') {
          for (const candidate of sourceCandidatesFromText(text)) addSource(sources, candidate.value, diagnostics, { label: candidate.label });
        }
        continue;
      }
      droppedParts += 1;
      if (part === null) continue;
      const toolName = asString(part.toolName);
      if (message.role !== 'assistant' || part.type !== 'dynamic-tool' || toolName === undefined) continue;
      if (RESEARCH_TOOLS.has(toolName) || CONTENT_WRITERS.has(toolName)) {
        const toolCallId = toolCallIdOf(part);
        if (toolCallId === undefined || duplicateToolCallIds.has(toolCallId)) continue;
      }
      if (RESEARCH_TOOLS.has(toolName) && terminalSuccess(part)) {
        for (const candidate of sourceCandidatesFromValue(part.output)) {
          addSource(sources, candidate, diagnostics, { toolCallId: toolCallIdOf(part) });
        }
      }
      const writer = CONTENT_WRITERS.get(toolName);
      if (writer === 'unsupported') {
        coverageReliable = false;
        diagnostics.push(`unsupported content writer: ${toolName}`);
      } else if (writer === 'direct') {
        const receipts = directReceipts(part, diagnostics);
        if (receipts === null) coverageReliable = false;
        else writeReceipts.push(...receipts);
      }
    }
    if (chunks.length === 0) continue;
    const text = chunks.join('\n\n');
    const role = message.role;
    const messageId = asNonEmptyString(message.id)!;
    turns.push({ messageId, role, text });
    if (role === 'assistant') assistantChars += text.length;
    else userChars += text.length;
  }

  const sortedSources = [...sources.values()].sort((a, b) => lexicalCompare(a.url, b.url)).slice(0, MAX_SOURCES);
  if (sources.size > MAX_SOURCES) diagnostics.push(`source count exceeds ${MAX_SOURCES}; truncated`);
  return {
    turns,
    assistantChars,
    userChars,
    writeReceipts,
    sources: sortedSources,
    droppedParts,
    coverageReliable,
    diagnostics,
  };
}

export function conversationCaptureFingerprint(
  inspection: ConversationInspection,
  linkedDocs: readonly string[],
): string {
  const receipts = [...inspection.writeReceipts].sort((a, b) => lexicalCompare(canonicalJson(a), canonicalJson(b)));
  const sources = inspection.sources.map((source) => source.url).sort(lexicalCompare);
  const payload = {
    turns: inspection.turns,
    writeReceipts: receipts,
    sources,
    linkedDocs: [...linkedDocs].sort(lexicalCompare),
  };
  return sha256(canonicalJson(payload));
}
