import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { ensureWikiSchema, getWikiBootstrapPlan } from '../../src/wiki/bootstrap.js';
import { getWikiConfig } from '../../src/wiki/config.js';
import { getStoredSettings } from '../../src/settings/store.js';
import { SettingsService } from '../../src/settings/service.js';
import { getSchemaDefinition } from '../../src/schema/crud.js';
import { checkTypesHaveSchemas } from '../../src/pipeline/check-types.js';

const RECONCILIATION_WIKI_FIELDS = ['wiki_kind', 'wiki_origin', 'wiki_scope', 'wiki_replaced_by', 'wiki_pinned', 'wiki_topology_hash', 'wiki_reconcile_key'];
// In claim order: the five legacy fields with wiki_status (#547) after the evidence hash.
const ALL_WIKI_FIELDS = ['wiki_for', 'wiki_parent', 'wiki_evidence_hash', 'wiki_status', 'wiki_curated_at', 'wiki_state', ...RECONCILIATION_WIKI_FIELDS];

describe('wiki config', () => {
  it('merges registry defaults with the stored wiki settings and vault map', () => {
    const db = createTestDb();
    expect(getWikiConfig(db).wikiType).toBe('wiki');
    expect(getWikiConfig(db).liveTaskGroupCap).toBe(8);
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const result = service.applyPatch('wiki', {
      wikiDir: 'Project Wikis',
      statusDone: ['closed'],
      statusIgnored: ['dropped', 'someday'],
      statusBacklog: ['backlog'],
      liveTaskGroupCap: 4,
      liveRelatedCap: 6,
      renderRelatedLive: false,
    });
    expect(result.issues).toEqual([]);
    const config = getWikiConfig(db);
    expect(config.wikiDir).toBe('Project Wikis');
    expect(config.taskDoneStatuses).toEqual(['closed']);
    expect(config.taskIgnoredStatuses).toEqual(['dropped', 'someday']);
    expect(config.renderRelatedLive).toBe(false);
    // statusBacklog: ['backlog'] equals the registry default, so the
    // deviations-only store drops it; it still reads as the default.
    expect(getStoredSettings(db, 'wiki')).toEqual({ liveTaskGroupCap: 4, liveRelatedCap: 6, renderRelatedLive: false });
    expect(config.taskBacklogStatuses).toEqual(['backlog']);
    expect(service.applyPatch('wiki', { bad: true }).issues[0]?.code).toBe('SETTINGS_UNKNOWN_KEY');
  });
});

describe('ensureWikiSchema', () => {
  it('creates every wiki field and claim idempotently on a fresh database', () => {
    // Given: a database without wiki bootstrap state.
    const db = createTestDb();

    // When: the plan and bootstrap run twice.
    const plan = getWikiBootstrapPlan(db, getWikiConfig(db));
    const first = ensureWikiSchema(db, getWikiConfig(db));
    const second = ensureWikiSchema(db, getWikiConfig(db));

    // Then: all fields and claims are created once with reconciliation metadata.
    expect(plan.created_global_fields).toEqual(ALL_WIKI_FIELDS);
    expect(plan.created_schemas).toEqual(['wiki']);
    expect(plan.added_schema_claims).toEqual(ALL_WIKI_FIELDS);
    expect(first.created_global_fields).toEqual(ALL_WIKI_FIELDS);
    expect(first.created_schemas).toEqual(['wiki']);
    expect(first.added_schema_claims).toEqual(ALL_WIKI_FIELDS);
    expect(second.created_global_fields).toEqual([]);
    expect(second.created_schemas).toEqual([]);
    expect(second.added_schema_claims).toEqual([]);
    expect(getSchemaDefinition(db, 'wiki')).not.toBeNull();
    expect(checkTypesHaveSchemas(db, ['wiki']).valid).toBe(true);
    expect(db.prepare(`SELECT field, sort_order FROM schema_field_claims WHERE schema_name = 'wiki' ORDER BY sort_order`).all()).toEqual([
      { field: 'wiki_for', sort_order: 100 },
      { field: 'wiki_parent', sort_order: 110 },
      { field: 'wiki_evidence_hash', sort_order: 120 },
      { field: 'wiki_status', sort_order: 125 },
      { field: 'wiki_curated_at', sort_order: 130 },
      { field: 'wiki_state', sort_order: 140 },
      { field: 'wiki_kind', sort_order: 150 },
      { field: 'wiki_origin', sort_order: 160 },
      { field: 'wiki_scope', sort_order: 170 },
      { field: 'wiki_replaced_by', sort_order: 180 },
      { field: 'wiki_pinned', sort_order: 190 },
      { field: 'wiki_topology_hash', sort_order: 200 },
      { field: 'wiki_reconcile_key', sort_order: 210 },
    ]);
    expect(db.prepare(`SELECT name, field_type, enum_values, reference_target FROM global_fields WHERE name IN (${RECONCILIATION_WIKI_FIELDS.map(() => '?').join(', ')}) ORDER BY name`).all(...[...RECONCILIATION_WIKI_FIELDS].sort())).toEqual([
      { name: 'wiki_kind', field_type: 'enum', enum_values: JSON.stringify(['workstream', 'decision-log', 'risk-register', 'timeline', 'stakeholder-map', 'spotlight', 'freeform']), reference_target: null },
      { name: 'wiki_origin', field_type: 'enum', enum_values: JSON.stringify(['automatic', 'requested']), reference_target: null },
      { name: 'wiki_pinned', field_type: 'boolean', enum_values: null, reference_target: null },
      { name: 'wiki_reconcile_key', field_type: 'string', enum_values: null, reference_target: null },
      { name: 'wiki_replaced_by', field_type: 'reference', enum_values: null, reference_target: 'wiki' },
      { name: 'wiki_scope', field_type: 'string', enum_values: null, reference_target: null },
      { name: 'wiki_topology_hash', field_type: 'string', enum_values: null, reference_target: null },
    ]);
  });

  it('adds only missing reconciliation claims while preserving owner claims and existing fields', () => {
    // Given: a legacy five-claim schema with an owner-defined claim.
    const db = createTestDb();
    const config = getWikiConfig(db);
    ensureWikiSchema(db, config);
    db.prepare(`DELETE FROM schema_field_claims WHERE schema_name = 'wiki' AND field IN (${RECONCILIATION_WIKI_FIELDS.map(() => '?').join(', ')})`).run(...RECONCILIATION_WIKI_FIELDS);
    db.prepare(`DELETE FROM global_fields WHERE name IN (${RECONCILIATION_WIKI_FIELDS.map(() => '?').join(', ')})`).run(...RECONCILIATION_WIKI_FIELDS);
    db.prepare(`INSERT INTO global_fields (name, field_type, ai_guessable, overrides_allowed_ai_guessable) VALUES ('owner_note', 'string', 1, 0)`).run();
    db.prepare(`INSERT INTO schema_field_claims (schema_name, field, label, description, sort_order, ai_guessable_override) VALUES ('wiki', 'owner_note', 'Owner label', 'Owner description', 999, 1)`).run();

    // When: bootstrap plans and upgrades the production-style schema.
    const plan = getWikiBootstrapPlan(db, config);
    const result = ensureWikiSchema(db, config);

    // Then: only reconciliation fields and claims are added; owner metadata remains exact.
    expect(plan.created_global_fields).toEqual(RECONCILIATION_WIKI_FIELDS);
    expect(plan.created_schemas).toEqual([]);
    expect(plan.added_schema_claims).toEqual(RECONCILIATION_WIKI_FIELDS);
    expect(result.created_global_fields).toEqual(RECONCILIATION_WIKI_FIELDS);
    expect(result.created_schemas).toEqual([]);
    expect(result.added_schema_claims).toEqual(RECONCILIATION_WIKI_FIELDS);
    expect(db.prepare(`SELECT label, description, sort_order, ai_guessable_override FROM schema_field_claims WHERE schema_name = 'wiki' AND field = 'owner_note'`).get()).toEqual({
      label: 'Owner label',
      description: 'Owner description',
      sort_order: 999,
      ai_guessable_override: 1,
    });
    expect(db.prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'wiki' ORDER BY sort_order`).all()).toEqual(ALL_WIKI_FIELDS.map(field => ({ field })).concat([{ field: 'owner_note' }]));
  });

  it('adds only a missing claim when its global field already exists', () => {
    // Given: an upgraded schema missing only the wiki_scope claim.
    const db = createTestDb();
    const config = getWikiConfig(db);
    ensureWikiSchema(db, config);
    db.prepare(`DELETE FROM schema_field_claims WHERE schema_name = 'wiki' AND field = 'wiki_scope'`).run();

    // When: the plan and mutation execute.
    const plan = getWikiBootstrapPlan(db, config);
    const result = ensureWikiSchema(db, config);

    // Then: the existing global field is preserved and only its claim is restored.
    expect(plan.created_global_fields).toEqual([]);
    expect(plan.added_schema_claims).toEqual(['wiki_scope']);
    expect(result.created_global_fields).toEqual([]);
    expect(result.added_schema_claims).toEqual(['wiki_scope']);
  });
});
