import { z } from 'zod';
import type { JsonSchema } from '../llm/types.js';
import type { ExistingWiki } from '../types.js';
import { pageKindDescriptions, pageLimitsPayload, type PageLimits } from '../page-templates.js';
import { WIKI_TITLE_FORBIDDEN_CHARACTERS, wikiPageTitlePrefix } from '@vault/contract';

const THEMED_PAGE_KINDS = [
  'workstream',
  'decision-log',
  'risk-register',
  'timeline',
  'stakeholder-map',
  'spotlight',
  'freeform',
] as const;

/** The length the planner is asked to keep each synthesis_brief to (#633). The plan validator checks it, so a
 *  longer brief goes back to the planner to shorten. It is not a schema limit: a `maxLength` sent to the model
 *  let a provider cut the brief off mid-word instead. */
export const SYNTHESIS_BRIEF_TARGET_CHARS = 2_000;
const REASON_MAX_CHARS = 1_000;

const nonEmptyString = z.string().min(1);
const synthesisBrief = nonEmptyString;
const reason = nonEmptyString.max(REASON_MAX_CHARS);

export const WIKI_SCOPE_SCHEMA = z.strictObject({
  v: z.literal(1),
  subject: nonEmptyString,
  facet: nonEmptyString,
  timeframe: z.string().optional(),
  geography: z.string().optional(),
  entities: z.array(z.string()).optional(),
  exclusions: z.array(z.string()).optional(),
});

function buildNodeRefSchema(existingNodeId: z.ZodType<string>) {
  return z.union([
    z.strictObject({ node_id: existingNodeId }),
    z.strictObject({ plan_key: nonEmptyString }),
  ]);
}

const ruleIds = z.array(z.number().int().positive());

function buildTopologyActionSchema(existingNodeId: z.ZodType<string>, withEvidenceIds = false, withRuleIds = false) {
  return z.discriminatedUnion('op', [
    z.strictObject({
      op: z.literal('keep'),
      node_id: existingNodeId,
      scope: WIKI_SCOPE_SCHEMA,
    }),
    z.strictObject({
      op: z.literal('refresh'),
      node_id: existingNodeId,
      scope: WIKI_SCOPE_SCHEMA,
      synthesis_brief: synthesisBrief,
      ...(withEvidenceIds ? { evidence_ids: z.array(nonEmptyString).optional() } : {}),
      ...(withRuleIds ? { rule_ids: ruleIds.optional() } : {}),
    }),
    z.strictObject({
      op: z.literal('reactivate'),
      node_id: existingNodeId,
      scope: WIKI_SCOPE_SCHEMA,
      synthesis_brief: synthesisBrief,
      ...(withEvidenceIds ? { evidence_ids: z.array(nonEmptyString).optional() } : {}),
      ...(withRuleIds ? { rule_ids: ruleIds.optional() } : {}),
    }),
    z.strictObject({
      op: z.literal('create'),
      plan_key: nonEmptyString,
      title: nonEmptyString,
      kind: z.enum(THEMED_PAGE_KINDS),
      scope: WIKI_SCOPE_SCHEMA,
      synthesis_brief: synthesisBrief,
      ...(withEvidenceIds ? { evidence_ids: z.array(nonEmptyString).optional() } : {}),
      ...(withRuleIds ? { rule_ids: ruleIds.optional() } : {}),
    }),
    z.strictObject({
      op: z.literal('merge'),
      target: buildNodeRefSchema(existingNodeId),
      sources: z.array(existingNodeId).min(1),
      scope: WIKI_SCOPE_SCHEMA,
      reason,
      synthesis_brief: synthesisBrief,
      ...(withEvidenceIds ? { evidence_ids: z.array(nonEmptyString).optional() } : {}),
      ...(withRuleIds ? { rule_ids: ruleIds.optional() } : {}),
    }),
    z.strictObject({
      op: z.literal('retire'),
      node_id: existingNodeId,
      scope: WIKI_SCOPE_SCHEMA,
      state: z.enum(['dormant', 'retired']),
      reason,
    }),
  ]);
}

export const NODE_REF_SCHEMA = buildNodeRefSchema(nonEmptyString);

export const TOPOLOGY_ACTION_SCHEMA = buildTopologyActionSchema(nonEmptyString, true, true);

export const TOPOLOGY_PLAN_SCHEMA = z.strictObject({
  reviewed_page_ids: z.array(nonEmptyString),
  actions: z.array(buildTopologyActionSchema(nonEmptyString)),
});

export const TOPOLOGY_PLAN_INPUT_SCHEMA = z.strictObject({
  reviewed_page_ids: z.array(nonEmptyString),
  actions: z.array(z.unknown()),
});

/** Planners have used merge to mean "update this page" (#257): self-merges, and merges into
 *  plan keys never defined. Stated in the system prompt and again in the repair feedback. */
export const MERGE_VS_REFRESH_RULE = 'To update an existing page in place, refresh it by its node_id; never merge a page into itself. '
  + 'Merge only folds other pages into one target: every source is an existing catalog page other than the target, and the target is '
  + 'an existing page\'s node_id or the plan_key of a create in this same plan. A page takes exactly one role in the plan.';

/** How the planner names each page's sources (#474 idea 3). A project page's writer reads only the
 *  sources named, plus the project note, so every page stops getting every note. */
export const EVIDENCE_IDS_RULE = 'When the plan schema offers evidence_ids, give every refresh, reactivate, create and merge the ids of the sources '
  + 'its page writer should read, copied exactly from the sources list (or from the ids shown in the evidence). The writer reads only those, '
  + 'so name every source the page\'s coverage rests on, and leave out sources about other pages. With evidence_ids left out, the writer reads every source.';

/** How the planner marks each page's rules on what to say (#474 idea 4). Code writes the marked
 *  memories onto the page, and a check after writing makes sure the page doesn't break them. */
export const RULE_IDS_RULE = 'When the plan schema offers rule_ids, some memories are rules on what may or may not be said, shared or claimed: '
  + 'naming, messaging, dates not to give, material to keep internal, claims not to make. Give every refresh, reactivate, create and merge the ids '
  + 'of the memories that are such rules and bear on its page, copied from the memories list. Code writes them onto the page and checks the page '
  + 'against them. Leave out facts, likes and opinions that are not rules on what to say.';

/** What a new page title can't be: the Engine's rule (#557), which the plan validator checks before any page is written. */
export const WIKI_PAGE_TITLE_RULE = `A page title can't contain any of ${WIKI_TITLE_FORBIDDEN_CHARACTERS}, and can't be "." or "..". `
  + 'Give each new page its own title, different from every catalog page\'s title, ignoring case.';

export const TOPOLOGY_SYSTEM_PROMPT = `You are the Vault Curator's wiki topology planner. Decide the information architecture only; never write final page prose.

Choose each new page's kind from page_kinds. When page_limits is supplied, respect it: propose the most valuable new pages first, because creates beyond the limits are dropped. Scope is identity; title and kind are presentation hints and never prove uniqueness.

Review every catalog row, including active, dormant, retired, pinned, unscoped, and invalid-scope pages. Return every catalog page ID exactly once in reviewed_page_ids. Omitting any catalog page invalidates the entire plan; omission is never an implicit keep.

Use only keep, refresh, reactivate, create, merge, or retire. Never delete a page. Prefer refreshing, reactivating, or merging an existing page over creating another page. Creation is the last resort, and every create will face a second complete-catalog adjudication pass before it can become a node.

The wiki_root_title names the project or topic root, not a subpage. Never create a page whose title matches wiki_root_title, including case-only or Unicode-normalization variants. Title each new page "<page_title_prefix><facet>", so a wiki's pages read and sort together: page_title_prefix is the root title and an em dash between spaces, with any character a title can't hold left out. ${WIKI_PAGE_TITLE_RULE}

Preserve owner intent: pinned pages may be kept, refreshed, reactivated, or merged with their intent transferred to the target, but never standalone-retired. Merge is additive and sources remain historical.

${MERGE_VS_REFRESH_RULE}

Base every scope and action on supplied evidence. Do not make unsupported claims. A synthesis_brief identifies evidence-backed coverage for a later page writer; it is not page prose. Keep each synthesis_brief to ${SYNTHESIS_BRIEF_TARGET_CHARS.toLocaleString('en-US')} characters or fewer; a longer brief is sent back to be shortened. plan_key values are batch-local references only.

${EVIDENCE_IDS_RULE}

${RULE_IDS_RULE}`;

export interface TopologyPlanTool {
  name: string;
  description: string;
  schema: JsonSchema;
}

export const TOPOLOGY_PLAN_TOOL: TopologyPlanTool = {
  name: 'emit_topology_plan',
  description: 'Return a complete topology-only plan covering every wiki catalog page.',
  schema: z.toJSONSchema(TOPOLOGY_PLAN_SCHEMA) satisfies JsonSchema,
};

/** `withEvidenceIds`: each writing action may name the sources its page's writer reads (topic
 *  wikis, and project wikis since #474). */
export function buildTopologyPlanTool(existingWiki: ExistingWiki, withEvidenceIds = false, withRuleIds = false): TopologyPlanTool {
  const catalogIds = existingWiki.subpages.map((page) => page.id);
  if (catalogIds.length === 0) {
    const emptyCatalogSchema = z.strictObject({
      reviewed_page_ids: z.array(z.never()).max(0),
      actions: z.array(z.discriminatedUnion('op', [
        z.strictObject({
          op: z.literal('create'),
          plan_key: nonEmptyString,
          title: nonEmptyString,
          kind: z.enum(THEMED_PAGE_KINDS),
          scope: WIKI_SCOPE_SCHEMA,
          synthesis_brief: synthesisBrief,
      ...(withEvidenceIds ? { evidence_ids: z.array(nonEmptyString).optional() } : {}),
      ...(withRuleIds ? { rule_ids: ruleIds.optional() } : {}),
        }),
      ])),
    });
    const schema = z.toJSONSchema(emptyCatalogSchema) satisfies JsonSchema;
    const properties = schema['properties'] as Record<string, JsonSchema>;
    delete properties['reviewed_page_ids']?.['items'];
    return { ...TOPOLOGY_PLAN_TOOL, schema };
  }

  const catalogId = z.enum(catalogIds as [string, ...string[]]);
  const schema = z.toJSONSchema(z.strictObject({
    reviewed_page_ids: z.array(catalogId),
    actions: z.array(buildTopologyActionSchema(catalogId, withEvidenceIds, withRuleIds)),
  })) satisfies JsonSchema;
  return { ...TOPOLOGY_PLAN_TOOL, schema };
}

/** One source a project planner can give a page (#474 idea 3): the notes whose full text is in the
 *  evidence, by id, so a plan can name them. */
export interface PlannerSource {
  readonly id: string;
  readonly title: string;
  readonly types: readonly string[];
  /** The day it was last modified, in the Curator's zone; absent when unknown. */
  readonly modified?: string;
}

/** A memory the planner can mark as a page's rule (#474 idea 4). */
export interface PlannerMemory {
  readonly id: number;
  readonly category: string | null;
  readonly text: string;
}

export function buildTopologyPromptPayload(evidence: string, existingWiki: ExistingWiki, rootTitle: string, pageLimits?: PageLimits,
  sources?: readonly PlannerSource[], memories?: readonly PlannerMemory[]): string {
  return JSON.stringify({ wiki_root_title: rootTitle, page_title_prefix: wikiPageTitlePrefix(rootTitle), evidence, existing_wiki: existingWiki, page_kinds: pageKindDescriptions(),
    ...(pageLimits ? { page_limits: pageLimitsPayload(pageLimits, existingWiki) } : {}),
    ...(sources ? { sources } : {}),
    ...(memories ? { memories } : {}) });
}
