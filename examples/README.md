# Examples

## `messy-vault/`

A made-up notes dump, the kind Vault Engine is meant to sort (#650). Nothing in it is real:
every person, company, book and recipe is invented. It is about 150 notes exported from
three apps, each in its own folder and its own style, holding the same five kinds of note
mixed together: meetings, recipes, book notes, journal entries and contacts.

What it holds for the organizing tools to find:

- **No kinds.** No note has a `types` line. The installer sorts the Bear notes by their
  `#tags` (`#meeting`, `#books`, `#people`…) and half the Evernote notes by their `tags`
  property; the rest are left for `survey-nodes` and `cleanup-report`.
- **A tag that names no kind.** `#imported` is on every Bear note, and `reading` on some
  Evernote book notes; neither starts ticked.
- **Dates in other forms.** Notion meetings write their date as `March 4, 2019` or
  day-first (`28/12/2015`), and some Evernote meetings say `date: TBD`. Evernote notes
  carry a `created` timestamp. `recover-dates` reads them.
- **Names with no note.** Meeting attendees are `[[links]]`, some unquoted, to people who
  have no note of their own. `find-missing-nodes` lists them.
- **Copies.** One Evernote note was exported twice (`… (1).md`), and one was copied and
  then edited (`… copy.md`). `find-duplicate-nodes` finds both, and `merge-nodes` folds them.
- **Fields no kind defines.** `source`, `author` and `attendees` on Evernote notes.

The installer offers it when you create a new notes folder ("With a messy sample"), and an
answers file asks for it with `vault.sample: "messy"`. It is copied, so this folder stays
as it is.

The notes were written once from the fixture the survey tests use
(`packages/engine/tests/survey/mixed-export-fixture.ts`), with the messiness above added.
They are plain files now: edit them by hand.
