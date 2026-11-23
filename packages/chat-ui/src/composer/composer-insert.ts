import type { ComposerTrigger } from './composer-trigger.js';

interface Edit {
  text: string;
  caret: number;
}

function replaceRange(text: string, from: number, to: number, insert: string): Edit {
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length };
}

/** `@` → insert a `[[Title]]` wikilink (the node is also added as a context chip by the caller). */
export function applyNodePick(text: string, t: ComposerTrigger, title: string): Edit {
  return replaceRange(text, t.from, t.to, `[[${title}]] `);
}
