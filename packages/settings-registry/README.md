# @vault/settings-registry

`@vault/settings-registry` is the static schema for every behavioral setting in the
Vault Engine suite. It defines domains, keys, value types, defaults, reload behavior,
first-boot environment seeds, and model-catalog wire types.

The package has zero runtime dependencies. It validates values and computes effective
settings, but it does not read environment files, persist SQLite rows, or render
Markdown. Engine and Curator own those effects.

## Domains

| Domain | Primary owner | Examples |
| --- | --- | --- |
| `engine` | Vault Engine | backups, retention, exclusions, normalization, vision, memory consolidation |
| `wiki` | Vault Engine wiki primitives | sub-page cap, live section caps, related sections |
| `chat` | Chat hosts | default/title/viz models, context budget, step limit, prompt text |
| `curator` | Vault Curator | synthesis models, sweep timing, wiki policy, memory and organization controls |
| `vault` | Every package (Engine stores it) | the vault's vocabulary: kinds of notes, fields, status meaning, folders |

### Which note shows a setting

Engine shows each domain's settings in the settings folder. Chat, Wiki and Vault have one
note each (`Settings/Chat.md`). Curator and Engine have a folder of notes, one per area,
like the tabs of a settings screen (#746): `Settings/Curator/Models.md`,
`Settings/Engine/Backups and retention.md`. `SETTINGS_GROUPS` (`src/notes.ts`) lists each
group's keys in the order its note documents them; a test fails when a key is in no group
or in two. Settings are still stored one blob per domain: only the notes are split.

- `settingsNotesOf(domain)` — the domain's notes, each with its keys.
- `settingsNoteOfKey(domain, key)`, `settingsNotePath(settingsDir, note)`,
  `settingsNoteTitle(note)` — where a key is shown.
- `settingsNoteLabel(domain, key?)` — the path to name in a message (`Settings/Curator/Wikis.md`).
- `settingsNotesForKeys(domain, keys)` — the notes a write of those keys changes.

Each descriptor includes a `reload` class:

- `next-use` — read the new value on the next operation.
- `re-arm` — rebuild or reschedule a long-lived runtime component.
- `restart` — process restart required.

## The vault map (`vault` domain)

`Settings/Vault.md` names what the suite expects in a user's notes, in one place. Engine,
Curator, the Obsidian plugin, the installer and tool descriptions read names from it
instead of writing them as literals. The defaults are the names the suite used before the
map existed, so an install that never touches it behaves as before.

| Group | Keys (default) |
| --- | --- |
| Kinds of notes | `projectType` (`project`), `taskType` (`task`), `meetingType` (`meeting`), `personType` (`person`), `companyType` (`company`), `journalType` (`note`), `topicType` (`topic`), `wikiType` (`wiki`), `transcriptType` (`transcript`), `dailyNoteType` (`daily-note`); `entityTypes` (empty): the kinds whose notes memories can be about (#554); empty means the person, company and project kinds above, a list replaces them (`[person, company, project, pet]` adds pets), `[]` is none; read it with `entityKinds`; `ownerNote` (empty): your own person note, never made a memory's subject except by your own edit |
| Fields | `dueField` (`due`), `dateField` (`date`), `peopleField` (`people involved`), `companyField` (`company`), `priorityField` (`priority`), `scheduledField` (`scheduled`), `wikiFlagField` (`wiki`, the "make a wiki" flag) |
| Project status | `projectStatusField` (`status`); `projectActiveStatuses` (`open`, `in-progress`), `projectDoneStatuses` (`done`), `projectBlockedStatuses` (`blocked`), `projectBacklogStatuses` (`backlog`), `projectIgnoredStatuses` (`dropped`) |
| Task status | `taskStatusField` (`status`); `taskActiveStatuses`, `taskDoneStatuses`, `taskBlockedStatuses`, `taskBacklogStatuses`, `taskIgnoredStatuses` (same defaults); `taskTickStatus` (`done`) and `taskUntickStatus` (`open`), the values ticking and unticking a task writes |
| Folders | `wikiDir` (`Wikis`), `topicDir` (null: the topic kind's own folder), `transcriptDir` (`Transcripts`) |

The settings and attachments folders and the type key (the frontmatter key that holds a
note's types) are set at install (`VAULT_SETTINGS_DIR`, `VAULT_ATTACHMENT_DIR`,
`VAULT_TYPE_KEY`), so they are not keys here: `get-settings` reports them as
`settingsDir`, `attachmentDir` and `typeKey` beside the domains, and `Settings/Vault.md`
lists them. A client reading note frontmatter itself reads types from `typeKey`
(`types` from an Engine that does not report one).

### None

Every kind and field (`VAULT_KIND_KEYS`, `VAULT_FIELD_KEYS`) is `string | null`. Null is
**none**: the vault has no such kind or field, and whatever depends on it is off. A
consumer must:

- skip the dependent work when the name is null: no query, no write, no prompt example;
- never put the default name in its place (`value ?? 'project'` is the bug the map exists
  to remove; a missing *payload* may fall back to defaults, a null *value* may not);
- refuse with a plain message when a user asks for the feature directly (Engine's
  `wiki-write` with `wikiType: null` answers "Wiki pages are off: wikiType is none").

Status lists may be empty (nothing has that meaning). Tick/untick values, `wikiDir` and
`transcriptDir` are never null. `topicDir` keeps its own null meaning (the kind's folder).
A List view shows its task checkbox only when ticking can work: `taskTickStatus` is one of
`taskDoneStatuses`, `taskUntickStatus` is not, and a status field the view knows is an enum
takes both; otherwise each task shows its status.

In `Settings/Vault.md` none is an empty value (`projectType:`). Through `update-settings`
on the `vault` domain, `null` sets a kind or field to none; to restore a vault default, send
the default value (or delete the line in `Settings/Vault.md`). Every other domain keeps its
meaning of `null`: reset to the default.

### Reading it

- **Over MCP (Curator, plugin, installer, chat):** call `get-settings` (no domain, or
  `domain: 'vault'`) and pass `data.domains` to `vaultSettingsFrom(domains)`. It returns a
  complete `VaultSettings`: a missing or malformed value falls back to its default, null
  stays null, and an Engine older than the map is read through the old wiki and curator
  keys it still reports.
- **Inside Engine:** `getVaultSettings(db)` (`src/settings/vault.ts`) or
  `SettingsService.vault()`. Engine's wiki code reads `getWikiConfig(db)`, which is the
  wiki domain and the vault map merged (`WikiSettings & VaultSettings`).
- **Inside Curator:** `EffectiveSettings.vault` from `CuratorSettingsClient`, carried into
  the run config as `config.vault` (read with `vaultOf(config)`; `projectTypeOf(config)`
  for the project kind).

### Old keys are aliases

The names used to live in the wiki and curator domains. `VAULT_ALIASES` maps each old key
one to one onto a vault key: `wiki.projectType`, `taskType`, `meetingType`, `personType`,
`companyType`, `wikiType`, `dueField`, `peopleField`, `companyField`, `wikiDir` keep their
names; `wiki.statusField` → `taskStatusField`, `wiki.statusOpen` → `taskActiveStatuses`,
`wiki.statusDone`/`statusBlocked`/`statusIgnored`/`statusBacklog` → the task lists;
`curator.topicDir` → `topicDir`, `curator.projectStatusField` → `projectStatusField`,
`curator.activeStatuses` → `projectActiveStatuses`.

The vault domain is the only store. Old readers and old habits keep working unchanged:

- `get-settings` reports each vault value under its old name in the old domain's
  `effective` (and its stored deviation in `stored`).
- `update-settings` through an old key writes the vault key; `null` there resets it, as it
  reset the old key.
- The wiki and curator notes no longer show the old keys (#746, the owner's choice). A
  line with an old name that shows the vault map's own value (the mirror notes carried
  before) is dropped from the note without a word; one that differs is not read, is
  reported naming its vault key, and stays as typed. The first note of each lists the old
  names under "Set in Vault.md". An Engine rolled back to a release before #746 reads
  `Settings/Wiki.md` as a snapshot that includes those lines, so their absence would reset
  the vault keys to their defaults there.
- The registry's own `validateDomainPatch` does not know aliases; Engine resolves them.

At each Engine start, stored values under the old keys move to the vault domain (normally
only on the first start after the upgrade, or after a rollback stored them again). On the
first start, each project status list without an old key of its own starts as a copy of the
task list that used to serve both. Curator's `CURATOR_ACTIVE_STATUSES` and
`CURATOR_PROJECT_STATUS_FIELD` still seed a never-seeded curator domain through the old keys.

Engine reports each designated kind or field that no note in the vault has as a
`SETTINGS_NOT_IN_VAULT` issue of the vault domain (kinds and fields the suite creates on
first use, `VAULT_SELF_CREATED_KEYS`, are not checked).

## Model providers

`MODEL_PROVIDERS` lists the providers a `Settings/Models/` catalog entry can name, and
`PROVIDERS` records each one's wire API (`openai-compat` or `anthropic`), base URL, key
variable, output-token request field (`max_completion_tokens` for OpenAI, `max_tokens`
for the rest) and whether its chat API takes PDF input. Engine, Curator, chat, the Obsidian plugin and the installer all read this
table, so a new provider is added here first. The SDK clients live in `@vault/llm`.

## Usage

```ts
import {
  defaultsFor,
  effectiveSettings,
  validateDomainPatch,
  type ChatSettings,
} from '@vault/settings-registry';

const defaults = defaultsFor('chat');
const result = validateDomainPatch('chat', {
  maxSteps: 12,
  defaultModel: '[[Claude Sonnet 4.6]]',
});

if (result.issues.length === 0) {
  const effective = effectiveSettings<ChatSettings>('chat', result.valid);
  console.log(effective.maxSteps);
}
```

Model references use catalog-note titles rather than raw provider IDs:

```ts
import { normalizeModelRef, resolveModelRef } from '@vault/settings-registry';

normalizeModelRef('[[Claude Sonnet 4.6]]'); // 'Claude Sonnet 4.6'
const entry = resolveModelRef(catalog, '[[Claude Sonnet 4.6]]');
```

Disabled catalog entries do not resolve.

## Public API groups

| Area | Main exports |
| --- | --- |
| Descriptor model | `SettingsDomain`, `ReloadClass`, `SettingType`, `SettingDescriptor`, `SettingIssue` |
| Registry | `DOMAINS`, `SETTINGS_REGISTRY`, `descriptorsFor`, `defaultsFor` |
| Validation | `validateValue`, `validateDomainPatch`, `effectiveSettings`, `deviationsOnly` |
| Environment seeding | `seedFromEnv`, `staleEnvVars` |
| Model catalog | `ModelProvider`, `ModelCatalogEntry`, `normalizeModelRef`, `resolveModelRef`, `SEED_MODELS`, `FALLBACK_MODELS`, `FALLBACK_ENTRY` |
| Domain types | `EngineSettings`, `WikiSettings`, `ChatSettings`, `CuratorSettings`, `VaultSettings` and each descriptor array |
| Settings notes | `SETTINGS_GROUPS`, `SettingsNote`, `settingsNotesOf`, `settingsNoteOfKey`, `settingsNotePath`, `settingsNoteTitle`, `settingsNoteLabel`, `settingsNotesForKeys`, `settingsNoteForIssue`, `settingsDomainTitle` |
| Vault map | `vaultSettingsFrom`, `VAULT_KIND_KEYS`, `VAULT_FIELD_KEYS`, `VAULT_SELF_CREATED_KEYS`, `VAULT_ALIASES`, `vaultAliasFor`, `vaultAliasesOf`, `vaultAliasValues` |

`deviationsOnly()` is the storage-normalization seam: values equal to defaults are
removed, and model references compare after wikilink normalization. This keeps stored
settings as explicit deviations instead of copies of every default.

## Adding or changing a setting

1. Edit the owning descriptor file under `src/domains/`.
2. Update its exported domain interface in the same file. For a Curator or Engine key,
   add it to its group in `src/notes.ts`.
3. Choose the narrowest correct type, default, and reload class.
4. Add an `envSeed` only for a deliberate first-boot migration or bootstrap path.
5. Add validation/default/seed coverage in `tests/`.
6. Update the owning service's README and generated-note expectations.

Do not add service orchestration, file I/O, provider clients, or persistence to this
package. Contextual checks that need the live model catalog belong at the Engine
settings-service boundary in addition to the structural checks here.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/domains/` | Domain descriptors, defaults, and strongly typed effective shapes |
| `src/types.ts` | Shared descriptor and issue types |
| `src/registry.ts` | Combined registry and domain lookup/default helpers |
| `src/validate.ts` | Structural validation, effective settings, and deviations-only storage |
| `src/seed.ts` | Pure first-boot environment parsing and stale-env detection |
| `src/models.ts` | Model-catalog types, references, seeds, and fallbacks |
| `src/vault.ts` | Reading the vault map from a get-settings payload, and the alias helpers |
| `src/notes.ts` | Which settings note shows each key, and the notes' paths |
| `tests/` | Domain, validation, seed, and model regression coverage |

## Development

```bash
npm run typecheck -w @vault/settings-registry
npm run build -w @vault/settings-registry
npm test -w @vault/settings-registry
```

Changes usually affect Engine and/or Curator, so run the owning service's focused
settings tests as well.

## License

MIT
