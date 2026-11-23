# Vault Installer

`vault-installer` is the terminal installer for Vault Engine and Vault Curator. It walks a
user from a Linux machine or an Apple Silicon Mac ([On macOS](#on-macos)) and a folder of
Markdown to both services running.

> **Status:** in progress. `vault-installer plan` runs the read-only stages (preflight,
> vault, structure, providers and models, backup choice) and ends with the review of what
> installing would do. `vault-installer install` asks the same questions and, once you
> approve the review, writes the configuration, backs up the vault, starts Engine as a
> systemd service, gives your notes their types, applies the settings (asking before it
> turns on paid attachment extraction), starts Curator, verifies the result, and hands
> off: it writes `PUBLIC-ACCESS.md`, offers to add the Obsidian plugin, revokes its own
> tokens, and shows how to connect an AI client and what to try first. `vault-installer status`
> runs the same checks at any time. `vault-installer undo` reverts what organizing changed
> in the notes, and `vault-installer uninstall` removes the services so you can start over.

## What it looks like

Run interactively, the installer is a guided walk-through:

- A **welcome screen** says what Vault is, lists the steps, and shows the keys to use
  (arrow keys, Space, Enter, Ctrl+C to quit). Quitting `plan`, or `install` before you
  approve the plan, changes nothing, apart from a new notes folder you agreed to create;
  after approval, run `install` again to pick up where it stopped. It then offers **Quick
  setup (recommended)**, which asks only for the notes folder and one AI key (see
  [Quick setup](#quick-setup)), or **Choose everything**.
- Each step opens with a **step map** (`●━━━●━━━◉───○`) showing where you are, a heading,
  and one or two plain sentences on what the step is for. Setup has eight steps: check this
  computer, choose your notes folder, sort your notes into kinds, connect AI services, set
  up Curator, choose AI models, back up your notes, and review the plan. Once you approve,
  installing has its own map: save the configuration, back up, start Engine, organize your
  notes, apply settings, start Curator, check everything works, and finish.
- The **notes step opens with one screen**: what Vault found in your notes, in plain words
  (see [Structure planning](#structure-planning)). **Looks good** takes it with no further
  question; **Adjust** goes through the step's questions and shows the screen again.
- Check results are colored (`✓` passed, `▲` worth noting, `✗` a problem), the notes
  folder question offers your Obsidian vaults and suggests folders as you type, and a
  finished install ends with a summary box. An interrupted install shows a progress bar of
  what is already done.

With `--answers` (or no terminal), each step is one plain line such as
`[Setup 4/8] Connect AI services`, so logs stay readable.

## Plan an installation

From a built checkout (`npm ci && npm run build` at the repository root):

```bash
node packages/installer/dist/cli.js plan
```

With Choose everything ([Quick setup](#quick-setup) asks less), the interactive run asks
for the vault folder and which folders to leave out. It offers the vaults Obsidian has
opened on this computer, most recent first, read from Obsidian's `obsidian.json` (under
`$XDG_CONFIG_HOME/obsidian` or `~/.config/obsidian`, or the same file in a Flatpak or Snap
install); "Somewhere else" asks for a folder. A typed folder that does not exist yet can be
created: the installer asks first, then whether to start it empty or with the messy sample
(about 150 made-up notes exported from three apps, none sorted, to try the sorting on; see
`examples/README.md`). That new folder is the one thing `plan` can create. A folder with no
Markdown files plans with every kind none. With `--answers`, the folder must already exist,
unless `vault.sample` asks for a new one. It then asks where Engine's settings notes, wiki pages, and
Curator's topic notes should go, offering `Settings/`, `Wikis/`, and `Topics/` (or another
name, saying why, when the vault already has a folder of that name or left it out). It
then shows the structure and the vocabulary map it detected from the notes, to take as
found or adjust, asks for provider keys and models and Curator's budget and schedule, and
prints:

- **Preflight:** operating system, running user (not root), Node.js version (must match
  `.nvmrc`), systemd and sudo (on macOS, Apple Silicon and a login session for launchd), repository build, stray `.env` files the services would also
  read (`packages/engine/.env` in the checkout, `.env` in the data directory), memory,
  disk, ports 3334 and 3335, Hugging Face reachability, and any existing installation.
- **Vault:** Markdown and other file counts, top-level folders, likely type fields from
  [Vault Analyzer](../engine/README.md#vault-analyzer), and warnings: an existing
  `.vault-engine/`, sync clients, or low disk. In a synced folder (Dropbox, Google Drive,
  OneDrive, iCloud Drive, Nextcloud, pCloud, Syncthing), Engine's database and search
  model cache go in the data directory instead (`DB_PATH`, `EMBEDDER_MODELS_DIR`).
- **Structure:** the types and fields that adoption would create, from one of four
  sources: a frontmatter field, folders, both (the field wins; folders fill the gaps), or
  none; and the vocabulary map: which type holds each kind of note, each status field and
  what its values mean, and what each "none" turns off. See
  [Structure planning](#structure-planning).
- **Provider keys, Models, and Curator:** each key and how it was checked, the model for
  every model setting, prices, the daily cap, and the sweep schedule. See
  [Providers and models](#providers-and-models).
- **Review:** interactively, the plan in short first, in about a dozen lines: how many
  notes get a type and under which key (and whether a key is added to them), that Engine
  rewrites the top of each note it changes, the kinds and status fields designated and
  what each none turns off (and, next to the task status field, when List views show no
  checkbox because it has no done or open value), the types and fields created beyond
  the notes' own (only those you picked), where the backup goes, which services run in
  the background and start at boot, the most Curator spends a day (attachment reading is
  asked about separately), and how many commands run with `sudo`. **Show every file and
  command?** (default no) then shows everything installing would do, in one place: the
  services and the command each runs, each file it writes, each `sudo` command in the
  order it runs, which keys go into which env file (by name), the backup and the vault
  changes, the settings it applies, and when paid calls can start. A headless run
  (`--answers`) always prints every detail and no summary, so its log is complete;
  `--json` and `--out` are the whole plan either way.

Exit status is `0` when the plan completed with no failed check, `1` when a check failed
(installing here would not work), `2` for invalid arguments or answers, and `130` when
cancelled.

### Quick setup

After the welcome screen, an interactive run asks **Quick setup (recommended)** or
**Choose everything**. Choose everything is the walk-through this README describes. Quick
setup asks for the notes folder, one AI key, and, for `install`, the approval. Everything
else takes the default a headless run takes, and each step says in one line what it took:

- **Folder:** top-level template folders are left out; Engine's settings, wiki pages, and
  topic notes go in `Settings/`, `Wikis/`, and `Topics/`.
- **Notes:** the map detected from the notes ([Structure planning](#structure-planning))
  is shown with no question. Kinds, status lines, and the other field names are what the
  notes have, and none where they have nothing; no kind is created. One default differs
  from a headless run: when no line in the notes says what kind they are, they stay
  without kinds instead of being sorted by their top-level folders, which would write a
  kind into every note there. Tags are taken as in a headless run: a note whose `#tag`
  names a usual kind gets that kind.
- **Keys:** "Which AI service do you have a key for?" offers Anthropic, Fireworks,
  OpenRouter, and OpenAI, then "More than one…" (tick each service, Gemini, Deepgram, and
  Exa among them) and "None for now". Each key is asked as in the full step: from this
  computer's environment or pasted, and checked with a free request.
- **Curator, models, backup:** Curator is installed when there is a model key, with a
  $1.00 daily cap, its sweep at 05:00 in this machine's time zone, and the wikis you
  create kept current; the balanced preset, with the first image reader the keys allow;
  and a copy of the Markdown notes.

Only what no default settles interrupts: kind names that differ only by case, a type line
the Analyzer refuses, a usual folder the vault already has (or leaves out), a failed check
of this computer (`install` stops), and a key the provider refuses (asked again).

The review is the full one. Declining to install offers **Adjust the kinds of notes**: the
notes step's questions and map, then the review and the approval again. To choose every
other answer, run the installer again and pick Choose everything; keys are never saved, so
nothing carries over. Headless runs (`--answers`) never see the choice and are unchanged.
Quick setup's questions use the ids of the full flow, plus `providers` for which service a
key is for, which an answers file states by its `providers.*` entries.

### Options

| Option | Meaning |
| --- | --- |
| `--answers <file>` | Answer every question from a JSON file (headless) |
| `--yes` | `install`: approve the review, or continue a saved install, without asking. `undo`, `uninstall`: go ahead without asking |
| `--no-sudo` | `install`, `uninstall`: print the root commands for you to run instead of running them with `sudo` |
| `--engine-port <port>`, `--curator-port <port>` | Ports for the services; default 3334 and 3335 |
| `--json` | `plan` only: print the plan as JSON on stdout; progress goes to stderr. Requires `--answers` |
| `--out <file>` | `plan` only: also write the plan as JSON to a file |
| `--data-dir <dir>` | Where the services will keep state; default `~/vault-suite-data` |
| `--repo <dir>` | Vault Suite checkout to use; default is the one the installer runs from |
| `--skip-network-check` | Do not probe Hugging Face or check provider keys |

### Structure planning

The structure stage runs [Vault Analyzer](../engine/README.md#vault-analyzer) on the
chosen type source and then settles the points below. Interactively it first settles
every one of them as a headless run with no structure answers would (`detectStructure`)
and opens with **one screen** that states the result in plain words, from your own notes:
the line (or folders) that says what kind a note is; the kinds found, with their note
counts (the longest lists end with "and N more"); which kinds Vault treats as projects,
tasks, meetings, people, and companies, each with what Vault does with it or, for none,
what is off; the status line of projects and of tasks and what its values mean; the other
lines Vault reads; Curator's journal kind; and the folders chosen in the step before.
**Looks good** takes all of it. **Adjust** asks the questions below, each starting from
what was detected, then shows the screen again. Only two things interrupt before the
screen, since no default can answer them: kind names that differ only by case, and how
notes are typed when the Analyzer refuses the detected type field or folders (then the
type source and the refused question are asked, and the rest still takes its default).
A headless run has no screen and answers the questions from the answers file.

- **Takes #tags as kinds** (#650). After the type line and folders are chosen, the tags on
  notes the type line leaves without a kind are offered (at most 20, most notes first, each
  on at least two notes): "Which tags say what kind of note it is?" A tag naming a usual
  kind (meeting, project, task, person, book…) or a kind the notes already have starts
  ticked, and a run that takes the defaults (headless, quick setup) takes those; `#todo`
  or `#important` start unticked. A ticked tag's kind is the tag in the singular, or the
  kind it names whatever its case. A note gets the kind of every ticked tag it carries,
  ahead of its folder, and the tag stays in the note. Typed by tags alone, the plan's
  source is `tags`.
- **Resolves type names that differ only by case** (`Meeting` and `meeting`) by asking
  which name they share, and lets you rename, merge, or drop any proposed type. Dropping
  every proposed type leaves the notes without types.
- **Designates the kinds.** Engine's project tooling, wikis, and Curator look for
  projects, tasks, meetings, people, and companies. Each kind is detected by its type's
  name and follows your renames; with no such type it is **none**, and what depends on it
  is off (the review says what). Each can be changed to another type, to none, or to a
  new (starter) type under any name you give. Nothing is created for a kind unless you
  ask: a default install creates no `project` type. A new type whose name differs from
  an existing type only by case uses that type instead.
- **Designates the status fields**, separately for projects and for tasks. Each starts
  from a text field named like a status (`status`, `state`, `stage`, `phase`), preferring
  one the kind's type has; the type then claims it. With none found it is none: the
  kind's status lists stay empty (Curator counts every project as active; wikis cannot
  tell open tasks from finished ones). A new status field (an enum of `open`,
  `in-progress`, `blocked`, `backlog`, `done`, `dropped`) is added only when chosen; a new
  type you asked for starts with one. For each status field it asks which values mean
  active (open, for tasks) and groups the others as done, blocked, backlog, or dropped.
  When the field has more values than the Analyzer samples, other values can be typed in.
- **Designates the other field names**: due date (`dueField`), date (`dateField`), people
  (`peopleField`), company (`companyField`), priority (`priorityField`), and scheduled date
  (`scheduledField`). Each is a line the notes have, found by name (`due`, `due date`,
  `deadline`; `date`, `meeting date`; `people involved`, `people`, `attendees`,
  `participants`; `company`, `organization`, `org`; `priority`, `prio`; `scheduled`,
  `scheduled date`, `do date`; ignoring case, spaces, `_` and `-`), or none. A new type's
  own fields count as present. A field the notes lack is none, so Engine does not report
  its default name as missing from the vault.
- **Designates the journal kind**: the kind of the notes Curator's monthly journal writes.
  A type named `note` (in any case) is offered first, else a new `note`. Interactively it
  is on the notes step's screen (asked under Adjust, before Curator is chosen); headless,
  the Curator step asks it, only when Curator is installed. A new kind is not created by
  the install: Curator creates it when it first writes its journal. Without Curator, the
  journal kind is none.
- **Resolves fields that need review.** A field whose values have more than one shape
  (the screen says "used in more than one way") stays unmanaged by default: its values
  are preserved as they are, and Vault does not check or sort them. It can instead be stored
  as text, or in its most common shape (such as a list of links), each offered only when
  Vault Analyzer finds that every value converts under Engine's rules. The choice is
  part of the plan, so the field is created and claimed like any other.
- **Makes the type field Engine's type key.** The frontmatter field that says what kind
  of note each one is becomes the key Engine reads and writes types in (`VAULT_TYPE_KEY`
  in `engine.env`), so notes keep `type: meeting` or `kind: meeting` and get no second
  `types` key. With folders or starter types only, the key is Engine's default, `types`.
  The key is set for good at install: Engine refuses to start with a different one.

A new type has only optional fields with no defaults: projects `due`, `people involved`,
`company`; tasks `due`, `project`; meetings `project`, `people involved`, `date`; people
`company`; plus its kind's status field. It reuses a field of the same name your notes
already have, and skips a field whose shape in your notes needs review.

The settings stage writes the map to Engine's `vault` settings domain (`Settings/Vault.md`,
see [the vault map](../settings-registry/README.md#the-vault-map-vault-domain)): the
five kinds and the journal kind, both status fields with their active, done, blocked,
backlog, and dropped lists, the tick values for tasks (taken from the task statuses; with no
done or no usable open value none is written, and the review says a List view shows no task
checkbox), the
six other field names, the wiki folder, and, with Curator, the topic folder. A none is
written as an empty value, so Engine's default name does not stay in force.

### Providers and models

Every key is optional; Curator and chat need at least one of Anthropic, Fireworks,
OpenRouter, or OpenAI. Interactively, the step first shows where to create each key and
what costs money: checking a key is free, and nothing paid runs until Curator's daily cap
and the attachment question later. Then one tick-list asks which services you have a key
for, each line saying what the service adds. Keys already in the installer's environment
(for example `ANTHROPIC_API_KEY`) start ticked. Only the ticked keys are asked for: a key
in the environment can be used as it is, or a key can be typed in, masked, or skipped. If
none of the four model services is ticked, the installer says what won't work and offers
the list again. A headless run has no tick-list: the answers file's `providers` entries
name the keys.

Each key is checked with a free request that needs a valid key (a model or project
listing), never a paid call. A refused key is asked for again. A key that cannot be
checked is kept with a warning. Exa has no free endpoint, so its key is not checked.

| Provider | Unlocks | Env written | Create a key |
| --- | --- | --- | --- |
| Anthropic | Claude models; memory consolidation; Claude image and scanned-PDF vision | `ANTHROPIC_API_KEY` for Engine and Curator | <https://platform.claude.com/settings/keys> |
| Fireworks | Fireworks models; memory consolidation; image vision | `FIREWORKS_API_KEY` for Engine, `OPENAI_COMPAT_API_KEY` for Curator | <https://app.fireworks.ai/settings/users/api-keys> |
| OpenRouter | OpenRouter models; memory consolidation; image vision | `OPENROUTER_API_KEY` for Engine and Curator | <https://openrouter.ai/keys> |
| OpenAI | OpenAI models (GPT-6.1 Terra and GPT-6 Luna offered); memory consolidation; image and scanned-PDF vision | `OPENAI_API_KEY` for Engine and Curator | <https://platform.openai.com/api-keys> |
| Gemini | Image vision and scanned-PDF text | `GEMINI_API_KEY` for Engine, unless image vision is off | <https://aistudio.google.com/apikey> |
| Deepgram | Audio transcription | `DEEPGRAM_API_KEY` for Engine | <https://console.deepgram.com/signup?jump=keys> |
| Exa | Web search | `EXA_API_KEY` for Engine | <https://dashboard.exa.ai/api-keys> |

Engine extracts attachments, a paid call, as soon as it starts if it has a key that can
read them. So `engine.env` also sets `EXTRACTION_ENABLED=false`, which Engine reads on its
first start to turn its `extractionEnabled` setting off. Engine then has every key from the
start, and extraction waits until you approve it after adoption. With image vision off,
Engine does not get a Gemini key, since its default vision provider is Gemini. A vault
Engine already manages ignores the seed and keeps its stored settings. There, a key that
could extract is added only after the installer turns `extractionEnabled` off through
`update-settings` (`plan` shows this path; `install` does not take such a vault yet).

Models are chosen per role from presets (balanced, low cost) or one at a time (custom).
The roles are every model setting in the `engine`, `chat`, and `curator` settings domains.
The custom preset asks about the main ones: Curator writing, the three wiki roles, chat,
memory consolidation, and image vision. Other settings that need a model follow the
preset's lighter model; optional ones use Curator's writing model. Any provider's model
can fill any role, and image vision needs a vision model. A role whose
feature is off (no Curator, or images read by Gemini) is reported as off and left as it
is. Every offered model has a list price in `@vault/pricing`, because Curator's daily cap
refuses unpriced models. A model Engine does not create on first start is added to the
catalog with `add-model`.

Curator is installed by default when a model key exists. By default its daily cap is
$1.00, and its sweep runs at 05:00 in this machine's time zone. The sweep keeps the wikis
you create current. The memory, conversation, conversation-capture, and organization
sweeps are set off explicitly, including on a vault Engine already manages.

### Answers file

Every interactive question has an id that names one field of the answers file, so a
headless run follows the same flow:

```json
{
  "version": 1,
  "vault": {
    "path": "~/Notes",
    "exclude": ["Templates"],
    "settings_dir": "Vault Settings"
  },
  "structure": {
    "source": "both",
    "type_field": "type",
    "folder_rules": [{ "directory": "Meetings", "type": "meeting" }],
    "type_renames": { "Meeting": "meeting", "misc": null },
    "roles": { "project": "initiative", "task": { "starter": "action" }, "person": "contact", "company": null },
    "status_fields": { "project": "stage", "task": { "starter": "status" } },
    "active_statuses": ["live"],
    "task_active_statuses": ["open", "in-progress"],
    "fields": { "due": "deadline", "priority": null },
    "review_fields": { "due": "text", "owners": "dominant" }
  },
  "providers": {
    "anthropic": "env:ANTHROPIC_API_KEY",
    "fireworks": "env:FIREWORKS_API_KEY"
  },
  "models": {
    "preset": "custom",
    "vision_provider": "model",
    "custom_models": [
      { "title": "Kimi K3", "provider": "fireworks", "model": "accounts/fireworks/models/kimi-k3" }
    ],
    "roles": { "curator.model": "Kimi K3", "curator.wikiPageModel": null }
  },
  "curator": {
    "daily_budget_cents": 200,
    "sweep_at": "05:00",
    "tz": "America/New_York",
    "wiki_mode": "live",
    "journal_type": "note"
  },
  "obsidian": { "install_plugin": true },
  "backup": { "mode": "markdown" }
}
```

| Field | Question | When omitted |
| --- | --- | --- |
| `vault.path` | Which folder becomes the vault. It must exist, unless `vault.sample` asks for a new one | Required |
| `vault.sample` | Create `vault.path`, which must not exist yet: `empty`, or `messy` with the messy sample (about 150 made-up notes exported from three apps, none sorted; see `examples/README.md`) | Not created |
| `vault.exclude` | Folders to leave out | The interactive preselection: top-level template folders |
| `vault.settings_dir` | Folder for Engine's settings notes (`VAULT_SETTINGS_DIR`). It must not be inside a left-out folder or be another existing folder; `Settings` shares an existing `Settings/` | `Settings`, or `Vault Settings` when `Settings/` already exists or is left out |
| `vault.wiki_dir` | Folder for wiki pages and Curator's journal (the map's `wikiDir`). `Wikis` shares an existing folder. It must not be inside a left-out folder, be another existing folder, or overlap the settings folder | `Wikis`, or `Vault Wikis` when `Wikis/` already exists, is left out, or overlaps the settings folder |
| `vault.topic_dir` | Folder for Curator's topic notes (the map's `topicDir`, written only with Curator). `Topics` shares an existing folder. The same rules apply, and it must not overlap the wiki folder either | `Topics`, or `Vault Topics` as for the wiki folder |
| `structure.source` | `field`, `folders`, `both`, or `none` | `field` when a conventional key (`types`, `type`, `kind`, `entity`) exists, else `folders` when there are folders, else `none` |
| `structure.type_field` | The exact frontmatter key; it becomes Engine's type key (`VAULT_TYPE_KEY`). A key Engine writes in its own notes (such as `source` or `model`), or a field the plan may add itself (`status`, `due`, `date`, `project`, `company`, `people involved`), is refused, as is a field some note holds a mapping or nested list in, which Engine could not keep as types | The top-ranked candidate |
| `structure.folder_rules` | `{ directory, type }` rules; `type: null` leaves a folder untyped | Every top-level folder, named in the singular |
| `structure.tag_rules` | `{ tag, type }` rules (`tag` without the `#`; `type: null` leaves it out). A note the type line leaves without a kind gets the kind of every ruled tag it carries, inline or in its `tags` property, ahead of its folder; a nested tag counts under its parents. The tag stays in the note | The tags offered that name a usual kind (meeting, project, task, person, company, contact, book, recipe, journal, article, idea, event, call, interview, course, movie, trip, goal) or a kind the notes already have, named in the singular or as that kind |
| `structure.type_renames` | Proposed type name → new name, or `null` to drop it. With `source: both`, notes of a dropped field type inside a typed folder take that folder's type. Required to merge names that differ only by case | No renames |
| `structure.roles` | Kind (`project`, `task`, `meeting`, `person`, `company`) → a proposed type, `{ "starter": "<name>" }` for a new type under that name, or `null` for none. The kind's own name (`"project": "project"`) with no such proposed type also asks for a new type, as before. Two kinds cannot share one new type | Detected by name, else none |
| `structure.status_fields` | `project` and `task` → a text field the notes have, `{ "starter": "<name>" }` for a new status field, or `null` for none. A new field cannot take the name of a field your notes use for other values, of a new type's other fields, or of the type key | A text field named like a status; a new type starts with a new `status` field; else none |
| `structure.active_statuses` | Project status values that mean active. When the project status field is an enum (including a new one), each must be one of its values | Values such as `open`, `active`, or `in-progress` |
| `structure.status_groups` | Other project status values: `{ done, blocked, backlog, ignored }` lists. None may be active; with an enum field each must be one of its values | Detected by name (`done`, `complete`; `blocked`, `waiting`; `backlog`, `someday`; `dropped`, `cancelled`) |
| `structure.task_active_statuses` | Task status values that mean open; the same rules as for projects | As for projects |
| `structure.task_status_groups` | Other task status values, as for projects | As for projects |
| `structure.fields` | `due`, `date`, `people`, `company`, `priority`, `scheduled` → a field the notes have (or a new type adds), or `null` for none | Found by name, else none |
| `structure.review_fields` | A field that needs review → `unmanaged`, `text`, or `dominant` (its most common shape). `text` and `dominant` must be shapes every value converts to | Every such field stays unmanaged |
| `structure.remove_type_field` | Accepted for older answers files and ignored: the type field is the type key, so there is nothing to remove | `false` |
| `providers.<provider>` | A key, as `env:NAME`, for `anthropic`, `fireworks`, `openrouter`, `openai`, `gemini`, `deepgram`, or `exa`. Literal keys are rejected. The entries given stand for the interactive tick-list (`providers`), which has no field of its own | No key |
| `models.preset` | `balanced`, `low-cost`, or `custom` | `balanced` |
| `models.vision_provider` | `gemini`, `claude`, `model`, or `off`; only those the keys allow | The first of those the keys allow |
| `models.custom_models` | With `custom`: extra `{ title, provider, model }` catalog models (from any of the four model providers) that have a known list price. A title must be one add-model keeps as written (no `\ / : # ^ \| [ ]`, single spaces) and unused by any seed model | None |
| `models.roles` | With `custom`: role (`curator.model`, `curator.wikiPlanningModel`, `curator.wikiHomeModel`, `curator.wikiPageModel`, `chat.defaultModel`, `engine.memoryConsolidationModel`, `engine.visionModel`) → model title, or `null` for a wiki role to use Curator's writing model. A role that is off is ignored with a warning | The balanced preset's choice |
| `curator.install` | Whether to install Curator | `true` when a model key exists |
| `curator.daily_budget_cents` | Daily cap in US cents, at least 1. The installer always sets a cap; to remove it later, clear `dailyBudgetCents` in `Settings/Curator/General.md` | `100` |
| `curator.sweep_at` | Daily sweep time, `HH:MM` | `05:00` |
| `curator.tz` | IANA time zone for the sweep and the cap | This machine's time zone |
| `curator.wiki_mode` | What the sweep does with wikis you create: `live`, `dry-run`, or `off` | `live` |
| `curator.journal_type` | The kind of Curator's journal notes: a type the notes have, or a new name Curator creates when it first writes. It must not differ from an existing type only by case. Used only when Curator is installed | A type named `note` in any case, else `note` |
| `extraction.approve` | Turn on paid attachment extraction after adoption | `false` |
| `obsidian.install_plugin` | In an Obsidian vault, add the Vault Engine plugin, connected, when the install finishes. A plugin folder already there is never replaced headless | `false` |
| `backup.mode` | `markdown` (the notes), `full` (every file), or `skip` | `markdown` |

Unknown fields are rejected. Keys are referenced as `env:NAME`, never written into the
file, and never appear in the plan, its JSON, or the terminal. The answers file is still
version 1: the designation fields were added beside the older ones, and every older file
still loads. What it plans by default changed, though: a kind the notes do not have is
none rather than a starter `project`, no `note` type or `status` field is created, the
folder answers are used even when no folder of the usual name exists, and the other field
names (`structure.fields`) are found by name or none instead of keeping Engine's
defaults.

## Install

```bash
./install.sh                       # from the repository root; or, once built:
node packages/installer/dist/cli.js install
```

`install.sh` runs `vault-installer`, passing its options on (`install` when no command is
given). Before that it:

1. Checks for Linux or macOS. Before an install, it also stops when systemd is not
   running (on macOS, when `launchctl` is missing) and warns when it runs as root. On
   macOS it stops when Node.js is not the arm64 build. The installer's preflight checks
   these again.
2. Checks for the Node.js version pinned in `.nvmrc` and npm. On a wrong or missing
   Node.js it stops. For each of mise, nvm, and fnm it finds, it prints the exact command
   that switches and runs `install.sh` again with the same options. It never installs
   Node.js itself.
3. Before a fresh install on the default ports and data directory, stops when port 3334
   or 3335 is in use. A saved install, `--data-dir`, or other ports are left to the
   installer. It warns when the checkout has less than 2 GB free.
4. Runs `npm ci` (with `SHARP_IGNORE_GLOBAL_LIBVIPS=1`) when dependencies are missing,
   older than the lockfile, or built for another Node.js, and builds. It prints one
   "Preparing" line instead of their output, which goes to a temporary log
   (`vault-install.*` in `$TMPDIR`, or `/tmp`). When a step fails it shows the log's
   last 40 lines and its path; otherwise it removes the log.

The services run on the Node.js binary that ran the installer.

The `vault-installer` command exists only inside the workspace, not on your PATH. So
`install.sh` passes its own path in `VAULT_INSTALLER_COMMAND`, and every message that
says what to run next names it by its full path (`<checkout>/install.sh status`), with
`--data-dir` when the install uses another data directory. Started any other way,
including from source, the messages name `node <checkout>/packages/installer/dist/cli.js`.

`install` asks the planning questions, shows the same review (the plan in short, then
every file and command if you ask), and changes nothing until you approve it: **Ready?
Install Vault with this plan?** defaults to no. With `--no-sudo` the summary says the root
commands are yours to run. A headless run (`--answers`) needs `--yes` to approve; without
it, the run prints the full review and stops. After approval it applies the stages this version has:

1. **Configure.** Creates the data directory (`0700`) and writes, each `0600` and never
   over an existing file:
   - `engine.env`: the vault path, database path (and, in a synced folder, the search
     model cache, `EMBEDDER_MODELS_DIR`), settings folder, the type key when notes are
     typed by a field other than `types` (`VAULT_TYPE_KEY`), a generated owner password,
     `OAUTH_ISSUER_URL=http://localhost:3334`, and Engine's keys. Two variables are read on
     Engine's first start only and removed once it has started: the first exclusions
     (`VAULT_EXCLUDE_DIRS`), and `EXTRACTION_ENABLED=false` when a key could start paid
     extraction.
   - `curator.env` (when Curator is installed): Engine's URL (`http://127.0.0.1:<port>`,
     since Engine listens on IPv4 loopback only), Curator's port and database, its own
     owner password, and Curator's keys. `ENGINE_TOKEN` is added once Engine has
     minted it.
   - `installer/units/vault-engine.service` and `vault-curator.service`, staged for
     `sudo install`. Each runs as you, from the data directory, on the Node.js binary the
     installer runs on, with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, and
     `UMask=0077`.

   The owner passwords are 43 random characters. The installer never prints them; it ends
   with the command that shows each one, for signing in an OAuth client.
2. **Backup.** Copies the vault's Markdown (or, by choice, every file) into
   `installer/backups/<time>/vault/`, with `manifest.json` listing each file's size and
   SHA-256. Symlinks and Engine's `.vault-engine/` are left out. The vault is only read.
   Skipping the backup needs `"backup": { "mode": "skip" }` in an answers file, or typing
   `skip backup`.
3. **Engine.** Installs `vault-engine.service` and starts it with these root commands,
   each shown before it runs through `sudo`:

   ```bash
   sudo install -m 0644 <data>/installer/units/vault-engine.service /etc/systemd/system/vault-engine.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now vault-engine.service
   ```

   With `--no-sudo` the installer prints them for you to run. Interactively, it then
   waits for you to confirm; headless, it stops and continues when run again. Without a
   terminal, sudo never waits for a password (`sudo -n`). A unit that is already
   installed, enabled, and running with the staged content is left alone. An installed
   unit that differs is replaced only after you confirm.

   The installer then waits for `GET /mcp` to answer: Engine indexes the vault before it
   listens. While it waits, it shows how long it has waited and what Engine's log says it
   is doing: on a vault that takes more than a few seconds, Engine logs how many notes it
   has indexed every five seconds (`Indexing: 1200 of 5000 notes`), and then that it is
   finishing its startup. Until Engine logs a count, or when its log cannot be read, the
   installer shows an expected time from the note count instead. A headless run prints
   this as a line every 30 seconds. The search model is not part of the wait: Engine
   starts downloading it in the background just before it answers. If the service stops
   or restarts meanwhile, the installer shows its last log lines. Once Engine answers, the
   installer:
   - Mints two tokens with Engine's token script. The installer's own token, valid for one
     day, goes into `installer/installer.env`. Curator's token is added to `curator.env`
     as `ENGINE_TOKEN`.
   - Removes `VAULT_EXCLUDE_DIRS` from `engine.env`, since Engine has seeded its
     exclusions, unless you have edited the file.
   - Reads `vault-stats` over MCP as a check.
4. **Adoption.** Applies the approved structure over Engine MCP with the installer's
   token. Vault Analyzer first checks the notes again with the approved rules, and the
   result (each note's types and each vault field's definition) is saved in
   `installer/state.json` before anything is written. A rerun after a partial adoption
   uses that saved result instead of checking notes adoption already changed. Then the
   installer:
   - Creates each global field (the vault's, then the starter fields) and each type, with
     its claims and default folder. A field whose type you chose is claimed after its type
     exists, so Engine converts its values on notes that already have the type. A field or type Engine already has is skipped when it
     matches the plan and stops the run when it differs, including when it is required or
     has a default, which Engine would write into notes.
   - Reads Engine's notes and compares each note's indexed types with the types the rules
     give it now. Missing types are added. With a type field, which Engine indexed as its
     type key, values the plan renamed, merged, or dropped are removed, as is another
     spelling of a note's final type
     (with spaces around it, or as a wiki-link). Other values stay, as do Engine's own
     notes in the settings folder and the excluded folders. A note added or moved after
     the check is left as it is and reported. Dropping every type still removes the
     dropped values.
   - Sends the changes in batches of 200 notes through `update-node` in query mode. Every
     batch is dry-run first; if Engine would refuse any note, nothing is applied.

   Engine rewrites each note it changes in its standard frontmatter layout, with the type
   key first, keeping values and bodies. Each Engine undo operation is saved in
   `installer/state.json`; for 24 hours `vault-installer undo` reverts them (see
   [Undo organizing](#undo-organizing)), and the backup covers anything older.

   If the notes changed after you approved the plan (Engine's startup link repair also
   rewrites some), adoption uses what they say now but creates only the approved types and
   fields. Notes that now carry a type outside the plan go without it, and a field that
   now needs review stays unmanaged. Both are reported.
5. **Settings.** Adds the planned models Engine's catalog lacks (`add-model`), then
   applies every approved setting through Engine with one `update-settings` per domain:
   model roles, Engine's vision provider, the vocabulary map through the `vault` domain's
   own keys (each none as null), and Curator's budget, schedule, wiki mode, and optional
   sweeps. Engine serves the curator domain, so
   Curator's first start already has them. A setting Engine rejects, or whose effective
   value is not the planned one, stops the run after the others are applied. A saved plan
   from an earlier installer version still finishes as it was approved: it names the map
   by the older `wiki.*` and `curator.*` keys, which Engine still takes into the map.

   Then it asks about attachment extraction. It shows the images, PDFs, and audio files
   in the vault, the provider each would go to, and a rough cost range. Only on approval
   does it set Engine's `extractionEnabled` to true and restart Engine, which reads that
   setting when it starts and then also reads the attachments it skipped before. The
   restart counts once Engine reports extraction on, its keys, and the provider in use;
   with `--no-sudo`, a restart you run yourself counts on the next run. Declined,
   extraction stays off and Engine keeps its keys for its other features; setting
   `extractionEnabled` to true and restarting Engine turns it on later. A headless run takes the answer from `extraction.approve`,
   recorded in the plan, so a resumed run needs no answers file.
6. **Curator.** Installs and starts `vault-curator.service` the same way as Engine's, after
   the settings, so its first start (which runs a catch-up sweep) already has them. Once
   it answers, the installer mints a read-only token with Curator's own script (one day,
   `curate:read`, kept only in memory). `curator-cost-report`, which Curator answers by
   asking Engine with its own token, shows that it reaches Engine; `curator-status` then
   shows the planned wiki mode and daily cap. Otherwise the run stops and says what to
   check. With no Curator in the plan, this step does nothing.
7. **Verification.** Free, read-only checks, printed as a table and saved in
   `installer/state.json`:
   - Engine answers authenticated calls.
   - Every Markdown file in scope is indexed. The count is compared with Vault Analyzer's
     count of the folder now; a gap warns, since the vault may change meanwhile.
   - Every planned type exists.
   - Search embedding is done. Still embedding only warns: it finishes in the
     background.
   - The database passes `vault-doctor`'s integrity check.
   - No settings domain reports an issue.
   - Every model setting in use names an enabled, priced catalog model whose provider
     has a key. A role whose feature is off is listed as off.
   - Curator answers, reaches Engine, and reads the approved cap and wiki mode.

   A failed check stops the install, which checks again on the next run.
8. **Handoff.** Writes `PUBLIC-ACCESS.md` in the data directory: whether you need public
   access, the options compared (Cloudflare Tunnel, Tailscale Funnel, Caddy with Let's
   Encrypt, Tailscale private only), the steps for each filled in with your ports, the
   issuer and restart changes after, connecting Claude.ai and the Obsidian plugin, and a
   security checklist. Nothing in it is done for you. Then:
   - **The Obsidian plugin**, when the notes folder is an Obsidian vault (it has
     `.obsidian/`). Interactively the installer asks (default yes); headless it adds the
     plugin only when `obsidian.install_plugin` is `true`, and a resumed headless run of an
     interactive plan does not. When `packages/obsidian-plugin/main.js` is missing it first
     builds the plugin (`npm run build -w vault-obsidian`, which the root build leaves
     out); if that fails, nothing is added and the install still finishes. It copies
     `main.js`, `manifest.json`, and `styles.css` into
     `<vault>/.obsidian/plugins/vault-engine/` and writes the plugin's `data.json` (`0600`)
     with Engine's URL (`http://localhost:<port>/mcp`) and a service token minted for it
     (`--name obsidian`), and, with Curator, Curator's URL and a Curator token with
     `curate:read` and `curate:trigger`, which its wiki commands need. Each token is
     written only there: never printed, logged, or saved in `installer/state.json`. A
     plugin folder already there is replaced only when an interactive user agrees, keeping
     its other `data.json` settings; otherwise it is left as it is, and the installer says
     how to connect it. Nothing else in `.obsidian/` changes: Obsidian asks you to turn
     community plugins on, and you turn the plugin on in **Settings → Community plugins**
     (after reloading the list, or restarting Obsidian, if it was open). The choice is
     saved before the folder is written, so a rerun finishes the plugin without asking.
     To revoke the plugin's tokens, run each service's token script with `--revoke`
     ([`uninstall`](#uninstall) does this for a plugin the installer added):

     ```bash
     cd <checkout> && VAULT_PATH=<vault> DB_PATH=<Engine database> <node> --import tsx packages/engine/scripts/issue-service-token.ts --name obsidian --revoke
     cd <checkout> && CURATOR_DB_PATH=<data>/curator.db <node> --import tsx packages/curator/scripts/issue-service-token.ts --name obsidian --revoke
     ```

     `PUBLIC-ACCESS.md` shows the first, filled in.
   - It revokes every token it minted for itself, on Engine and Curator, with their own
     scripts (`--revoke`), and removes `installer/installer.env`.
   - It shows how to connect something: the plugin's state and what is left to do in
     Obsidian, and Claude Code commands for a local AI client. Claude Code signs in to
     each service with OAuth at the `localhost` issuer the install configured, with the
     owner password (`claude mcp add --transport http --scope user vault-engine
     http://localhost:<port>/mcp`, then `claude mcp login vault-engine`; the same for
     `vault-curator`), and the installer prints the command that shows each password
     (`sed -n 's/^OAUTH_OWNER_PASSWORD=//p' <data>/engine.env`). An OAuth client must
     use `localhost`, not `127.0.0.1`: the address has to match the issuer.
   - It says what to try first. When a quarter or more of the notes got no kind, and at
     least ten, that is sorting them: it gives the count and the request to put to Claude
     Code ("What is still unorganized in my vault?"), which Engine's `cleanup-report`
     answers together with the steps for working through it, and the command that starts
     the same session from Engine's `organize-vault` prompt
     (`/mcp__vault-engine__organize-vault`). It adds that grouping similar notes needs
     the search index when verification did not find it ready, and that `status` shows
     when it is and then what the notes with no kind have in common. With fewer notes left
     over, sorting is one line after the suggestion below; with none, or when the plan
     did not read the notes, it is not mentioned (`src/sorting.ts`).
   - The suggestion follows the vocabulary map: a project wiki
     when a project kind holds notes and Curator is installed, otherwise a topic wiki,
     and with no Curator a search. It says the designations live in
     `<settings folder>/Vault.md` and can be changed there or by an assistant, and, in an
     Obsidian vault with no task kind, that the plugin hides its task views.
   - It ends with the services' addresses, the guide, and the `status` command. The
     installer does not create a wiki itself, since that spends within Curator's cap.

Progress is saved in `installer/state.json` with the approved plan and no secrets. Run
`install` again to continue: it reads the saved plan instead of asking again, so it needs
no answers file (headless runs still need `--yes`), and it replaces a backup that stopped
partway. Before writing the configuration, the state records each file and its SHA-256.
If a run stops while writing, the next run keeps the configuration when every file is in
place; otherwise it removes the files it wrote and plans again, since keys are never saved
outside the env files.

`install` refuses, changing nothing, when a preflight check fails, the folder already has
`.vault-engine/`, an earlier installation exists (units or a state file), a file it would
write already exists, or the data directory and the vault overlap. To start over after an
install of its own, see [Uninstall](#uninstall).

## Check an installation

```bash
node packages/installer/dist/cli.js status [--data-dir <dir>]
```

`status` runs the verification checks against the installation recorded in the data
directory and prints them, changing nothing. It exits 0 when no check failed. It mints a
one-day Engine token and a read-only Curator token for the checks; on a finished install
it revokes them afterwards, so no installer token stays valid.

When ten or more notes have no kind, it then lists what they have in common, from
Engine's `survey-nodes`, with no model call: groups of similar notes, each with its note
count, the features that set it apart from the other notes ("Label:" lines, a title
shape, a folder, headings, frontmatter fields) and an example title, then the request
that starts sorting them (`src/survey-summary.ts`). The survey splits one kind across
several groups, by the app it came from, so groups with the same "Label:" lines are one
row, and so are groups with the same title shape in the same folder. A row names a
feature when at least 80% of its notes have it and fewer than half of the other notes
do: a folder or a date field every note has tells the groups apart from nothing. At most
six rows are listed. The survey reads the search index, so until it has embedded the
notes, `status` says only how many have no kind.

## Undo organizing

```bash
./install.sh undo [--data-dir <dir>] [--yes]    # or: node packages/installer/dist/cli.js undo
```

`undo` reverts what adoption changed, through Engine's `undo-operations` with the
operations recorded in `installer/state.json`: notes get back the types and values they
had, and the types and global fields adoption created are removed. Removing a field
definition keeps every note's values for that field, unmanaged as they were before (this
needs an Engine with the #468 fix, which ships in the same checkout). Engine must be
running, and it keeps the operations for 24 hours. `undo` first asks Engine for a dry run
and shows how many note, type and field changes it would undo, and changes nothing until
you confirm (headless, until `--yes`). A note changed after adoption keeps its current content and is listed.
Engine writes each note it reverts in its own frontmatter layout; the backup has them byte
for byte. The settings and models the installer applied stay. Like `status`, it mints its
own Engine token and, on a finished install, revokes it afterwards.

When Engine is not answering, no longer has the operations (after 24 hours, or already
undone), or refuses, `undo` changes nothing and says where the backup is and how to put it
back: with Engine stopped, `cp -a <data>/installer/backups/<time>/vault/. <vault>/`. That
replaces every note changed since the backup, your own edits too, and keeps notes added
since.

## On macOS

Apple Silicon Macs only: Engine's local search model (onnxruntime-node) has no Intel Mac
build. Install Node.js 24 for arm64, then run `./install.sh` from a checkout, as on Linux.
An x64 Node.js, which runs under Rosetta on an Apple Silicon Mac, is refused by
`install.sh` and by preflight. What differs from Linux:

- **launchd agents, no sudo.** Engine and Curator run as launchd agents for you,
  `~/Library/LaunchAgents/vault-engine.plist` and `vault-curator.plist`. They start when
  you log in and stop when you log out. Nothing runs as root, so the review lists the
  commands it runs as you, and `--no-sudo` changes nothing. The installer copies each
  agent staged in `installer/units/` and loads it, showing each step:

  ```bash
  cp <data>/installer/units/vault-engine.plist ~/Library/LaunchAgents/vault-engine.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/vault-engine.plist
  ```

  `launchctl kickstart -k gui/$(id -u)/vault-engine` restarts Engine, and
  `launchctl print gui/$(id -u)/vault-engine` shows its state.
- **Logs** go to `<data>/logs/vault-engine.log` and `vault-curator.log`, since launchd
  keeps no journal. Each time the installer starts or restarts a service, it moves the old
  log to `.log.1`. Nothing rotates a log while its service runs.
- **Env files** are read by Node (`node --env-file`), since launchd reads none. Node's
  reader has no escapes, so the installer quotes each value with a quote it does not
  contain. A value holding `'`, `` ` ``, and `"` or `\` cannot be written; the installer
  stops and names the variable, never the value. Edit `engine.env` the same way.
- **Restarts.** launchd starts a service again after it exits with an error
  (`KeepAlive` with `SuccessfulExit` false), after 10 seconds for Engine and 5 for
  Curator. A service that exits cleanly stays stopped until you log in again or run
  `launchctl kickstart`. Engine gets 90 seconds to stop, Curator 15. `Umask` keeps what
  they write private; the units' other hardening (`NoNewPrivileges`, `PrivateTmp`,
  `ProtectSystem`) has no launchd equivalent.
- **A login session is needed.** launchd agents run in the session of a user logged in at
  the Mac (`gui/<uid>`). Over SSH with nobody logged in, preflight stops.
- **Uninstall** unloads each agent (`launchctl bootout gui/$(id -u)/vault-engine`) and
  removes its file, as you.

Not yet checked on a Mac (#535): the privacy prompt macOS shows for a vault in
`~/Documents`, `~/Desktop` or iCloud Drive; iCloud files not downloaded yet; a rename
that changes only a filename's case; a Curator sweep due while the Mac slept; and the
"Background Items Added" notice for the agents. The Analyzer checks the folder it opened
through `/proc` on Linux only; on macOS it falls back to checking paths.

## Uninstall

```bash
./install.sh uninstall [--data-dir <dir>] [--yes] [--no-sudo]    # or: node packages/installer/dist/cli.js uninstall
```

`uninstall` removes what this installation set up, so `install` can start again:

- It stops, disables, and removes `vault-engine.service` and `vault-curator.service` with
  these root commands, each shown before it runs through `sudo` (with `--no-sudo`, printed
  for you to run, as `install` does; without a terminal, `sudo -n`):

  ```bash
  sudo systemctl disable --now vault-curator.service vault-engine.service
  sudo rm /etc/systemd/system/vault-curator.service /etc/systemd/system/vault-engine.service
  sudo systemctl daemon-reload
  ```

  It removes only a unit `installer/state.json` says this installation installed, and only
  while the unit is exactly what the installer wrote. A unit changed since stops the run
  before anything changes; a unit it did not install stays.
- When `installer/state.json` says the installer added the Obsidian plugin, it then revokes
  the plugin's `obsidian` tokens on Engine and, with Curator, on Curator, with each
  service's token script (`--revoke`), as the handoff revokes the installer's own. The
  scripts write each service's database directly, so this works with the services already
  stopped, and again on a rerun. A revoke that fails does not stop the uninstall: the list
  at the end gives the command that revokes that token.
- It moves the installer's own files into `uninstalled-<time>/` in the data directory:
  `installer/state.json`, and the configuration it wrote (`engine.env`, `curator.env`, the
  staged units, and its token file). They hold your keys and owner passwords.

It shows all of this and changes nothing until you confirm (headless, until `--yes`). While
adoption can still be undone, it says to run `undo` first, since that needs Engine running.

What it leaves, each listed at the end with the command that removes it:

- Your notes as they are (adoption's changes stay unless undone), and the backup.
- `uninstalled-<time>/`.
- Engine's `.vault-engine/` in the vault, with its database and search model (for a synced
  folder, `vault.db` and `models/` in the data directory instead). A new install into the
  same folder refuses while `.vault-engine/` is there.
- Curator's `curator.db` in the data directory, which a new install with the same data
  directory would use again.
- Engine's settings notes in the vault's settings folder, which a new install that keeps
  its settings in the same folder starts from.
- The Obsidian plugin the installer added, `<vault>/.obsidian/plugins/vault-engine/`, no
  longer connected: uninstall it in Obsidian (**Settings → Community plugins**) or delete
  the folder. A plugin folder the installer did not write (one it left as it was, or one
  you added) is never touched or named.
- A unit it did not install, and a `<unit>.d/` override folder you added.

To start over from scratch: `undo` (within 24 hours of organizing), `uninstall`, remove
`.vault-engine/` and `curator.db` as it says, and `install` again. `undo` and `uninstall`
exit 0 when done or declined and 1 when they refuse.

## Boundaries

Of the workspace packages, the installer imports only `@vault/settings-registry` and
`@vault/pricing` (`npm run lint:deps` would also allow `@vault/contract`). It reaches Vault Analyzer through the
`vault-analyzer` CLI, writes env files and units into its data directory, runs the
services through systemd, mints tokens with Engine's token script, and calls Engine
through MCP. It never opens either service's database. Its only provider requests
are the free key checks.

## Development

```bash
npm run build -w vault-installer
npm run typecheck -w vault-installer
npm test -w vault-installer
npm run installer -w vault-installer -- plan      # run from source with tsx
npm run installer -w vault-installer -- install --data-dir /tmp/vault-test-data
```

Tests run Vault Analyzer from Engine's TypeScript source through `tsx`, so they do not need
an Engine build. `test/engine.e2e.test.ts` runs the whole install against a real Engine,
started from source as a child process (the `process` service backend) with the search
model never downloaded. Machine probes (`Host`) and questions (`Prompter`) are injected, so tests
never depend on the real machine's ports, memory, terminal, environment, or network, and
never read a real key or call a provider.
