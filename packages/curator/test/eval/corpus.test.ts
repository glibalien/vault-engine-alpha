import { describe, it, expect, onTestFinished } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCorpus, slug, writeFixture, readFixture } from '../../src/eval/corpus.js';
import { runSnapshot } from '../../src/eval.js';
import type { EvalFixture } from '../../src/eval/corpus.js';
import type { ProjectEvidence } from '../../src/types.js';
import type { Config } from '../../src/config.js';
import type { Engine } from '../../src/engine.js';
import type { LlmClient } from '../../src/llm/types.js';

// ---------------------------------------------------------------------------
// Minimal ProjectEvidence for fixture tests
// ---------------------------------------------------------------------------
function makeEvidence(): ProjectEvidence {
  return {
    project: { id: 'proj-1', title: 'Test Project', file_path: 'Test Project.md', status: 'active' },
    tasks: {
      overdue: [],
      blocked: [],
      open: [],
      upcoming: [],
      backlog: [],
      done_recent: [],
    },
    notes: [],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    existing_wiki: { home_id: null, subpages: [] },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    meetings: { recent: [], upcoming: [] },
    contacts: { people: [], companies: [] },
    evidence_hash: 'abc123',
    generated_at: '2026-06-17T00:00:00Z',
  };
}

function makeFixture(): EvalFixture {
  return {
    project: { id: 'proj-1', title: 'Test Project', file_path: 'Test Project.md', status: 'active' },
    evidence: makeEvidence(),
    readNodes: [],
    candidates: [],
  };
}

// ---------------------------------------------------------------------------
// loadCorpus
// ---------------------------------------------------------------------------
describe('loadCorpus', () => {
  it('parses a valid JSON array of corpus entries', () => {
    const dir = tmpdir();
    const path = join(dir, `corpus-valid-${Date.now()}.json`);
    onTestFinished(() => rmSync(path, { force: true }));
    const entries = [
      { title: 'Alpha Project', exercises: 'planning phase; many tasks' },
      { title: 'Beta Project', exercises: 'active dev; bugs outstanding' },
    ];
    writeFileSync(path, JSON.stringify(entries));

    const result = loadCorpus(path);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ title: 'Alpha Project', exercises: 'planning phase; many tasks' });
    expect(result[1]).toEqual({ title: 'Beta Project', exercises: 'active dev; bugs outstanding' });
  });

  it('throws when file contains a non-array', () => {
    const dir = tmpdir();
    const path = join(dir, `corpus-bad-${Date.now()}.json`);
    onTestFinished(() => rmSync(path, { force: true }));
    writeFileSync(path, JSON.stringify({ title: 'not an array' }));

    expect(() => loadCorpus(path)).toThrow();
  });

  it('throws when an entry is missing the title field', () => {
    const dir = tmpdir();
    const path = join(dir, `corpus-missing-title-${Date.now()}.json`);
    onTestFinished(() => rmSync(path, { force: true }));
    writeFileSync(path, JSON.stringify([{ exercises: 'no title here' }]));

    expect(() => loadCorpus(path)).toThrow();
  });

  it('throws when an entry is missing the exercises field', () => {
    const dir = tmpdir();
    const path = join(dir, `corpus-missing-ex-${Date.now()}.json`);
    onTestFinished(() => rmSync(path, { force: true }));
    writeFileSync(path, JSON.stringify([{ title: 'No Exercises' }]));

    expect(() => loadCorpus(path)).toThrow();
  });
});

describe('runSnapshot', () => {
  it('uses live active projects when the repository default corpus is not locally configured', async () => {
    const seen: string[] = [];
    const fixturesDir = mkdtempSync(join(tmpdir(), 'eval-default-corpus-'));
    const engine = {
      listActiveProjects: async () => [
        { id: 'contributor-project', title: 'Contributor Project', file_path: 'Contributor Project.md' },
      ],
      projectEvidence: async (title: string) => {
        seen.push(title);
        return {
          ...makeEvidence(),
          project: {
            id: 'contributor-project',
            title,
            file_path: 'Contributor Project.md',
            status: 'active',
          },
        };
      },
      getNode: async () => ({
        id: 'contributor-project',
        title: 'Contributor Project',
        file_path: 'Contributor Project.md',
        body: '',
        fields: {},
        relationships: { outgoing: {}, incoming: {} },
        types: ['project'],
      }),
    } as unknown as Engine;
    const config = {
      activeStatuses: ['active'],
      meetingReads: 0,
      noteReads: 0,
      projectHomeProvenanceEnabled: false,
      semanticGapFill: false,
    } as Config;
    const corpusPath = join(fixturesDir, 'missing-corpus.json');

    try {
      const paths = await runSnapshot(
        { engine, config, llm: {} as LlmClient },
        { corpusPath, fixturesDir },
      );

      expect(seen).toEqual(['Contributor Project']);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/contributor-project\.json$/);
    } finally {
      rmSync(fixturesDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------
describe('slug', () => {
  it("converts 'Foo / Bar (x)' to 'foo-bar-x'", () => {
    expect(slug('Foo / Bar (x)')).toBe('foo-bar-x');
  });

  it('lowercases the result', () => {
    expect(slug('Hello World')).toBe('hello-world');
  });

  it('collapses multiple separators into a single dash', () => {
    expect(slug('A  --  B')).toBe('a-b');
  });

  it('trims leading and trailing dashes', () => {
    expect(slug(' / leading and trailing / ')).toBe('leading-and-trailing');
  });
});

// ---------------------------------------------------------------------------
// writeFixture + readFixture round-trip
// ---------------------------------------------------------------------------
describe('writeFixture + readFixture', () => {
  it('round-trips an EvalFixture through a temp directory', () => {
    const dir = join(tmpdir(), `eval-fixture-${Date.now()}`);
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(dir, { recursive: true });

    const fixture = makeFixture();
    const writtenPath = writeFixture(dir, fixture);

    expect(writtenPath).toContain(dir);
    expect(writtenPath.endsWith('.json')).toBe(true);

    const loaded = readFixture(writtenPath);
    expect(loaded.project.id).toBe(fixture.project.id);
    expect(loaded.project.title).toBe(fixture.project.title);
    expect(loaded.evidence.evidence_hash).toBe(fixture.evidence.evidence_hash);
    expect(loaded.readNodes).toHaveLength(0);
    expect(loaded.candidates).toHaveLength(0);
  });

  it('creates the output directory if it does not exist', () => {
    const dir = join(tmpdir(), `eval-fixture-new-${Date.now()}`, 'nested');
    onTestFinished(() => rmSync(dirname(dir), { recursive: true, force: true }));
    const fixture = makeFixture();
    // should not throw even though dir doesn't exist yet
    const writtenPath = writeFixture(dir, fixture);
    const loaded = readFixture(writtenPath);
    expect(loaded.project.title).toBe(fixture.project.title);
  });
});
