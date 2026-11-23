import type { ContextProvider, ContextProviderInput, AssembledContext } from './types.js';

/** Run every registered provider (each self-gates), compose the contributed
 *  sections into one "## Working context" block + per-section token meta. A
 *  provider that throws is skipped — a bad provider never breaks the turn. */
export async function assembleContext(
  providers: ContextProvider[],
  input: ContextProviderInput,
): Promise<AssembledContext> {
  const blocks: string[] = [];
  const sections: { label: string; tokens: number }[] = [];
  for (const p of providers) {
    let section;
    try { section = await p.build(input); } catch { section = null; }
    if (!section) continue;
    blocks.push(section.text);
    sections.push({ label: section.label, tokens: section.tokens });
  }
  if (!blocks.length) return { text: '', sections: [] };
  return { text: `## Working context\n${blocks.join('\n\n')}`, sections };
}
