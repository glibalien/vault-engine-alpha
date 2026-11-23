import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { ProvenanceService } from '../../src/provenance/service.js';
import { DEFAULT_PROVENANCE_LIMITS } from '../../src/provenance/limits.js';
import { observeNode } from '../../src/provenance/observations.js';
import type { PrepareRequest, PreparedReceipt, StageRequest } from '../../src/provenance/types.js';
import { bundleFixture } from './fixture.js';
import { deriveSubpageDecodedFields } from '../../src/provenance/subpage-validation.js';
import { inputDigest } from '../../src/provenance/validation.js';
import type { BundleV1 } from '../../src/provenance/types.js';

const dbs: ReturnType<typeof createTestDb>[] = [];
function fixture() {
  const db = createTestDb(); dbs.push(db);
  db.prepare("INSERT INTO nodes(id,file_path,title,body,content_hash) VALUES ('project','Project.md','Project','synthetic','h')").run();
  let date = new Date('2026-09-17T00:00:00Z');
  let limits = { ...DEFAULT_PROVENANCE_LIMITS };
  const service = new ProvenanceService(db, () => limits, () => date);
  const request: PrepareRequest = { attempt_key: randomUUID(), run_ref: randomUUID(), project_id: 'project', bundle: bundleFixture(), dry_run: false };
  return { db, service, request, clock: (hours: number) => { date = new Date(date.getTime() + hours * 3600000); }, limits: (next: typeof limits) => { limits = next; } };
}
function stageRequest(receipt: PreparedReceipt): StageRequest {
  return { derivation_id: receipt.derivation_id, bundle_digest: receipt.bundle_digest!,
    validated_sections: { at_a_glance: 'Generated' },
    contribution: [{ name: 'At a glance', mode: 'replace', content: 'Generated' }],
    generated_at: '2026-09-17T00:00:00Z', log_stamp: '2026-09-17' };
}
afterEach(() => dbs.splice(0).forEach(db => db.close()));
describe('provenance attempt lifecycle', () => {
  it('prepares idempotently and rejects altered content under the same opaque key', () => {
    const { service, request, limits } = fixture();
    const first = service.prepare(request) as PreparedReceipt;
    expect(service.prepare(request)).toEqual(first);
    limits({ ...DEFAULT_PROVENANCE_LIMITS, componentBytes: 1 });
    expect(service.prepare(request)).toEqual(first);
    expect(() => service.prepare({ ...request, bundle: bundleFixture('different') })).toThrow('PROVENANCE_KEY_CONFLICT');
    expect(service.lookupAttempt(request.attempt_key)?.derivation_id).toBe(first.derivation_id);
  });
  it('previews without IDs, writes or reservations and revalidates a later prepare', () => {
    const { db, service, request } = fixture();
    request.bundle.items[0]!.observation = observeNode(db, 'project');
    request.bundle.items[0]!.origin = 'identified';
    const preview = service.prepare({ ...request, dry_run: true });
    expect(preview).not.toHaveProperty('derivation_id');
    expect(db.prepare('SELECT COUNT(*) AS n FROM provenance_derivations').get()).toEqual({ n: 0 });
    db.prepare("UPDATE nodes SET version=2 WHERE id='project'").run();
    expect(() => service.prepare(request)).toThrow('PROVENANCE_OBSERVATION_CHANGED');
  });
  it('stages once, rejects changed output, and never commits through client transitions', () => {
    const { db, service, request } = fixture();
    const receipt = service.prepare(request) as PreparedReceipt;
    const staged = stageRequest(receipt);
    const binding = service.stage(staged);
    expect(service.stage(staged)).toEqual(binding);
    expect(() => service.stage({ ...staged, contribution: [{ name: 'Log', mode: 'append', content: 'Other' }] })).toThrow('PROVENANCE_KEY_CONFLICT');
    expect(service.transition({ derivation_id: receipt.derivation_id, action: 'fail', expected_state: 'result_staged' }).state).toBe('failed');
    expect(() => service.stage(staged)).toThrow('PROVENANCE_UNAVAILABLE');
    expect(db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get()).toEqual({ n: 0 });
  });
  it('rejects an output one byte beyond its configured bound without staging it', () => {
    const { service, request, limits, db } = fixture();
    const receipt = service.prepare(request) as PreparedReceipt; const staged = stageRequest(receipt);
    const bytes = Buffer.byteLength(JSON.stringify(staged.contribution));
    limits({ ...DEFAULT_PROVENANCE_LIMITS, outputBytes: bytes - 1 });
    expect(() => service.stage(staged)).toThrow('PROVENANCE_LIMIT');
    expect(db.prepare("SELECT COUNT(*) AS n FROM provenance_payloads WHERE kind='staged_result'").get()).toEqual({ n: 0 });
    limits({ ...DEFAULT_PROVENANCE_LIMITS, outputBytes: bytes });
    expect(service.stage(staged)).toHaveProperty('contribution_digest');
  });
  it('frees expired leases before reserving and never revives the expired attempt', () => {
    const { service, request, limits, clock, db } = fixture();
    limits({ ...DEFAULT_PROVENANCE_LIMITS, capacityBytes: DEFAULT_PROVENANCE_LIMITS.totalBytes + 4096 });
    const receipt = service.prepare(request) as PreparedReceipt;
    expect(() => service.prepare({ ...request, attempt_key: randomUUID() })).toThrow('PROVENANCE_CAPACITY');
    clock(25);
    expect(() => service.stage(stageRequest(receipt))).toThrow('PROVENANCE_LEASE_EXPIRED');
    expect(service.prepare({ ...request, attempt_key: randomUUID() })).toHaveProperty('derivation_id');
    expect(service.lookupAttempt(request.attempt_key)?.state).toBe('abandoned');
    expect(db.prepare('SELECT reserved_remaining_bytes FROM provenance_derivations WHERE id=?').get(receipt.derivation_id)).toEqual({ reserved_remaining_bytes: 0 });
  });
});

function subpageBundle(): BundleV1 {
  const user = JSON.stringify({ action: 'refresh', title: 'Decisions', kind: 'decision-log', scope: {},
    synthesis_brief: 'Write decisions', evidence: 'Decision α', sibling_scopes: [],
    current_target: { id: 'page-1', title: 'Decisions', body: 'Prior decision' } });
  const provider_payload = { model: 'test', max_tokens: 4000, messages: [
    { role: 'system', content: 'Page system with output schema' }, { role: 'user', content: user }],
  };
  const decoded_fields = deriveSubpageDecodedFields('openrouter', provider_payload);
  const spans = [{ field: 'evidence', start: 0, end: Buffer.byteLength('Decision α') }];
  return { version: 1, provider: 'openrouter', model: 'test', target: { node_id: 'page-1' },
    provider_payload, decoded_fields, items: [{ key: 'evidence', observation: null, role: 'generated_context',
      upstream_derivation_id: null, selection: 'evidence:v1', spans, original_bytes: null,
      retained_bytes: Buffer.byteLength('Decision α'), input_digest: inputDigest(spans, decoded_fields),
      truncated: false, origin: 'opaque' }], omissions: [], dependency_coverage: 'direct_with_opaque_components',
    transform: { assembly: 'project-subpage-evidence-v1', prompt: 'project-subpage-v1',
      schema: 'page-synthesis-v1', adapter: 'openai-compat-v1', output: 'managed-subpage-contribution-v1' } };
}

describe('subpage attempt lifecycle', () => {
  it('scopes attempt lookup by flow and stages only validated page content', () => {
    const { service, request } = fixture();
    const pageRequest = { ...request, flow: 'project-subpage-v1' as const, bundle: subpageBundle() };
    const page = service.prepare(pageRequest) as PreparedReceipt;
    expect(service.lookupAttempt(request.attempt_key, 'project-subpage-v1')?.derivation_id).toBe(page.derivation_id);
    expect(service.lookupAttempt(request.attempt_key)).toBeNull();
    const home = service.prepare(request) as PreparedReceipt;
    expect(home.derivation_id).not.toBe(page.derivation_id);
    expect(service.lookupAttempt(request.attempt_key)?.derivation_id).toBe(home.derivation_id);
    const stage = { derivation_id: page.derivation_id, bundle_digest: page.bundle_digest!,
      validated_sections: { body: 'Decision α' }, contribution: [{ name: 'Summary', mode: 'replace' as const, content: 'Decision α' }],
      generated_at: '2026-09-17T00:00:00Z', log_stamp: '2026-09-17' };
    expect(() => service.stage({ ...stage, validated_sections: { body: 'Different' } })).toThrow('PROVENANCE_LIMIT');
    expect(() => service.stage({ ...stage, contribution: [{ name: 'Summary', mode: 'append', content: 'Decision α' }] })).toThrow('PROVENANCE_LIMIT');
    expect(service.stage(stage)).toHaveProperty('contribution_digest');
  });
});
