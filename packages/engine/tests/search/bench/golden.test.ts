// packages/engine/tests/search/bench/golden.test.ts
import { describe, it, expect, onTestFinished } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { parse } from 'yaml';
import { createTestDb } from '../../helpers/db.js';
import { conceptualGoldenPath, generateKnownItem, loadConceptual } from '../../../src/search/bench/golden.js';

function insert(db: Database.Database, id: string, title: string, body = ''): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, body);
}

describe('generateKnownItem', () => {
  it('emits one rank-1 case per distinct title', () => {
    const db = createTestDb();
    insert(db, 'n1', 'Zora Wren');
    insert(db, 'n2', 'Quarterly Plan');
    const cases = generateKnownItem(db);
    const zora = cases.find((c) => c.query === 'Zora Wren');
    expect(zora).toBeDefined();
    expect(zora!.expectedIds).toEqual(['n1']);
    expect(zora!.topK).toBe(1);
    expect(zora!.kind).toBe('known-item');
    expect(cases).toHaveLength(2);
  });

  it('merges title collisions into one case accepting any in top-K', () => {
    const db = createTestDb();
    insert(db, 'n1', 'Meeting Notes');
    insert(db, 'n2', 'meeting notes'); // case-insensitive collision
    const cases = generateKnownItem(db);
    const collision = cases.filter((c) => c.query.toLowerCase() === 'meeting notes');
    expect(collision).toHaveLength(1);
    expect(collision[0].expectedIds.sort()).toEqual(['n1', 'n2']);
    expect(collision[0].topK).toBe(2);
    expect(collision[0].flags).toContain('collision');
  });

  it('flags ultra-short titles', () => {
    const db = createTestDb();
    insert(db, 'n1', 'AI');
    const cases = generateKnownItem(db);
    expect(cases[0].flags).toContain('short-title');
  });

  it('skips empty/whitespace titles', () => {
    const db = createTestDb();
    insert(db, 'n1', '   ');
    insert(db, 'n2', 'Real Title');
    const cases = generateKnownItem(db);
    expect(cases).toHaveLength(1);
    expect(cases[0].query).toBe('Real Title');
  });

  it('emits alias cases when aliasFields present', () => {
    const db = createTestDb();
    insert(db, 'n1', 'Zora Wren');
    db.prepare(
      "INSERT INTO node_fields (node_id, field_name, value_json) VALUES ('n1', 'aliases', ?)",
    ).run(JSON.stringify(['Z. Wren', 'Zo']));
    const cases = generateKnownItem(db, { aliasFields: ['aliases'] });
    const alias = cases.find((c) => c.query === 'Z. Wren');
    expect(alias).toBeDefined();
    expect(alias!.expectedIds).toEqual(['n1']);
    expect(alias!.flags).toContain('alias');
  });
});

describe('conceptualGoldenPath', () => {
  it('uses the local cases file when one sits beside the tracked file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-path-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    expect(conceptualGoldenPath(dir)).toBe(join(dir, 'golden-conceptual.yaml'));

    writeFileSync(join(dir, 'golden-conceptual.local.yaml'), 'cases: []\n');
    expect(conceptualGoldenPath(dir)).toBe(join(dir, 'golden-conceptual.local.yaml'));
  });
});

describe('loadConceptual', () => {
  it('preserves the conceptual benchmark group distribution', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturePath = resolve(here, '../../../bench/golden-conceptual.yaml');
    const fixture = parse(readFileSync(fixturePath, 'utf8')) as {
      readonly cases: readonly { readonly group?: string }[];
    };
    const groupCounts = Object.fromEntries(
      ['precision', 'attachment_noise', 'field_recall', 'topical', 'canonical'].map((group) => [
        group,
        fixture.cases.filter((entry) => entry.group === group).length,
      ]),
    );

    expect(groupCounts).toEqual({
      precision: 11,
      attachment_noise: 3,
      field_recall: 4,
      topical: 7,
      canonical: 3,
    });
  });

  it('throws before returning cases when any expected title is unresolved', () => {
    // Given
    const db = createTestDb();
    insert(db, 'n1', 'Deployment Incident 2026');
    const dir = mkdtempSync(join(tmpdir(), 'golden-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'conceptual.yaml');
    writeFileSync(
      path,
      'cases:\n' +
        '  - query: deployment incident\n' +
        '    expected_titles: [Deployment Incident 2026, Missing Note]\n' +
        '    note: prod outage writeup\n',
    );

    // When / Then
    expect(() => loadConceptual(db, path)).toThrowError(
      expect.objectContaining({
        name: 'UnresolvedConceptualTargetsError',
        targets: [{ query: 'deployment incident', title: 'Missing Note' }],
      }),
    );
  });

  it('carries the group tag from yaml', () => {
    const db = createTestDb();
    insert(db, 'n1', 'Mina Quorra');
    insert(db, 'n2', 'Northstar Coast Trip');
    insert(db, 'n3', 'Lina Sable');
    const dir = mkdtempSync(join(tmpdir(), 'golden-grp-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'conceptual.yaml');
    writeFileSync(
      path,
      'cases:\n' +
        '  - query: quorra\n' +
        '    expected_titles: [Mina Quorra]\n' +
        '    group: precision\n' +
        '  - query: planning a trip to northstar coast\n' +
        '    expected_titles: [Northstar Coast Trip]\n' +
        '    group: topical\n' +
        '  - query: lina\n' +
        '    expected_titles: [Lina Sable]\n' +
        '    group: attachment_noise\n',
    );
    const cases = loadConceptual(db, path);
    expect(cases.find((c) => c.query === 'quorra')?.group).toBe('precision');
    expect(cases.find((c) => c.query === 'planning a trip to northstar coast')?.group).toBe('topical');
    expect(cases.find((c) => c.query === 'lina')?.group).toBe('attachment_noise');
  });

  it('carries the field_recall group tag from yaml', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run('n1', '/n1.md', 'Weekly Sync', '');
    const dir = mkdtempSync(join(tmpdir(), 'golden-fr-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'conceptual.yaml');
    writeFileSync(
      path,
      'cases:\n' +
        '  - query: rowan vale\n' +
        '    expected_titles: [Weekly Sync]\n' +
        '    group: field_recall\n',
    );
    const cases = loadConceptual(db, path);
    expect(cases.find((c) => c.query === 'rowan vale')?.group).toBe('field_recall');
  });

  it('resolves a duplicated expected title to ALL sharing node ids', () => {
    const db = createTestDb();
    insert(db, 'n1', 'Skyline Global Security Discussion');
    insert(db, 'n2', 'Skyline Global Security Discussion');
    const dir = mkdtempSync(join(tmpdir(), 'golden-dup-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'conceptual.yaml');
    writeFileSync(
      path,
      'cases:\n' +
        '  - query: skyline security\n' +
        '    expected_titles: [Skyline Global Security Discussion]\n' +
        '    group: canonical\n',
    );
    const cases = loadConceptual(db, path);
    expect(cases).toHaveLength(1);
    expect(cases[0].expectedIds.sort()).toEqual(['n1', 'n2']);
  });
});
