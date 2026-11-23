const RESERVED_AI_GUESS_FIELD_NAMES = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

export function supportsAiGuessing(fieldName: string): boolean {
  return !RESERVED_AI_GUESS_FIELD_NAMES.has(fieldName);
}
