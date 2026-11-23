import { toolKind } from './tools-readwrite.js';

// Turn classes rank the "shape" of a recorded chat turn's tool calls, used
// to sort replayed turns into buckets for per-kind model comparison.
export type TurnClass = 'trivial' | 'single-write' | 'single-read' | 'complex' | 'multi-read';

// First match wins; 'complex' is checked before 'multi-read' so a turn with
// 2-4 calls that includes a write is 'complex', not 'multi-read' — the
// overlap case that forced this cascade's ordering.
export function classifyTurn(toolNames: string[]): TurnClass {
  const kinds = toolNames.map(toolKind);
  const writes = kinds.filter((k) => k === 'write-dry-runnable' || k === 'write-unvalidatable').length;
  const n = toolNames.length;
  if (n === 0) return 'trivial';
  if (n === 1 && writes === 1) return 'single-write';
  if (n === 1) return 'single-read';
  if (n >= 5 || writes > 0) return 'complex';
  return 'multi-read';
}
