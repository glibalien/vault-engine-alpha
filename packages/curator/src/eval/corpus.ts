import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectRef, ProjectEvidence, GapFillCandidate, EngineNode } from '../types.js';
import type { Engine } from '../engine.js';
import type { Config } from '../config.js';
import { gatherHomeReads, gatherGapFillCandidates } from '../curate.js';

export interface CorpusEntry {
  title: string;
  exercises: string;
}

export interface EvalFixture {
  project: ProjectRef;
  evidence: ProjectEvidence;
  readNodes: Array<EngineNode & { reason?: string }>;
  candidates: GapFillCandidate[];
}

/** Parse and validate a corpus JSON file. Throws on malformed input. */
export function loadCorpus(jsonPath: string): CorpusEntry[] {
  const raw = readFileSync(jsonPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`loadCorpus: failed to parse JSON at ${jsonPath}: ${String(e)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`loadCorpus: expected a JSON array at ${jsonPath}, got ${typeof parsed}`);
  }

  return parsed.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`loadCorpus: entry[${i}] is not an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.title !== 'string') {
      throw new Error(`loadCorpus: entry[${i}] missing string "title"`);
    }
    if (typeof obj.exercises !== 'string') {
      throw new Error(`loadCorpus: entry[${i}] missing string "exercises"`);
    }
    return { title: obj.title, exercises: obj.exercises };
  });
}

/** Safe filename slug: lowercase, non-alnum→'-', collapse runs, trim '-'. */
export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Snapshot one project from a live Engine into an EvalFixture. */
export async function snapshotProject(engine: Engine, config: Config, title: string): Promise<EvalFixture> {
  const evidence = await engine.projectEvidence(title);
  const readNodes = await gatherHomeReads(engine, evidence, config);
  const project: ProjectRef = {
    id: evidence.project.id,
    title: evidence.project.title,
    file_path: evidence.project.file_path,
    status: evidence.project.status,
  };
  const candidates = await gatherGapFillCandidates(engine, config, project, evidence);
  return { project, evidence, readNodes, candidates };
}

/** Write a fixture to <dir>/<slug(project.title)>.json, creating dir if needed. Returns the written path. */
export function writeFixture(dir: string, fixture: EvalFixture): string {
  mkdirSync(dir, { recursive: true });
  const filename = `${slug(fixture.project.title)}.json`;
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(fixture, null, 2), 'utf-8');
  return path;
}

/** Read and parse an EvalFixture from a JSON file. */
export function readFixture(path: string): EvalFixture {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as EvalFixture;
}
