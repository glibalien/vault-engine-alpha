import { createFieldMap } from '../fields/field-map.js';
import type Database from 'better-sqlite3';
import { reconstructValue } from '../pipeline/classify-value.js';
import { sanitizeFilename } from '../mcp/tools/title-warnings.js';
import { titleFromFilename } from '../parser/parse.js';
import { fetchContacts, fetchMeetings } from './evidence.js';
import {
  buildProjectDigest,
  fetchExistingWiki,
  type DigestProject,
  type ProjectDigest,
} from './digest.js';
import {
  renderContacts,
  renderLiveSections,
  renderMeetings,
  renderNotes,
  renderTasks,
} from './render-live.js';
import type { WikiConfig } from './config.js';

export type WikiWriteTarget = 'home' | 'subpage';

export type WikiWriteTargetNode = {
  readonly id: string;
  readonly file_path: string;
  readonly title: string;
  readonly body: string | null;
};

/** The word after the root's title in a new home's title: "Wiki", or "Dossier" for an entity's
 *  dossier (#554), which the Curator asks for with wiki-reconcile's `home.title_suffix`. */
export type WikiHomeTitleSuffix = 'Wiki' | 'Dossier';

export function buildWikiPageTitle(
  projectTitle: string,
  target: WikiWriteTarget,
  subpageTitle?: string,
  homeSuffix: WikiHomeTitleSuffix = 'Wiki',
): string {
  return target === 'home' ? `${projectTitle} ${homeSuffix}` : (subpageTitle ?? '');
}

export function buildWikiFilePath(wikiDir: string, title: string): string {
  const sanitized = sanitizeFilename(`${title}.md`).filename;
  return wikiDir ? `${wikiDir}/${sanitized}` : sanitized;
}

export function findWikiTarget(
  db: Database.Database,
  input: {
    readonly projectId: string;
    readonly title: string;
    readonly target: WikiWriteTarget;
    readonly wikiType: string;
  },
): { readonly node: WikiWriteTargetNode | null; readonly reused: boolean } {
  let row: { id: string; file_path: string; title: string | null; body: string | null } | undefined;
  if (input.target === 'home') {
    row = db.prepare(`
      SELECT n.id, n.file_path, n.title, n.body
      FROM nodes n
      JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = ?
      JOIN relationships r ON r.source_id = n.id AND r.rel_type = 'wiki_for' AND r.resolved_target_id = ?
      WHERE NOT EXISTS (SELECT 1 FROM relationships rp WHERE rp.source_id = n.id AND rp.rel_type = 'wiki_parent')
      ORDER BY n.file_mtime IS NULL, n.file_mtime DESC, n.title ASC
      LIMIT 1
    `).get(input.wikiType, input.projectId) as typeof row;
  } else {
    row = db.prepare(`
      SELECT n.id, n.file_path, n.title, n.body
      FROM nodes n
      JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = ?
      JOIN relationships r ON r.source_id = n.id AND r.rel_type = 'wiki_for' AND r.resolved_target_id = ?
      WHERE n.title IN (?, ?)
      ORDER BY n.file_mtime IS NULL, n.file_mtime DESC, n.title ASC
      LIMIT 1
    `).get(input.wikiType, input.projectId, input.title, titleFromFilename(buildWikiFilePath('', input.title))) as typeof row;
  }
  return row
    ? {
        node: {
          id: row.id,
          file_path: row.file_path,
          title: row.title ?? row.file_path,
          body: row.body,
        },
        reused: input.target === 'subpage',
      }
    : { node: null, reused: false };
}

export function resolveWikiParent(
  db: Database.Database,
  project: Pick<DigestProject, 'id' | 'title'>,
  config: WikiConfig,
): { readonly id: string; readonly title: string } {
  const existing = fetchExistingWiki(db, project.id, config);
  if (existing.home_id) {
    const row = db.prepare('SELECT id, title, file_path FROM nodes WHERE id = ?')
      .get(existing.home_id) as { id: string; title: string | null; file_path: string } | undefined;
    if (row) return { id: row.id, title: row.title ?? row.file_path.replace(/\.md$/, '') };
  }
  return { id: '', title: buildWikiPageTitle(project.title, 'home') };
}

export function buildWikiTargetFields(input: {
  readonly currentFields: Readonly<Record<string, unknown>>;
  readonly target: WikiWriteTarget;
  readonly parentTitle?: string;
} & (
  | { readonly projectTarget: string; readonly projectTitle?: never }
  | { readonly projectTitle: string; readonly projectTarget?: never }
)): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    ...input.currentFields,
    wiki_for: input.projectTarget ?? input.projectTitle,
  };
  if (input.target === 'subpage') fields.wiki_parent = input.parentTitle ?? '';
  if (input.target === 'home') delete fields.wiki_parent;
  return fields;
}

export function loadWikiNodeFields(db: Database.Database, nodeId: string): Record<string, unknown> {
  const rows = db.prepare(`
    SELECT field_name, value_text, value_number, value_date, value_json
    FROM node_fields WHERE node_id = ?
  `).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
  }>;
  const fields = createFieldMap<unknown>();
  for (const row of rows) fields[row.field_name] = reconstructValue(row);
  return fields;
}

export function renderWikiLiveSections(
  db: Database.Database,
  input: {
    readonly config: WikiConfig;
    readonly projectId: string;
    readonly digest: ProjectDigest;
    readonly target: WikiWriteTarget;
    readonly pageKind?: 'overview' | 'task-board' | 'contacts' | 'meetings' | 'notes';
  },
): Record<string, string> {
  if (input.target === 'home' || !input.pageKind || input.pageKind === 'overview') {
    return renderLiveSections(input.digest, input.target === 'home');
  }
  const today = input.digest.windows.today;
  switch (input.pageKind) {
    case 'task-board':
      return { tasks: renderTasks(input.digest) };
    case 'notes':
      return { notes: renderNotes(input.digest.notes) };
    case 'contacts':
      return { contacts: renderContacts(fetchContacts(db, input.projectId, input.config, 50)) };
    case 'meetings':
      return {
        meetings: renderMeetings(fetchMeetings(
          db,
          input.projectId,
          input.config,
          today,
          { recent: 25, upcoming: 15 },
        )),
      };
    default:
      return renderLiveSections(input.digest, false);
  }
}

export function buildCurrentWikiDigest(db: Database.Database, projectId: string): ProjectDigest {
  return buildProjectDigest(db, { project: projectId });
}
