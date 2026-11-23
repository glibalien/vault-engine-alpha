import { entityKinds, type VaultSettings } from '@vault/settings-registry';

/**
 * A dossier's sections per kind of note (#716; owner, 2026-11-21: a Curator setting,
 * `dossierSections`). Each list is a `kind:` line, then one `- Name: what goes in it` line per
 * section. Blank uses the built-in lists: today's person and company sections, and a plain list
 * for any other kind. "Last contact" and "Rules on what to say" stay code's, whatever the kind.
 */

export interface DossierSectionSpec {
  readonly name: string;
  /** One line for the model: what goes in the section. */
  readonly guide: string;
}

/** The sections a build uses, and where they came from. */
export interface DossierSections {
  /** The list's heading: a kind's name, `person`, `company` or `other`. */
  readonly list: string;
  readonly from: 'setting' | 'built-in';
  readonly sections: readonly DossierSectionSpec[];
  /** What the setting held that could not be used, in plain words; empty when all of it could. */
  readonly issues: readonly string[];
  /** What the prompt calls the subject: "person", "company", or the note's kind for any other. */
  readonly noun: string;
}

/** Sections code writes itself; a list can't name them. */
export const RESERVED_DOSSIER_SECTIONS = ['Last contact', 'Rules on what to say'] as const;

export const DOSSIER_SECTION_LIMITS = { sections: 12, nameChars: 60, guideChars: 600 } as const;

const OPEN_ITEMS = (who: string): string => `what is unresolved or still to be done with ${who}, as of today. An item whose day has passed `
  + '(a deadline gone by, a meeting already held, a request from weeks ago) is History, written as what happened, '
  + 'unless a newer memory or note says it is still open.';

/** The built-in lists, as the setting is written. The person and company lines are the sections
 *  dossiers had before the setting, word for word. */
export const BUILT_IN_DOSSIER_SECTIONS = `person:
- Who: who they are: role, employer, location, background.
- Relationships: their company, the people they work with, and how they relate to the vault owner.
- Preferences: how they like to work and to be dealt with.
- History: what happened with them, one event per line, newest first.
- Open items: ${OPEN_ITEMS('them')}

company:
- What it is: what the company does, and how it relates to the vault owner (client, vendor, partner, employer).
- People: the people there and their roles.
- Relationships: other companies, projects and products it is tied to.
- Preferences & terms: how they like to work, and terms agreed with them (prices, contracts, schedules).
- History: what happened with them, one event per line, newest first.
- Open items: ${OPEN_ITEMS('them')}

other:
- What it is: what it is, and how it relates to the vault owner.
- Relationships: the people, companies and projects it is tied to.
- History: what happened with it, one event per line, newest first.
- Open items: ${OPEN_ITEMS('it')}`;

interface ParsedLists {
  /** By heading, lower-cased. */
  readonly lists: ReadonlyMap<string, { readonly heading: string; readonly sections: readonly DossierSectionSpec[] }>;
  readonly issues: readonly string[];
}

const HEADING = /^([^\s\-*][^:]*):\s*$/;
const SECTION = /^\s*[-*]\s+(.*)$/;

/** Reads the setting's text. What can't be used is skipped and said in `issues`; the rest stands. */
export function parseDossierSections(text: string): ParsedLists {
  const lists = new Map<string, { heading: string; sections: DossierSectionSpec[] }>();
  const issues: string[] = [];
  let current: { heading: string; sections: DossierSectionSpec[] } | null = null;
  let skipping = false;
  const close = (): void => {
    if (current && !skipping) {
      if (current.sections.length === 0) issues.push(`"${current.heading}" lists no section it can use, so it is left out.`);
      else lists.set(current.heading.toLowerCase(), current);
    }
    current = null;
  };
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    const where = `line ${index + 1}`;
    if (line.trim() === '') return;
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      const name = heading[1]!.trim();
      skipping = lists.has(name.toLowerCase());
      if (skipping) issues.push(`"${name}" is listed twice (${where}); the first list is used.`);
      current = { heading: name, sections: [] };
      return;
    }
    const section = SECTION.exec(line);
    if (!section) { issues.push(`${where} is neither "kind:" nor "- Name: what goes in it", so it is skipped.`); return; }
    if (!current) { issues.push(`${where} comes before any "kind:" line, so it is skipped.`); return; }
    if (skipping) return;
    const list: { heading: string; sections: DossierSectionSpec[] } = current;
    const body = section[1]!.trim();
    const colon = body.indexOf(': ');
    const name = (colon < 0 ? body.replace(/:$/, '') : body.slice(0, colon)).trim();
    const guide = colon < 0 ? '' : body.slice(colon + 2).trim();
    if (name === '' || guide === '') { issues.push(`${where} needs a name and what goes in it, as "- Name: what goes in it"; it is skipped.`); return; }
    if (RESERVED_DOSSIER_SECTIONS.some(reserved => reserved.toLowerCase() === name.toLowerCase())) {
      issues.push(`"${name}" (${where}) is written by code on every dossier, so a list can't name it; it is skipped.`);
      return;
    }
    if (name.length > DOSSIER_SECTION_LIMITS.nameChars || /[#[\]<>|]/.test(name)) {
      issues.push(`"${name.slice(0, DOSSIER_SECTION_LIMITS.nameChars)}" (${where}) can't be a heading: at most ${DOSSIER_SECTION_LIMITS.nameChars} characters, none of # [ ] < > |; it is skipped.`);
      return;
    }
    if (guide.length > DOSSIER_SECTION_LIMITS.guideChars) {
      issues.push(`What goes in "${name}" (${where}) is over ${DOSSIER_SECTION_LIMITS.guideChars} characters; it is skipped.`);
      return;
    }
    if (list.sections.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      issues.push(`"${name}" is in "${list.heading}" twice (${where}); the first is used.`);
      return;
    }
    if (list.sections.length >= DOSSIER_SECTION_LIMITS.sections) {
      issues.push(`"${list.heading}" has more than ${DOSSIER_SECTION_LIMITS.sections} sections; "${name}" (${where}) is skipped.`);
      return;
    }
    list.sections.push({ name, guide });
  });
  close();
  return { lists, issues };
}

let builtIn: ParsedLists | null = null;
const builtInLists = (): ParsedLists => builtIn ??= parseDossierSections(BUILT_IN_DOSSIER_SECTIONS);

/**
 * The sections a note's dossier uses. The note's own kind is looked for first, then `person` or
 * `company` for the vault map's person and company kinds, then `other`; at each, the setting's list
 * before the built-in one. So a setting that lists only `vendor:` changes vendors' dossiers alone.
 */
export function dossierSectionsFor(setting: string | undefined, vault: VaultSettings, types: readonly string[]): DossierSections {
  const parsed = setting && setting.trim() !== '' ? parseDossierSections(setting) : { lists: new Map(), issues: [] } as ParsedLists;
  const kinds = entityKinds(vault).filter(kind => kind !== vault.projectType);
  const own = types.filter(type => kinds.includes(type));
  const role = vault.personType !== null && types.includes(vault.personType) ? 'person'
    : vault.companyType !== null && types.includes(vault.companyType) ? 'company' : 'other';
  const keys = [...new Set([...own, role, 'other'].map(key => key.toLowerCase()))];
  for (const key of keys) {
    for (const [from, lists] of [['setting', parsed], ['built-in', builtInLists()]] as const) {
      const list = lists.lists.get(key);
      if (list) {
        return { list: list.heading, from, sections: list.sections, issues: parsed.issues, noun: role === 'other' ? (own[0] ?? 'subject') : role };
      }
    }
  }
  // The built-in lists always hold `other`.
  throw new Error('no dossier section list');
}

/** The built-in lists for a role, for the golden evals and tests. */
export function builtInDossierSections(role: 'person' | 'company' | 'other'): readonly DossierSectionSpec[] {
  return builtInLists().lists.get(role)!.sections;
}
