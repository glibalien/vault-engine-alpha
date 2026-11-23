import type { ContextLines } from './semantic-context-render.js';

export const CONTEXT_TOKEN_BUDGET = 256;
export const HEADING_TRAIL_TOKEN_BUDGET = 64;

export function capContextLines(
  lines: ContextLines,
  tokenize: (text: string) => number,
  maxTokens: number = CONTEXT_TOKEN_BUDGET,
): string {
  if (maxTokens <= 0 || lines.lines.length === 0) return '';

  const required = lines.lines.slice(0, lines.requiredCount);
  const skeletons = required.map(line => {
    const colon = line.indexOf(':');
    return colon >= 0 ? line.slice(0, colon + 1) : line;
  });
  if (skeletons.length > 0 && tokenize(skeletons.join('\n')) > maxTokens) {
    return truncateToTokens(skeletons.join('\n'), tokenize, maxTokens);
  }

  const kept: string[] = [];
  for (let index = 0; index < required.length; index += 1) {
    const line = required[index];
    const skeleton = skeletons[index];
    if (line === undefined || skeleton === undefined) continue;
    const suffix = skeletons.slice(index + 1);
    kept.push(fitLineToBlock(line, kept, suffix, tokenize, maxTokens) ?? skeleton);
  }

  for (const line of lines.lines.slice(lines.requiredCount)) {
    if (tokenize([...kept, line].join('\n')) <= maxTokens) {
      kept.push(line);
      continue;
    }
    const truncated = fitLineToBlock(line, kept, [], tokenize, maxTokens);
    if (truncated !== null) kept.push(truncated);
    break;
  }
  return kept.join('\n');
}

function fitLineToBlock(
  line: string,
  prefix: readonly string[],
  suffix: readonly string[],
  tokenize: (text: string) => number,
  maxTokens: number,
): string | null {
  const fits = (candidate: string): boolean => tokenize([...prefix, candidate, ...suffix].join('\n')) <= maxTokens;
  if (fits(line)) return line;

  const colon = line.indexOf(':');
  const minimum = colon >= 0 ? line.slice(0, colon + 1) : '';
  if (!fits(minimum)) return null;

  let low = minimum.length;
  let high = line.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(line.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  return line.slice(0, low).trimEnd();
}

export function truncateToTokens(
  text: string,
  tokenize: (text: string) => number,
  maxTokens: number,
): string {
  if (maxTokens <= 0 || text.length === 0) return '';
  if (tokenize(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tokenize(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}
