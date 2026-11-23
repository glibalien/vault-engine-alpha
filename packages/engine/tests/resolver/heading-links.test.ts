// A link to a heading or block in a note (`[[Project Alpha#Goals]]`, `[[Project Alpha#^key]]`)
// names that note, as Obsidian reads it (#613). Before, the Engine looked the whole text up and
// left such a link unresolved, so the note missed it from its links in and a rename dropped it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { anchoredLinkName, linkAnchor, resolveTarget, ResolutionLookup } from '../../src/resolver/resolve.js';
import { anchorNamingKeys, candidateKeysForNode } from '../../src/resolver/candidate-keys.js';
import { buildReferenceCatalog, resolveRelationship } from '../../src/resolver/relationship-policy.js';
import { backfillResolvedTargets, refreshOnCreate, refreshOnRename } from '../../src/resolver/refresh.js';
import { findFilenameUnresolvableLinks, LinkCanonicalizer, resolvesByFilename } from '../../src/resolver/file-link.js';
import { canonicalizeBodyLinks } from '../../src/pipeline/canonical-links.js';
import { readLinkCounts } from '../../src/mcp/link-counts.js';

let db: Database.Database;
let vaultPath: string;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-heading-links-'));
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

function setPolicy(version: 1 | 2) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', ?)").run(String(version));
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createSchemaDefinition(db, { name: 'project', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
}

function write(relPath: string, content: string) {
  mkdirSync(dirname(join(vaultPath, relPath)), { recursive: true });
  writeFileSync(join(vaultPath, relPath), content);
}

function read(relPath: string) {
  return readFileSync(join(vaultPath, relPath), 'utf8');
}

function nodeId(filePath: string) {
  return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string }).id;
}

async function updateNode(args: Record<string, unknown>) {
  let handler!: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
  const server = { tool: (_name: string, _description: string, _schema: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer;
  registerUpdateNode(server, db, writeLock, vaultPath);
  return JSON.parse((await handler(args, {})).content[0].text);
}

function edgesFrom(filePath: string) {
  return db.prepare('SELECT target, rel_type, resolved_target_id FROM relationships WHERE source_id = ? ORDER BY rel_type, target')
    .all(nodeId(filePath)) as Array<{ target: string; rel_type: string; resolved_target_id: string | null }>;
}

describe('reading an anchored target', () => {
  it('names the note before the first #, and keeps the anchor', () => {
    expect(anchoredLinkName('Project Alpha#Goals')).toBe('Project Alpha');
    expect(anchoredLinkName('Project Alpha#^key-point')).toBe('Project Alpha');
    expect(anchoredLinkName('Projects/Project Alpha#Goals#Budget')).toBe('Projects/Project Alpha');
    expect(linkAnchor('Project Alpha#Goals#Budget')).toBe('#Goals#Budget');
  });

  it('names no note for a plain target or a heading in the same note', () => {
    expect(anchoredLinkName('Project Alpha')).toBeNull();
    expect(anchoredLinkName('#Goals')).toBeNull();
    expect(linkAnchor('#Goals')).toBe('');
  });

  it('keeps an anchor only when the target names the note through the name before it', () => {
    const alpha = candidateKeysForNode({ file_path: 'Projects/Project Alpha.md', title: 'Project Alpha' });
    expect(anchorNamingKeys('Project Alpha#Goals', alpha)).toBe('#Goals');
    expect(anchorNamingKeys('project alpha#Goals', alpha)).toBe('#Goals');
    expect(anchorNamingKeys('Projects/Project Alpha#Goals', alpha)).toBe('#Goals');
    expect(anchorNamingKeys('Project Alpha', alpha)).toBe('');
    // A note whose own name holds a `#` is named whole.
    const sharp = candidateKeysForNode({ file_path: 'C# notes.md', title: 'C# notes' });
    expect(anchorNamingKeys('C# notes', sharp)).toBe('');
  });
});

describe('the resolvers', () => {
  beforeEach(() => {
    const insert = db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
    insert.run('a', 'Projects/Project Alpha.md', 'Project Alpha');
    insert.run('c', 'C.md', 'C');
    insert.run('s', 'C# notes.md', 'C# notes');
  });

  it('resolve a heading or block link to its note, by any tier', () => {
    for (const target of ['Project Alpha#Goals', 'Project Alpha#^key', 'project alpha#Goals', 'Projects/Project Alpha#Goals', 'Projects/Project Alpha.md#Goals']) {
      expect(resolveTarget(db, target)).toEqual({ id: 'a', title: 'Project Alpha' });
      expect(new ResolutionLookup(db).resolve(target)).toEqual({ id: 'a', title: 'Project Alpha' });
    }
  });

  it('match a name holding a # whole before reading it as an anchor', () => {
    expect(resolveTarget(db, 'C# notes')).toEqual({ id: 's', title: 'C# notes' });
    expect(new ResolutionLookup(db).resolve('C# notes')).toEqual({ id: 's', title: 'C# notes' });
  });

  it('leave a same-note heading and a missing note unresolved', () => {
    expect(resolveTarget(db, '#Goals')).toBeNull();
    expect(resolveTarget(db, 'Project Beta#Goals')).toBeNull();
    expect(new ResolutionLookup(db).resolve('#Goals')).toBeNull();
  });

  it('resolve a typed reference by its note name under policy 2, and keep the type rule', () => {
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('a', 'project')").run();
    const catalog = buildReferenceCatalog(db);
    const context = { origin: 'field' as const, field: 'project', requiredType: 'project' };
    expect(resolveRelationship(catalog, { rawTarget: 'Project Alpha#Goals', context }, 2))
      .toMatchObject({ status: 'resolved', targetId: 'a' });
    // C is not a project: the name before the # still decides, and it is the wrong type.
    expect(resolveRelationship(catalog, { rawTarget: 'C#Goals', context }, 2))
      .toMatchObject({ status: 'unresolved', reason: 'type_mismatch' });
  });
});

describe('binding links that were waiting for the note', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('src', 'Notes/Kickoff.md', 'Kickoff')").run();
    const link = db.prepare("INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES ('src', ?, 'wiki-link', 'body', NULL)");
    link.run('Project Alpha#Goals');
    link.run('#Goals');
  });
  const bound = () => (db.prepare("SELECT resolved_target_id AS id FROM relationships WHERE source_id = 'src' AND target = 'Project Alpha#Goals'").get() as { id: string | null }).id;
  const sameNote = () => (db.prepare("SELECT resolved_target_id AS id FROM relationships WHERE source_id = 'src' AND target = '#Goals'").get() as { id: string | null }).id;

  it('binds when the note is created', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'Projects/Project Alpha.md', 'Project Alpha')").run();
    refreshOnCreate(db, 'a');
    expect(bound()).toBe('a');
    expect(sameNote()).toBeNull();
  });

  it('binds when a note is renamed to that name', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'Projects/Project Draft.md', 'Project Draft')").run();
    expect(bound()).toBeNull();
    db.prepare("UPDATE nodes SET file_path = 'Projects/Project Alpha.md', title = 'Project Alpha' WHERE id = 'a'").run();
    refreshOnRename(db, 'a');
    expect(bound()).toBe('a');
  });

  it('binds links left unresolved before this change at the next startup backfill', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'Projects/Project Alpha.md', 'Project Alpha')").run();
    expect(bound()).toBeNull();
    expect(backfillResolvedTargets(db)).toMatchObject({ updated: 1 });
    expect(bound()).toBe('a');
    expect(sameNote()).toBeNull();
  });
});

describe('the filename check and link repair', () => {
  it('reads a heading link by its note name', () => {
    expect(resolvesByFilename('Project Alpha#Goals', 'Projects/Project Alpha.md')).toBe(true);
    expect(resolvesByFilename('Projects/Project Alpha#Goals', 'Projects/Project Alpha.md')).toBe(true);
    expect(resolvesByFilename('Project Beta#Goals', 'Projects/Project Alpha.md')).toBe(false);
  });

  it('does not report a heading link that resolves by filename', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'Projects/Project Alpha.md', 'Project Alpha'), ('src', 'Notes/Kickoff.md', 'Kickoff')").run();
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES ('src', 'Project Alpha#Goals', 'wiki-link', 'body', 'a')").run();
    expect(findFilenameUnresolvableLinks(db)).toEqual([]);
  });

  it('repairs a heading link written with a drifted title, keeping the anchor', () => {
    // The title holds a character its filename could not: only the Engine reads the link.
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('q', 'Plans/Q3- Plan.md', 'Q3: Plan')").run();
    const canonicalizer = new LinkCanonicalizer(db);
    expect(canonicalizeBodyLinks('See [[Q3: Plan#Goals]] and ![[Q3: Plan#Goals]].', canonicalizer))
      .toBe('See [[Q3- Plan#Goals|Q3: Plan#Goals]] and ![[Q3- Plan#Goals]].');
  });

  it('repairs a heading link to the vault path when the short name plus anchor names another note', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('q', 'Plans/Q3 Plan.md', 'Q3 Plan'), ('o', 'Other/Q3 Plan#Goals.md', 'Q3 Plan#Goals')").run();
    db.prepare(`INSERT INTO node_fields (node_id, field_name, value_json) VALUES ('q', 'aliases', '["Quarterly"]')`).run();
    const canonicalizer = new LinkCanonicalizer(db);
    expect(canonicalizeBodyLinks('See [[Quarterly#Goals]] and ![[Quarterly#Goals]].', canonicalizer))
      .toBe('See [[Plans/Q3 Plan.md#Goals|Quarterly#Goals]] and ![[Plans/Q3 Plan.md#Goals]].');
    expect(resolveTarget(db, 'Plans/Q3 Plan.md#Goals')).toEqual({ id: 'q', title: 'Q3 Plan' });
  });

  it('never reads a link to a note whose filename holds a # as a heading link', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('s', 'C# notes.md', 'C# notes'), ('o', 'Other.md', 'Other')").run();
    db.prepare(`INSERT INTO node_fields (node_id, field_name, value_json) VALUES ('o', 'aliases', '["C"]')`).run();
    const canonicalizer = new LinkCanonicalizer(db);
    expect(canonicalizer.namesAnyNote('C# notes')).toBe(true);
    expect(canonicalizeBodyLinks('See [[C# notes]].', canonicalizer)).toBe('See [[C# notes]].');
  });
});

describe.each([1, 2] as const)('reference policy %i, indexed from files', policy => {
  function seed() {
    setPolicy(policy);
    write('Projects/Project Alpha.md', '---\ntypes:\n  - project\n---\n# Goals\nShip it.\n');
    write('Notes/Kickoff.md', '---\ntypes:\n  - task\nproject: "[[Project Alpha#Goals]]"\nsee: "[[Projects/Project Alpha#^key]]"\n---\n'
      + 'Met about [[Project Alpha#Goals|the goals]]. Also [[#Agenda]].\n\n![[Project Alpha#Goals]]\n');
    fullIndex(vaultPath, db);
    return nodeId('Projects/Project Alpha.md');
  }

  it('binds body, embed, typed-field and unclaimed-field links to a heading or block', () => {
    const target = seed();
    expect(edgesFrom('Notes/Kickoff.md')).toEqual([
      { target: 'Project Alpha#Goals', rel_type: 'project', resolved_target_id: target },
      { target: 'Projects/Project Alpha#^key', rel_type: 'see', resolved_target_id: target },
      { target: '#Agenda', rel_type: 'wiki-link', resolved_target_id: null },
      { target: 'Project Alpha#Goals', rel_type: 'wiki-link', resolved_target_id: target },
    ]);
  });

  it('counts them as links in, not as unresolved links (#611)', () => {
    const target = seed();
    expect(readLinkCounts(db, [target]).get(target)).toEqual({ incoming: 1, outgoing: 0, unresolved: 0 });
    const source = nodeId('Notes/Kickoff.md');
    expect(readLinkCounts(db, [source]).get(source)).toEqual({ incoming: 0, outgoing: 1, unresolved: 0 });
  });

  it('a rename rewrites them to the new name and keeps every anchor', async () => {
    const target = seed();

    const result = await updateNode({ node_id: target, set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    expect(text).toContain('project: "[[Project Alpha Renamed#Goals]]"');
    expect(text).toContain('see: "[[Projects/Project Alpha Renamed#^key]]"');
    expect(text).toContain('Met about [[Project Alpha Renamed#Goals|the goals]]. Also [[#Agenda]].');
    expect(text).toContain('![[Project Alpha Renamed#Goals]]');
    expect(edgesFrom('Notes/Kickoff.md').filter(edge => edge.target !== '#Agenda').map(edge => edge.resolved_target_id))
      .toEqual([target, target, target]);
  });

  it('a move keeps a path-form link in the new folder, with its anchor', async () => {
    const target = seed();

    const result = await updateNode({ node_id: target, set_directory: 'Archive' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    expect(text).toContain('see: "[[Archive/Project Alpha#^key]]"');
    expect(text).toContain('Met about [[Project Alpha#Goals|the goals]].');
    expect(edgesFrom('Notes/Kickoff.md').filter(edge => edge.target !== '#Agenda').map(edge => edge.resolved_target_id))
      .toEqual([target, target, target]);
  });

  it('a rename leaves plain text that only looks like a heading link', async () => {
    const target = seed();
    write('Notes/Ticket.md', '---\ntypes:\n  - note\nlabel: "Project Alpha#123"\n---\nAbout [[Project Alpha]].\n');
    fullIndex(vaultPath, db);

    const result = await updateNode({ node_id: target, set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Ticket.md');
    expect(text).toContain('About [[Project Alpha Renamed]].');
    expect(text).toMatch(/label: "?Project Alpha#123"?/);
  });

  it('a rename rewrites a heading link written in another form of the name', async () => {
    const target = seed();
    write('Notes/Lower.md', '---\ntypes:\n  - note\nsee: "[[project alpha#Goals]]"\n---\nAlso [[project alpha#Goals]].\n');
    fullIndex(vaultPath, db);

    const result = await updateNode({ node_id: target, set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Lower.md');
    expect(text).toContain('see: "[[Project Alpha Renamed#Goals]]"');
    expect(text).toContain('Also [[Project Alpha Renamed#Goals]].');
    expect(edgesFrom('Notes/Lower.md').map(edge => edge.resolved_target_id)).toEqual([target, target]);
  });

  it('a rename to a name another note holds with the anchor writes the path, so links stay put', async () => {
    const target = seed();
    // Another project is literally named "Project Beta#Goals": `[[Project Beta#Goals]]` is its link.
    write('Projects/Project Beta#Goals.md', '---\ntypes:\n  - project\n---\nA different project.\n');
    fullIndex(vaultPath, db);
    const other = nodeId('Projects/Project Beta#Goals.md');

    const result = await updateNode({ node_id: target, set_title: 'Project Beta' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    expect(text).toContain('project: "[[Projects/Project Beta.md#Goals]]"');
    expect(text).toContain('Met about [[Projects/Project Beta.md#Goals|the goals]].');
    expect(text).toContain('![[Projects/Project Beta.md#Goals]]');
    const bound = edgesFrom('Notes/Kickoff.md').filter(edge => edge.target !== '#Agenda').map(edge => edge.resolved_target_id);
    expect(bound).toEqual([target, target, target]);
    expect(bound).not.toContain(other);
  });

  it('a rename of a note whose name holds a # rewrites its links whole', async () => {
    setPolicy(policy);
    write('C# notes.md', '---\ntypes:\n  - note\n---\nLanguage notes.\n');
    write('Notes/Reading.md', '---\ntypes:\n  - note\n---\nSee [[C# notes]].\n');
    fullIndex(vaultPath, db);
    const target = nodeId('C# notes.md');

    const result = await updateNode({ node_id: target, set_title: 'Dotnet notes' });

    expect(result.ok).toBe(true);
    expect(read('Notes/Reading.md')).toContain('See [[Dotnet notes]].');
  });
});
