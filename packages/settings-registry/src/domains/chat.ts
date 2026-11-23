import type { SettingDescriptor } from '../types.js';

export interface ChatSettings {
  defaultModel: string;
  titleModel: string;
  vizModel: string;
  maxSteps: number;
  contextBudget: number;
  responseReserve: number;
  chatSystemPrompt: string;
  chatTieringNote: string;
}

const int = (raw: string): unknown => { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : raw; };

export const CHAT_DESCRIPTORS: SettingDescriptor[] = [
  { key: 'defaultModel', domain: 'chat', type: { kind: 'model-ref' },
    default: '[[Qwen 3.7 Plus]]', reload: 'next-use',
    envSeed: { var: 'MODEL' },
    description: 'Model catalog reference ([[Model Note Title]]) used for web-chat turns. Resolved through Settings/Models/ — the per-conversation picker\'s default; each conversation may override via the model chip. Read at each turn (next message uses it).' },
  { key: 'titleModel', domain: 'chat', type: { kind: 'model-ref' },
    default: '[[GPT-OSS 120B]]', reload: 'next-use',
    envSeed: { var: 'TITLE_MODEL' },
    description: 'Model catalog reference ([[Model Note Title]]) used to generate conversation titles after the first exchange (both chat surfaces). Resolved through Settings/Models/ strictly — an unresolvable ref falls back to the mechanical first-message title, never to another model. Read at each titling call.' },
  { key: 'vizModel', domain: 'chat', type: { kind: 'model-ref' },
    default: '[[GPT-OSS 120B]]', reload: 'next-use',
    description: 'Model catalog reference ([[Model Note Title]]) used to interpret plain-language board-card requests into viz specs (board composer bar). Resolved through Settings/Models/ strictly — an unresolvable ref is a composer error, never a fallback to another model. Read at each interpretation.' },
  { key: 'maxSteps', domain: 'chat', type: { kind: 'int', min: 1 }, default: 10, reload: 'next-use',
    envSeed: { var: 'MAX_STEPS', parse: int },
    description: 'Agentic step cap per chat turn — tool-call rounds the model may take before it must answer.' },
  { key: 'contextBudget', domain: 'chat', type: { kind: 'int', min: 1 }, default: 32768, reload: 'next-use',
    envSeed: { var: 'CONTEXT_BUDGET', parse: int },
    description: 'Token budget for assembled conversation context. Reserved for the context assembler — parsed and served, not yet consumed by request handling.' },
  { key: 'responseReserve', domain: 'chat', type: { kind: 'int', min: 1 }, default: 4096, reload: 'next-use',
    envSeed: { var: 'RESPONSE_RESERVE', parse: int },
    description: 'Tokens held back from the context budget for the model response. Reserved for the context assembler — parsed and served, not yet consumed by request handling.' },
  { key: 'chatSystemPrompt', domain: 'chat', type: { kind: 'text' }, default: '', reload: 'next-use',
    description: 'Override for the vault-chat base system prompt. Leave blank to use the built-in prompt registered by the chat client.' },
  { key: 'chatTieringNote', domain: 'chat', type: { kind: 'text' }, default: '', reload: 'next-use',
    description: 'Override for the vault-chat tiering note appended by tiered chat hosts. Leave blank to use the built-in tiering note.' },
];
