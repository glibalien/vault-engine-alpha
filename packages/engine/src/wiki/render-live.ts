import type { ProjectDigest, DigestNode, DigestTask } from './digest.js';
import type { EvidenceContact, EvidenceMeeting } from './evidence.js';
// Emits `[[basename|title]]` when the title would not resolve by filename
// (sanitized filename, or title drifted from filename), plain `[[title]]`
// otherwise. See resolver/file-link.ts for why the bare title is not portable.
import { wikilinkTo as wikilink } from '../resolver/file-link.js';

export function renderContacts(contacts: { people: EvidenceContact[]; companies: Array<{ id: string; title: string; file_path?: string }> }): string {
  const chunks: string[] = [];
  if (contacts.people.length > 0) {
    chunks.push(`**People (${contacts.people.length})**`);
    for (const person of contacts.people) {
      const meta = [
        person.companies.length > 0 ? person.companies.join(', ') : null,
        person.meeting_count > 0 ? `${person.meeting_count} meeting${person.meeting_count === 1 ? '' : 's'}` : null,
        person.direct ? 'project contact' : null,
      ].filter(Boolean).join(' · ');
      chunks.push(`- ${wikilink(person.title, person.file_path)}${meta ? ` — ${meta}` : ''}`);
    }
  }
  if (contacts.companies.length > 0) {
    if (chunks.length > 0) chunks.push('');
    chunks.push(`**Companies (${contacts.companies.length})**`);
    for (const company of contacts.companies) chunks.push(`- ${wikilink(company.title, company.file_path)}`);
  }
  return chunks.join('\n');
}

export function renderMeetings(meetings: { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] }): string {
  const chunks: string[] = [];
  for (const [label, list] of [['Upcoming', meetings.upcoming], ['Recent', meetings.recent]] as const) {
    if (list.length === 0) continue;
    chunks.push(`**${label} (${list.length})**`);
    for (const meeting of list) chunks.push(`- ${renderMeeting(meeting)}`);
  }
  return chunks.join('\n');
}

export function renderNotes(notes: DigestNode[]): string {
  if (notes.length === 0) return '';
  return notes.map(note => `- ${wikilink(note.title, note.file_path)}`).join('\n');
}

function renderMeeting(meeting: EvidenceMeeting): string {
  const meta = [meeting.date, meeting.attendees.length > 0 ? meeting.attendees.join(', ') : null]
    .filter(Boolean).join(' · ');
  return `${wikilink(meeting.title, meeting.file_path)}${meta ? ` — ${meta}` : ''}`;
}

export function renderTasks(digest: ProjectDigest): string {
  const cap = digest.config_used.liveTaskGroupCap;
  const groups: Array<[string, DigestTask[]]> = [
    ['Overdue', digest.tasks.overdue],
    ['Blocked', digest.tasks.blocked],
    ['Open', digest.tasks.open],
    ['Backlog', digest.tasks.backlog],
    ['Upcoming', digest.tasks.upcoming],
    ['Recently done', digest.tasks.done_recent],
  ];
  return renderTaskGroups(groups, cap);
}

export function renderUpcoming(digest: ProjectDigest): string {
  return renderTaskGroups([['Upcoming', digest.tasks.upcoming]], digest.config_used.liveTaskGroupCap);
}

export function renderRelated(digest: ProjectDigest): string {
  if (!digest.config_used.renderRelatedLive) return '';
  const cap = digest.config_used.liveRelatedCap;
  let rendered = 0;
  const chunks: string[] = [];
  for (const [direction, groups] of [
    ['Incoming', digest.neighborhood.incoming],
    ['Outgoing', digest.neighborhood.outgoing],
  ] as const) {
    const relTypes = Object.keys(groups).sort();
    if (relTypes.length === 0) continue;
    chunks.push(`**${direction}**`);
    for (const relType of relTypes) {
      if (rendered >= cap) break;
      chunks.push(`- ${relType}`);
      for (const node of groups[relType].slice(0, cap - rendered)) {
        chunks.push(`  - ${wikilink(node.title, node.file_path)}`);
        rendered++;
      }
    }
    if (rendered >= cap) break;
  }
  return chunks.join('\n');
}

export function renderSubPages(digest: ProjectDigest): string {
  const subpages = digest.existing_wiki.subpages;
  if (subpages.length === 0) return '';
  const sorted = subpages
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title) || a.file_path.localeCompare(b.file_path));
  const hasResolvedReplacement = (page: (typeof sorted)[number]): boolean => page.wiki_replaced_by?.id !== undefined;
  const active = sorted.filter(page => page.wiki_state !== 'dormant' && page.wiki_state !== 'retired' && !hasResolvedReplacement(page));
  const dormant = sorted.filter(page => page.wiki_state === 'dormant' && !hasResolvedReplacement(page));
  const retired = sorted.filter(page => page.wiki_state === 'retired' || hasResolvedReplacement(page));
  // Missing/unknown wiki_state renders as active (defaults are creation-only;
  // existing spine pages never carry the field). When nothing is retired or
  // dormant, keep the flat list so established wikis don't churn.
  if (dormant.length === 0 && retired.length === 0) {
    return active.map(page => `- ${wikilink(page.title, page.file_path)}`).join('\n');
  }
  const chunks: string[] = [];
  if (active.length > 0) {
    chunks.push('**Active pages**');
    for (const page of active) chunks.push(`- ${wikilink(page.title, page.file_path)}`);
  }
  if (dormant.length > 0) {
    if (chunks.length > 0) chunks.push('');
    chunks.push('<details>', `<summary>Dormant (${dormant.length})</summary>`, '');
    for (const page of dormant) chunks.push(`- ${wikilink(page.title, page.file_path)}`);
    chunks.push('', '</details>');
  }
  if (retired.length > 0) {
    if (chunks.length > 0) chunks.push('');
    chunks.push('**History**');
    const pageById = new Map(sorted.map(page => [page.id, page]));
    for (const page of retired) {
      const targetId = page.wiki_replaced_by?.id;
      const target = targetId === undefined ? undefined : pageById.get(targetId);
      const replacement = target === undefined
        ? page.wiki_replaced_by?.title
        : wikilink(target.title, target.file_path);
      chunks.push(`- ${wikilink(page.title, page.file_path)}${replacement === undefined ? '' : ` → ${replacement.startsWith('[[') ? replacement : wikilink(replacement)}`}`);
    }
  }
  return chunks.join('\n');
}

export function renderLiveSections(digest: ProjectDigest, includeSubPages = true): Record<string, string> {
  const live: Record<string, string> = {
    tasks: renderTasks(digest),
    upcoming: renderUpcoming(digest),
  };
  if (digest.config_used.renderRelatedLive) live.related = renderRelated(digest);
  if (includeSubPages) live['sub-pages'] = renderSubPages(digest);
  return live;
}

function renderTaskGroups(groups: Array<[string, DigestTask[]]>, cap: number): string {
  const chunks: string[] = [];
  for (const [name, tasks] of groups) {
    if (tasks.length === 0) continue;
    const shown = tasks.slice(0, cap);
    chunks.push(`**${groupLabel(name, shown.length, tasks.length)}**`);
    for (const task of shown) chunks.push(`- ${renderTask(task)}`);
  }
  return chunks.join('\n');
}

// Label reflects what is actually rendered: "Open (8 of 12)" when the cap
// truncates the group, "Open (3)" when the whole group fits.
function groupLabel(name: string, shown: number, total: number): string {
  return shown < total ? `${name} (${shown} of ${total})` : `${name} (${total})`;
}

function renderTask(task: DigestTask): string {
  const meta = [task.due ? `due ${task.due}` : null, task.status].filter(Boolean).join(' · ');
  return `${wikilink(task.title, task.file_path)}${meta ? ` — ${meta}` : ''}`;
}
