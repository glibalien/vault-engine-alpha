import type Database from 'better-sqlite3';
import { seededRandom } from '../../src/survey/kmeans.js';

/**
 * A fictional notes dump from three apps (#642). Each app's export sits in its own folder, in
 * its own style, and holds the same five kinds of note mixed together, none of them typed.
 * It is what the survey has to sort: the kind is in the text, the folder says only which app.
 */

export const KINDS = ['meeting', 'recipe', 'book', 'journal', 'contact'] as const;
export type Kind = typeof KINDS[number];
export const APPS = ['Evernote Export', 'Notion', 'Bear Notes'] as const;
export type App = typeof APPS[number];

export interface FixtureNote {
  id: string;
  kind: Kind;
  app: App;
  path: string;
  title: string;
  body: string;
  fields: Record<string, string>;
}

const PEOPLE = ['Dana Whitfield', 'Lee Okafor', 'Priya Raman', 'Tomas Lindqvist', 'Mina Castell', 'Jon Abara', 'Greta Sorensen', 'Ravi Menon', 'Elena Brandt', 'Samir Haddad'];
const COMPANIES = ['Acme', 'Northwind', 'Globex', 'Initech', 'Umbrella Freight', 'Stark Tooling', 'Wayfarer Labs'];
const TOPICS = ['the renewal pricing', 'the onboarding rollout', 'the Q3 roadmap', 'the data migration', 'the support backlog', 'the pilot results', 'the security review', 'the hiring plan'];
const ACTIONS = ['send the revised quote', 'schedule a follow-up', 'share the draft plan', 'confirm the timeline with legal', 'update the tracker', 'loop in finance', 'write up the decision'];
const DISHES = ['Lentil soup', 'Roast chicken', 'Mushroom risotto', 'Lemon tart', 'Chili', 'Flatbread', 'Miso salmon', 'Apple crumble', 'Green curry', 'Baked beans'];
const INGREDIENTS = ['2 onions', '3 cloves garlic', '400 g tomatoes', '1 tbsp olive oil', '200 g flour', '2 eggs', 'a pinch of salt', '1 lemon', '250 ml stock', '1 tsp cumin', '100 g butter', 'fresh parsley'];
const STEPS = ['Chop everything finely.', 'Soften the onions over a low heat.', 'Add the liquid and simmer for twenty minutes.', 'Season and taste.', 'Bake until golden.', 'Rest for ten minutes before serving.', 'Whisk until smooth.'];
const BOOKS = ['The Long Harvest', 'Signal and Tide', 'A Field Guide to Quiet', 'Cities of Glass', 'The Cartographer\'s Year', 'Small Engines', 'Northern Rivers', 'An Ordinary Compass'];
const AUTHORS = ['M. Aldane', 'R. Okonjo', 'T. Vasseur', 'H. Lindgren', 'P. Castellano', 'S. Yamane'];
const INSIGHTS = ['habits compound when they are tied to a place', 'most plans fail at the handoff, not the idea', 'attention is the scarce resource, not time', 'good maps leave things out on purpose', 'small teams decide faster because they share context', 'the first draft exists to be replaced'];
const MOODS = ['tired but content', 'restless', 'calm', 'a bit anxious', 'optimistic', 'flat', 'grateful'];
const EVENTS = ['Walked by the river before work', 'Slept badly again', 'Long call with my sister', 'Finally cleared the garage', 'Rain all day, stayed in', 'Ran five kilometres', 'Cooked for friends', 'Spent the evening reading'];
const REFLECTIONS = ['I should stop checking email first thing.', 'Need to plan the weekend better.', 'Feeling more settled than last month.', 'Want to get back to drawing.', 'Grateful for a quiet day.', 'Must call the dentist.'];
const ROLES = ['Head of Operations', 'Account Manager', 'Staff Engineer', 'Procurement Lead', 'Founder', 'Product Designer', 'Finance Director'];
const CITIES = ['Leeds', 'Rotterdam', 'Austin', 'Gothenburg', 'Porto', 'Kraków'];

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
function some<T>(random: Random, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  return out;
}
const pad = (n: number): string => String(n).padStart(2, '0');
function day(random: Random): { iso: string; long: string; compact: string } {
  const year = 2014 + Math.floor(random() * 10);
  const month = 1 + Math.floor(random() * 12);
  const date = 1 + Math.floor(random() * 28);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return { iso: `${year}-${pad(month)}-${pad(date)}`, long: `${names[month - 1]} ${date}, ${year}`, compact: `${year}${pad(month)}${pad(date)}` };
}
function hex(random: Random): string {
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}

interface Content { title: string; lines: Array<[label: string, value: string]>; sections: Array<[heading: string, text: string]>; tag: string }

function content(kind: Kind, random: Random): Content {
  const when = day(random);
  if (kind === 'meeting') {
    const company = pick(random, COMPANIES);
    return {
      title: `${company} sync on ${pick(random, TOPICS).replace('the ', '')}`,
      lines: [['Date', when.iso], ['Attendees', some(random, PEOPLE, 3).join(', ')], ['Company', company]],
      sections: [
        ['Discussion', `We talked through ${pick(random, TOPICS)} and ${pick(random, TOPICS)}. ${pick(random, PEOPLE)} raised concerns about timing.`],
        ['Action items', some(random, ACTIONS, 3).map(action => `- ${pick(random, PEOPLE).split(' ')[0]} to ${action}`).join('\n')],
      ],
      tag: 'meeting',
    };
  }
  if (kind === 'recipe') {
    return {
      title: pick(random, DISHES),
      lines: [['Serves', String(2 + Math.floor(random() * 5))], ['Time', `${15 + Math.floor(random() * 60)} minutes`]],
      sections: [
        ['Ingredients', some(random, INGREDIENTS, 6).map(item => `- ${item}`).join('\n')],
        ['Method', some(random, STEPS, 4).map((step, i) => `${i + 1}. ${step}`).join('\n')],
      ],
      tag: 'recipe',
    };
  }
  if (kind === 'book') {
    const book = pick(random, BOOKS);
    return {
      title: `${book} notes`,
      lines: [['Author', pick(random, AUTHORS)], ['Finished', when.iso], ['Rating', `${3 + Math.floor(random() * 3)}/5`]],
      sections: [
        ['Summary', `The book argues that ${pick(random, INSIGHTS)}, and that ${pick(random, INSIGHTS)}.`],
        ['Highlights', some(random, INSIGHTS, 3).map(insight => `> ${insight}`).join('\n\n')],
      ],
      tag: 'books',
    };
  }
  if (kind === 'journal') {
    return {
      title: `Journal ${when.long}`,
      lines: [['Mood', pick(random, MOODS)]],
      sections: [
        ['Today', `${pick(random, EVENTS)}. ${pick(random, EVENTS)}. ${pick(random, REFLECTIONS)}`],
        ['Thoughts', `${pick(random, REFLECTIONS)} ${pick(random, REFLECTIONS)}`],
      ],
      tag: 'journal',
    };
  }
  const person = pick(random, PEOPLE);
  return {
    title: person,
    lines: [
      ['Role', pick(random, ROLES)], ['Company', pick(random, COMPANIES)], ['City', pick(random, CITIES)],
      ['Email', `${person.split(' ')[0]!.toLowerCase()}@example.com`],
    ],
    sections: [['Notes', `Met at a conference in ${pick(random, CITIES)}. Interested in ${pick(random, TOPICS)}. Prefers a call over email.`]],
    tag: 'people',
  };
}

/** Each app writes the same content its own way: title form, where metadata goes, headings or not. */
function render(app: App, kind: Kind, index: number, random: Random): Omit<FixtureNote, 'id' | 'kind' | 'app'> {
  const c = content(kind, random);
  const exported = day(random);
  if (app === 'Evernote Export') {
    // Metadata in frontmatter, plain paragraphs, bold lead-ins instead of headings.
    const title = `${c.title} ${exported.compact}-${index}`;
    const body = [
      ...c.lines.map(([label, value]) => `**${label}:** ${value}`),
      '',
      ...c.sections.map(([heading, text]) => `**${heading}**\n\n${text}`),
    ].join('\n');
    return { path: `Evernote Export/${title}.md`, title, body, fields: { created: `${exported.iso}T09:00:00Z`, source: 'desktop.win', author: 'me' } };
  }
  if (app === 'Notion') {
    // An id suffix on every file, properties as plain "Label: value" lines, proper headings.
    const title = `${c.title} ${hex(random)}`;
    const body = [
      `# ${c.title}`,
      '',
      ...c.lines.map(([label, value]) => `${label}: ${value}`),
      '',
      ...c.sections.map(([heading, text]) => `## ${heading}\n\n${text}`),
    ].join('\n');
    return { path: `Notion/${title}.md`, title, body, fields: {} };
  }
  // Bear: a tag line, terse text, no frontmatter.
  const title = `${c.title} (${index})`;
  const body = [
    `# ${c.title}`,
    `#${c.tag} #imported`,
    '',
    ...c.lines.map(([label, value]) => `- ${label}: ${value}`),
    '',
    ...c.sections.map(([heading, text]) => `### ${heading}\n${text}`),
  ].join('\n');
  return { path: `Bear Notes/${title}.md`, title, body, fields: {} };
}

/** `perCell` notes of every kind in every app: 15 cells. The same seed gives the same notes. */
export function mixedExportNotes(perCell: number, seed = 642): FixtureNote[] {
  const random = seededRandom(seed);
  const notes: FixtureNote[] = [];
  for (const app of APPS) {
    for (const kind of KINDS) {
      for (let i = 0; i < perCell; i++) {
        const id = `n${String(notes.length).padStart(5, '0')}`;
        notes.push({ id, kind, app, ...render(app, kind, i, random) });
      }
    }
  }
  return notes;
}

export function insertNotes(db: Database.Database, notes: readonly FixtureNote[]): void {
  const node = db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)');
  const field = db.prepare('INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const note of notes) {
      node.run(note.id, note.path, note.title, note.body);
      for (const [name, value] of Object.entries(note.fields)) field.run(note.id, name, value);
    }
  })();
}
