import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/system-prompt.js';

describe('SYSTEM_PROMPT', () => {
  it('no longer documents a >tool directive (moved to the board composer)', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/>toolname/);
    expect(SYSTEM_PROMPT).not.toContain('User directives');
  });

  it('mentions curator tools and steers curate-project-wiki to one project', () => {
    expect(SYSTEM_PROMPT).toContain('curator-status');
    expect(SYSTEM_PROMPT).toContain('curate-project-wiki');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('single project');
  });

  it('says how to rebuild one wiki page or a whole wiki, on request (#372)', () => {
    for (const name of ['inspect-provenance', 'preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'])
      expect(SYSTEM_PROMPT).toContain(name);
    expect(SYSTEM_PROMPT).toContain('force:true');
    expect(SYSTEM_PROMPT).toContain('confirm_paid:true');
    for (const retired of ['preview-home-refresh', 'refresh-project-home', 'home-refresh-status'])
      expect(SYSTEM_PROMPT).not.toContain(retired);
  });

  it('says a topic wiki is rebuilt whole by name, and how to find the name from one of its pages (#425)', () => {
    expect(SYSTEM_PROMPT).toMatch(/topic wiki is rebuilt the same way, by its name, and only whole/);
    expect(SYSTEM_PROMPT).toContain('relationships.outgoing.wiki_for');
    expect(SYSTEM_PROMPT).toMatch(/kind\s+"topic"/);
    expect(SYSTEM_PROMPT).toContain('A paused wiki stays paused');
  });

  it('says how to make a topic wiki from a note: propose, confirm, then create (#387)', () => {
    expect(SYSTEM_PROMPT).toContain('propose-topic-wiki');
    expect(SYSTEM_PROMPT).toContain('next.create');
    expect(SYSTEM_PROMPT).toContain('next.add_source');
    expect(SYSTEM_PROMPT).toMatch(/accept or edit/);
    expect(SYSTEM_PROMPT).toMatch(/queues the build and replies at once/);
  });

  it('explains topic wiki source_node_ids update semantics', () => {
    expect(SYSTEM_PROMPT).toContain('source_node_ids');
    expect(SYSTEM_PROMPT).toMatch(/stable input evidence anchors/i);
    expect(SYSTEM_PROMPT).toMatch(/distinct from requested output pages\s+and pinning/i);
    expect(SYSTEM_PROMPT).toMatch(/omitting[^.]+preserves/i);
    expect(SYSTEM_PROMPT).toMatch(/empty\s+list clears/i);
    expect(SYSTEM_PROMPT).toMatch(/replacement[^.]+forces curation/i);
    expect(SYSTEM_PROMPT).toMatch(/IDs already returned\s+by vault tools/i);
  });

  describe('memory tools section (Memories v3 P2)', () => {
    it('teaches expire-memory, soft delete, versioned updates, and the server-stamped evidence rule', () => {
      expect(SYSTEM_PROMPT).toContain('expire-memory');
      expect(SYSTEM_PROMPT).toMatch(/never supply an "evidence" argument/);
      expect(SYSTEM_PROMPT).toMatch(/purge:true \+ confirm:true/);
      expect(SYSTEM_PROMPT).toMatch(/NEW memory \(new id\)/);
    });
  });
});
