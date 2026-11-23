# Repository safety

This repository is a distributable source tree. Everything committed to `main` may be
cloned, mirrored, cached, and read by people outside the owner's machine. Treat every
tracked file as public.

Use this policy together with the [contributor guide](../CONTRIBUTING.md) and the
[documentation index](README.md).

## What is safe to commit

- Source, tests, schemas, migrations, and build configuration.
- Portable setup and architecture documentation that a new contributor can follow.
- Synthetic fixtures and examples. Replace real people, projects, topics, hostnames,
  paths, and object identifiers with the repository's fictional vocabulary before
  committing.
- Placeholder configuration such as `*.env.example`, `<owner-home>`, `<vault-root>`,
  `vault.example.com`, and typed resource placeholders.

## What must never be committed

Keep these only in local `.env` files, the vault, a local SQLite database, private
operator records, or provider dashboards:

- Credentials, tokens, private keys, and `*.env` files that are not `.env.example`.
- Vault content, local databases, Obsidian `data.json`, credential stores, and backup
  or dump artifacts.
- Real infrastructure identifiers: Cloudflare account/zone/tunnel/DNS IDs, production
  hostnames, and deployment topology.
- Exact personal home-directory paths that function as executable instructions,
  maintained defaults, or setup steps.
- Production-derived object identifiers, run IDs, and identifying project/account/topic
  names. Aggregate measurements are welcome; identifying labels are not.

## Issues, pull requests and commit messages

The same rules cover everything written to GitHub: issue text, PR descriptions, review
comments and commit messages. A squash merge copies the PR description into the commit on
`main`, and GitHub keeps the edit history of every post, so a later edit does not remove
what was written.

Write up a real incident by what happened, with counts and dates. Replace each company,
person, project and note title with a fictional one of the same shape, and say "names
withheld" when the reader needs to know that you did.

## Documentation categories

Documents fall into three groups, and only the first is guaranteed portable:

1. **Portable setup and architecture** — contributor, package, and design guidance that
   describes the product generically.
2. **Owner-specific operational records** — runbooks and deployment notes that describe a
   particular private deployment, and the maintainers' working notes in a package
   `CLAUDE.md`, which record dated decisions and measurements taken on a real vault. They
   are examples and history, not authorization to deploy or mutate any external system.
3. **Historical design records** — dated specs, plans, and validation reports under
   `docs/superpowers/`, `packages/*/docs/superpowers/`, and `docs/foundations/`. They
   preserve the assumptions and evidence of their time and are not current instructions.

## Where facts about a real vault go

READMEs, `AGENTS.md` files, code comments and tests describe what the product does. Facts
about a real vault go in the package `CLAUDE.md` working notes or a dated record: how much
it holds, how fast it grows, what its notes and memories are about, and who is in them. A
few such lines read together describe the person who runs the vault, even when none of
them names anyone. A timing, a failure count or what a model did may be given anywhere,
without those facts.

## Owner attribution in historical records

The owner's first name may remain only in past-tense approval and provenance statements
under `docs/foundations/**` and in dated design history, where removing it would falsify
the record. It must never appear as a product persona, a synthetic user in active source
or tests, a current setup or deployment username, a sample biographical/preference/
location/work fact, or an executable filesystem path. The name itself is in no tracked
file: the check reads it from the private terms described below.

## Reporting a suspected credential

Do not open an issue, pull request, commit message, or log line containing the value.
Report the file and line, the kind of value, and how you found it, and state that you
did not copy the value. The owner will handle it out of band.

## HEAD cleanup does not erase history

Removing a value from the current tree does not remove it from Git history, forks,
mirrors, or GitHub review caches. History rewriting, credential rotation, GitHub support
cleanup, and any production change each require separate, explicit authorization. Never
assume this policy authorizes any of them.

## Run the safety check

The tracked-file safety lint has no runtime dependencies beyond Node and Git:

```bash
npm run lint:repo-safety
```

It scans tracked path text and file content, including the stored target text of tracked
symlinks. It decodes BOM-marked UTF-16 text before skipping remaining NUL-bearing binary
blobs, and prints a rule ID, file path, and line number for each finding — never the matched
value. When the path itself is sensitive, its diagnostic is a stable truncated SHA-256
identifier rather than the path. Filename checks are case-insensitive. It exits nonzero on
any finding and runs early in CI and in the root `npm test` gate.

### Private terms: real names and titles

Fixed shapes cannot tell that an ordinary word is a real company, person or project. Two
rules therefore read terms kept outside the repository, in `$VAULT_ENGINE_PRIVATE_TERMS` or
`<config home>/vault-engine/private-terms`:

| File | Holds |
|---|---|
| `owner-names.txt` | One name per line. The `owner-name` rule looks for each as a whole word. |
| `vault-terms.json` | Note titles and aliases, written by `node scripts/build-private-terms.mjs <vault-dir>`. Run it again when the vault has new notes. It reads file names and three frontmatter keys (`aliases`, `alias`, and the key that holds a note's kinds: `--type-key`, else `VAULT_TYPE_KEY`, else `types`), and prints counts only. |
| `extra-terms.txt` | More phrases to keep out, one per line, kept by hand. |
| `allow.txt` | Matches that were read and may stay, one per line. |

The `private-term` rule compares words, ignoring case, accents and punctuation, and reports:

- a whole title or alias;
- three words in a row from a title of four words or more, which is what a trimmed copy of
  a title looks like;
- a person's surname, or the first word of a company's name, on its own.

A match is reported with the words that matched, grouped, with up to three places. Change
the words to made-up ones of the same shape. Only when the match is an ordinary word, a
product name or a name that was already made up does it go in `allow.txt`. An allowed
phrase is fine wherever it appears, with everything inside it, and the same words outside
it still match, so pin a coincidence by allowing the longer phrase around it.

Two limits keep the output readable. A title made only of numbers, such as a date, is not a
term. And across a whole tree, a three-word match or a name made only of words that 20 or
more files share is not reported, because a vault that documents this project shares the
project's own vocabulary; a whole title is always reported. Dated historical records are
not held to the rule.

Where the directory does not exist, neither rule runs, and where one of its files is empty
the rule that needs it does not run; either way the check says so on its last
line. That is the normal case on a contributor's machine and in CI.

### What the check does not cover

Without private terms, the check matches fixed shapes only: credentials and private keys,
Cloudflare IDs, deployment hostnames, home and vault paths, and production node IDs. With
them, it still knows nothing of a name that is in no note title or alias, such as a
person mentioned only in a note's body or in a memory, and a first name on its own never
matches. It reads tracked files only, never issue text, PR descriptions, review comments or
commit messages. A clean run is not a reading of the change; whoever writes it still has to
read it for names and for GitHub text.

In every Markdown file it flags a 21-character token that looks like a random Engine node
ID: mixed case, breaking into seven or more short pieces at case changes, digits and
separators. Names like `isStrictIsoDateString` or `relationship_views_v1` don't match. Write
`<node-id>` instead of a real ID. Two incident records are also held to a stricter rule, where
any 21-character letter-and-digit token counts.
