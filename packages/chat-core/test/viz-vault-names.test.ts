import { describe, expect, it, vi } from 'vitest';
import { vaultSettingsFrom } from '@vault/settings-registry';
import {
  vizSpecRules, VIZ_SPEC_RULES, buildInterpretSystem, buildBoardPlanSystem, presentVizSchema, PRESENT_VIZ_SCHEMA,
  vizArgs, createPresentVizTool, DEFAULT_VAULT_NAMES, type VizVaultNames,
} from '../src/index.js';
import { interpretSchema } from '../src/viz-interpret.js';

/**
 * The viz prompts' examples come from the vault map (#449). With the map at its defaults, or read
 * from an Engine older than the map, every prompt and schema is the text from before the map.
 */

// The rules block as it was before the map (main at 9fa25d25).
const RULES_BEFORE_THE_MAP = `- kind: table (compare fields in columns), kanban (cards grouped by a field), list (simple checkbox view), calendar (month grid plotted by a date field). Default to table; use kanban when the request implies grouping, calendar when it centers on dates.
- title: short human label for the card header, e.g. 'tasks · status != done'.
- query: query-nodes arguments. types (array) scopes to node types; fields holds per-field operator filters ({"status":{"eq":"open"}} — operators: eq, ne, one_of, exists, contains, gt, gte, lt, lte, includes); query is free-text hybrid search — topical text ONLY, never a substitute for a field filter; also available: path_prefix, title_contains, sort_by (title|file_mtime|indexed_at), sort_order, limit.
- Dates are ISO YYYY-MM-DD strings; resolve relative phrases ("this week", "overdue") into gte/lte bounds using today's date below.
- display_fields: the 2-4 fields that matter for this view (8 max).
- group_by: the field rows are grouped by: a kanban's columns (kanban defaults to status), or a table's or list's sections, one per value (only when asked for; omit it for no sections). date_field: the calendar's date field — required for kind calendar. end_date_field: optional, for items that run from one date to another (a start and an end): the date field where each item ends; the item then shows on every day between.
- Filter only on fields the chosen type actually has (vocabulary below), and use exact enum spellings.`;

// The present-viz schema as it was before the map (main at 9fa25d25).
const SCHEMA_BEFORE_THE_MAP = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'query', 'display_fields'],
  properties: {
    kind: { type: 'string', enum: ['table', 'kanban', 'list', 'calendar'], description: 'How to render: table (sortable columns), kanban (grouped board), list (checkbox list), calendar (month grid by date field).' },
    title: { type: 'string', description: 'Short human query label shown on the card, e.g. \'tasks · project = "Vault Engine" · status != done\'.' },
    query: {
      type: 'object',
      additionalProperties: true,
      description: 'query-nodes arguments: types, fields (operator filters), query (hybrid search), path_prefix, path_dir, sort_by, sort_order, limit, offset, title_contains, title_eq, and other query-nodes args (join_filters, without_*, references, node_ids, modified_since, link_counts). A table that sorts or filters by a link count shows the Links in / Links out / Unresolved links columns.',
      properties: {
        types: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' },
        fields: { type: 'object' },
        path_prefix: { type: 'string' },
        path_dir: { type: 'string' },
        sort_by: { type: 'string', enum: ['title', 'file_mtime', 'indexed_at', 'inlink_count', 'outlink_count', 'unresolved_link_count'] },
        sort_order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number' },
        offset: { type: 'number' },
        title_contains: { type: 'string' },
        title_eq: { type: 'string' },
        join_filters: { type: 'array', items: { type: 'object' } },
        without_joins: { type: 'array', items: { type: 'string' } },
        without_types: { type: 'array', items: { type: 'string' } },
        without_titles: { type: 'array', items: { type: 'string' } },
        without_fields: { type: 'array', items: { type: 'string' } },
        without_node_ids: { type: 'array', items: { type: 'string' } },
        without_path_prefix: { type: 'string' },
        references: { type: 'array', items: { type: 'string' } },
        node_ids: { type: 'array', items: { type: 'string' } },
        modified_since: { type: 'string' },
      },
    },
    display_fields: { type: 'array', items: { type: 'string' }, description: 'Fields to show (max 8), e.g. ["status","due","project"].' },
    group_by: { type: 'string', description: 'The field rows are grouped by. Kanban: its columns (default "status"). Table or list: one section per value; omit it for no sections.' },
    date_field: { type: 'string', description: 'Calendar date field to plot by (e.g. "due"). Required when kind is "calendar".' },
    end_date_field: { type: 'string', description: 'Calendar only, optional: the date field where each item ends. An item with both dates shows on every day from its date_field date to this one.' },
    pin: { type: 'boolean', description: 'Pin the card to the canvas immediately. Only when the user explicitly asked to pin.' },
  },
} as const;


/** An Engine older than the map, as the current installation stores it: no vault domain, wiki
 *  at its defaults (nothing stored), curator with three active project statuses. */
const OLDER_ENGINE = vaultSettingsFrom({
  wiki: { effective: {} },
  curator: { effective: { activeStatuses: ['open', 'in-progress', 'next'], topicDir: null } },
});

/** A vault whose tasks are "todo" notes with a "state" field. */
const OTHER: VizVaultNames = {
  ...DEFAULT_VAULT_NAMES,
  taskType: 'todo', taskStatusField: 'state', taskActiveStatuses: ['doing'], taskDoneStatuses: ['finished'],
  taskTickStatus: 'finished', taskUntickStatus: 'todo', dueField: 'deadline', dateField: null, scheduledField: null,
};

/** No task kind, no status field, no date fields: every example is neutral. */
const NONE: VizVaultNames = { ...OTHER, taskType: null, taskStatusField: null, dueField: null };

const NOW = new Date('2026-07-25T10:00:00');

describe('with the vault map at its defaults', () => {
  it('the rules block is the text from before the map', () => {
    expect(VIZ_SPEC_RULES).toBe(RULES_BEFORE_THE_MAP);
    for (const names of [undefined, DEFAULT_VAULT_NAMES, OLDER_ENGINE]) expect(vizSpecRules(names)).toBe(RULES_BEFORE_THE_MAP);
  });

  it('the interpreter and board-plan prompts carry it unchanged', () => {
    for (const vault of [undefined, OLDER_ENGINE]) {
      const vocab = { types: [], ...(vault ? { vault } : {}) };
      expect(buildInterpretSystem(vocab, NOW)).toBe(buildInterpretSystem({ types: [] }, NOW));
      expect(buildInterpretSystem(vocab, NOW)).toContain(`Spec rules:\n${RULES_BEFORE_THE_MAP}\n`);
      expect(buildBoardPlanSystem(vocab, [], NOW)).toContain(`Spec rules (for add_viz / replace_viz specs):\n${RULES_BEFORE_THE_MAP}\n`);
    }
  });

  it('the present-viz schema is the schema from before the map', () => {
    expect(PRESENT_VIZ_SCHEMA).toEqual(SCHEMA_BEFORE_THE_MAP);
    expect(presentVizSchema(OLDER_ENGINE)).toEqual(SCHEMA_BEFORE_THE_MAP);
    const { pin: _pin, ...props } = SCHEMA_BEFORE_THE_MAP.properties;
    expect(interpretSchema(OLDER_ENGINE)).toEqual({ ...SCHEMA_BEFORE_THE_MAP, properties: props });
  });

  it('a kanban without group_by still fetches status', () => {
    const spec = { kind: 'kanban', title: 't', query: { types: ['task'] }, display_fields: ['due'] };
    expect(vizArgs(spec)).toEqual({ types: ['task'], include_fields: ['due', 'status'], limit: 50 });
    expect(vizArgs(spec, OLDER_ENGINE)).toEqual(vizArgs(spec));
  });
});

describe('with a vault\'s own names', () => {
  it('the examples use them and teach none of the default names', () => {
    const rules = vizSpecRules(OTHER);
    expect(rules).toContain(`e.g. 'todos · state != finished'.`);
    expect(rules).toContain('({"state":{"eq":"doing"}} — operators:');
    expect(rules).toContain("a kanban's columns (kanban defaults to state)");
    expect(rules).not.toMatch(/tasks|status|"open"|done/);
    expect(buildInterpretSystem({ types: [], vault: OTHER }, NOW)).toContain(rules);
    expect(buildBoardPlanSystem({ types: [], vault: OTHER }, [], NOW)).toContain(rules);
  });

  it('the present-viz schema uses them', () => {
    const p = presentVizSchema(OTHER).properties;
    expect(p.title.description).toBe('Short human query label shown on the card, e.g. \'todos · project = "Vault Engine" · state != finished\'.');
    expect(p.display_fields.description).toBe('Fields to show (max 8), e.g. ["state","deadline","project"].');
    expect(p.group_by.description).toBe('The field rows are grouped by. Kanban: its columns (default "state"). Table or list: one section per value; omit it for no sections.');
    expect(p.date_field.description).toBe('Calendar date field to plot by (e.g. "deadline"). Required when kind is "calendar".');
    expect(interpretSchema(OTHER).properties.title.description).toBe(p.title.description);
  });

  it('a list also fetches the task status field its checkbox reads', () => {
    const list = { kind: 'list', title: 't', query: {}, display_fields: ['due'], group_by: 'status' };
    expect(vizArgs(list, OTHER).include_fields).toEqual(['due', 'status', 'state']);
    expect(vizArgs({ ...list, group_by: undefined }).include_fields).toEqual(['due', 'status']);
  });

  it('present-viz verifies a kanban with the vault\'s status field', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [], total: 0 } }) }] }));
    const tool = createPresentVizTool(call, OTHER);
    expect(JSON.stringify((tool.inputSchema as { jsonSchema: unknown }).jsonSchema)).toContain('todos · project');
    await tool.execute!({ kind: 'kanban', title: 'mine', query: { types: ['todo'] }, display_fields: [] }, { toolCallId: 'x', messages: [] });
    expect(call).toHaveBeenCalledWith('query-nodes', { types: ['todo'], include_fields: ['state'], limit: 50 });
  });
});

describe('with none', () => {
  it('the examples are neutral', () => {
    const rules = vizSpecRules(NONE);
    expect(rules).toContain(`e.g. '<type> · <field> != <value>'.`);
    expect(rules).toContain('({"<field>":{"eq":"<value>"}} — operators:');
    expect(rules).toContain("a kanban's columns (set it for kanban)");
    expect(rules).not.toMatch(/tasks|todos|status|state/);
    const p = presentVizSchema(NONE).properties;
    expect(p.title.description).toBe("Short human query label shown on the card, e.g. '<type> · <field> != <value>'.");
    expect(p.display_fields.description).toBe('Fields to show (max 8), e.g. ["project"].');
    expect(p.group_by.description).toBe('The field rows are grouped by. Kanban: its columns. Table or list: one section per value; omit it for no sections.');
    expect(p.date_field.description).toBe('Calendar date field to plot by. Required when kind is "calendar".');
  });

  it('a kanban without group_by fetches no status field', () => {
    expect(vizArgs({ kind: 'kanban', title: 't', query: {}, display_fields: ['due'] }, NONE).include_fields).toEqual(['due']);
  });
});
