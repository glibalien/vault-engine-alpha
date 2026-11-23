# Model prompts

Every system prompt the suite sends to a model, in one place (#567). File paths are relative to
`packages/`. An override key is a text setting in that domain's settings note
(`Settings/Curator/Prompts.md` or `Settings/Chat.md`); a blank override falls back to the built-in text,
which the Curator settings note shows beside each of its keys.

## What the output modes mean

- **JSON schema:** a Curator structured call. Anthropic gets a forced tool call; OpenAI-compatible
  providers (Fireworks, OpenRouter, OpenAI) get `response_format: json_schema`, and the schema is
  also written into the system text, since Fireworks treats it as advice only. Code validates the
  result either way.
- **Page Markdown:** a JSON schema call whose answer is a Markdown page. OpenAI-compatible
  providers return the page as raw Markdown in a small envelope, which avoids escaping a long page
  inside a JSON string; Anthropic returns a tool call.
- **Prompt-only JSON:** the prompt asks for a JSON object and the request sets
  `response_format: json_object`; there is no schema.
- **generateObject:** the AI SDK's `generateObject` with a JSON schema (chat-core).
- **Text:** free text.
- **Chat with tools:** the chat loop (`streamText`), where the model calls vault tools.

## Text added in code

Code appends text to some prompts, so an override still gets it:

- The wiki home, page and planner prompts, the two memory sweeps and the reconciler get a line
  naming today's date and time zone. So does the Engine's consolidation prompt.
- Wiki page and home prompts get the evidence rules, `WIKI_WRITING_RULES`
  (`curator/src/prompts/writing-rules.ts`). A bounded rewrite gets `WIKI_REWRITE_RULES` instead.
- The three conversation-capture prompts get fixed protocol and evidence-isolation paragraphs
  (`curator/src/conversation-capture-prompts.ts`).
- The chat system prompt gets the tiering note, the open note's context and the date
  (`chat-core/src/compose.ts`).

## Curator: wikis

| Prompt | Job | File | Override key | Output | Eval |
| --- | --- | --- | --- | --- | --- |
| `SPEC_A_SYSTEM_PROMPT` | Write a project wiki's home: at a glance, now, focus, open threads, log, and rare memory proposals. Used by every project home build, including the home rewritten after a requested page. | `curator/src/synthesize.ts` | `curatorProjectHomePrompt` | JSON schema | `eval:wiki` (home cases) |
| `TOPIC_SYSTEM_PROMPT` | Write a topic wiki's home from vault material. Also used for the home rewritten after a requested page on that wiki. | `curator/src/synthesize.ts` | `curatorTopicPrompt` | JSON schema | none |
| `TOPIC_WEB_SYSTEM_PROMPT` | The same for a `vault+web` topic wiki, with web sources attributed. | `curator/src/synthesize.ts` | `curatorTopicWebPrompt` | JSON schema | none |
| `CURATOR_PAGE_SYSTEM_PROMPT` | Write one wiki sub-page in full from its planned scope and brief. | `curator/src/prompts/page.ts` | `curatorPagePrompt` | Page Markdown | `eval:wiki` (page cases) |
| `CURATOR_PAGE_REWRITE_SYSTEM_PROMPT` | Update an existing sub-page from its current text plus only the notes that changed (the bounded rewrite). | `curator/src/prompts/page.ts` | none | Page Markdown | `eval:wiki` (`rewrite-updates-and-keeps`) |
| `TOPOLOGY_SYSTEM_PROMPT` | Plan which sub-pages a wiki has: keep, refresh, reactivate, create, merge or retire, and name the sources each page's writer reads (`evidence_ids`; project wikis too since #474 idea 3). On a project wiki it also marks which memories are each page's rules on what to say (`rule_ids`, #474 idea 4). Planning content belongs to #474. | `curator/src/prompts/topology.ts` | `curatorTopologyPrompt` | JSON schema | none |
| `RULE_CHECK_SYSTEM_PROMPT` | Check a written project sub-page against its rules on what to say, and name the rules it breaks with the words that break them. A break gets one retry; in a full build a second keeps that page as it was and writes the rest, and in a single-page rebuild or a requested page it fails the request. | `curator/src/page-rules.ts` | none | JSON schema | none |
| `ADJUDICATION_SYSTEM_PROMPT` | Compare each planned new page with every existing page and say whether it duplicates one. | `curator/src/prompts/adjudicate.ts` | `curatorCreateAdjudicationPrompt` | JSON schema | none |
| `REQUESTED_PAGE_PROMPT` | Write a page someone asked for by name, with an optional brief. | `curator/src/synthesize.ts` | `curatorRequestedPagePrompt` | Page Markdown | none |
| `REQUESTED_PAGE_WEB_PROMPT` | The same on a `vault+web` wiki, with web sources attributed. | `curator/src/synthesize.ts` | `curatorRequestedPageWebPrompt` | Page Markdown | none |
| `REQUESTED_TOPOLOGY_SYSTEM` | Plan a requested page: one new page, or a merge, without retiring anything. | `curator/src/requested-page-pipeline.ts` | none | JSON schema | none |
| `TOPIC_INFERENCE_SYSTEM_PROMPT` | Name the subject a note is about and draft a brief, for `propose-topic-wiki`. | `curator/src/prompts/topic-inference.ts` | none | JSON schema | none |
| `TOPIC_REFRESH_ASSESSMENT_SYSTEM_PROMPT` | Decide whether changed web search results matter enough to rebuild a topic wiki early. | `curator/src/topic-refresh-assessment.ts` | none | JSON schema | none |

## Curator: memories and conversations

| Prompt | Job | File | Override key | Output | Eval |
| --- | --- | --- | --- | --- | --- |
| `EXTRACT_SYSTEM_PROMPT` | Read one vault note and list the lasting facts worth remembering (usually none). Also re-checks facts drawn from it before. | `curator/src/memory-sweep.ts` | `curatorMemorySweepPrompt` | JSON schema | `eval:extraction` |
| `CONVERSATION_EXTRACT_SYSTEM_PROMPT` | Read one finished chat and list lasting facts the user stated (usually none). | `curator/src/conversation-sweep.ts` | `curatorConversationSweepPrompt` | JSON schema | `eval:conversation` |
| `RECONCILE_SYSTEM_PROMPT` | Compare two similar memories: duplicate, contradiction or distinct, and which one stays. | `curator/src/reconcile.ts` | none | JSON schema | `eval:reconcile` |
| `CAPTURE_PLANNER_SYSTEM_PROMPT` | Pick what in a finished chat's assistant answers is worth saving as a note, and where. | `curator/src/conversation-capture-prompts.ts` | `curatorConversationCapturePlannerPrompt` | JSON schema | `eval:capture` |
| `CAPTURE_COVERAGE_SYSTEM_PROMPT` | Decide whether the chat's own writes or earlier captures already saved a proposed note. | `curator/src/conversation-capture-prompts.ts` | `curatorConversationCaptureCoveragePrompt` | JSON schema | `eval:capture` |
| `CAPTURE_COMPOSER_SYSTEM_PROMPT` | Write the notes the planner picked. | `curator/src/conversation-capture-prompts.ts` | `curatorConversationCaptureComposerPrompt` | JSON schema | `eval:capture` |

## Curator: organization and journal

| Prompt | Job | File | Override key | Output | Eval |
| --- | --- | --- | --- | --- | --- |
| `buildClassifySystem()` | Pick a type for one untyped note from the vault's type list, or none. | `curator/src/org-sweep.ts` | none | JSON schema | `eval:typing` |
| `FIELD_GUESS_SYSTEM_PROMPT` | Fill in a note's missing or invalid fields, or leave them blank. | `curator/src/field-guess/prompt.ts` | none | JSON schema | `eval:field-guess-live` |
| `LEDE_SYSTEM` | Write the 2–4 sentence opening of a Curator journal entry from the run's action lines. | `curator/src/journal/writer.ts` | none | JSON schema | none |

## Engine

| Prompt | Job | File | Override key | Output | Eval |
| --- | --- | --- | --- | --- | --- |
| `SYSTEM_PROMPT` | Decide what a new memory does to similar stored ones: add, no-op, update or contradict. | `engine/src/mcp/tools/memory-consolidation.ts` | none | Prompt-only JSON | `eval:consolidation` (Engine) |
| `IMAGE_PROMPT` | Transcribe an image's text, or describe it. | `engine/src/extraction/extractors/model-vision.ts`, `gemini-vision.ts` | none | Text | none |
| `PDF_PROMPT` | Transcribe a scanned PDF. | `engine/src/extraction/extractors/model-vision.ts`, `gemini-vision.ts` | none | Text | none |

## Chat

| Prompt | Job | File | Override key | Output | Eval |
| --- | --- | --- | --- | --- | --- |
| `SYSTEM_PROMPT` | The chat assistant: how to use the vault, memory and wiki tools. | `chat-core/src/system-prompt.ts` | `chatSystemPrompt` | Chat with tools | none |
| `TIERING_SYSTEM_NOTE` | Tells the chat model more tools can be loaded. | `chat-core/src/tiering.ts` | `chatTieringNote` | Appended to the chat prompt | none |
| `TITLE_SYSTEM` | Name a conversation after its first exchange. | `chat-core/src/title.ts` | none | Text | none |
| `buildInterpretSystem()` | Turn a plain-language request into a board card's query. | `chat-core/src/viz-interpret.ts` | none | generateObject | none |
| `buildBoardPlanSystem()` | Turn a plain-language request into a plan of board changes. | `chat-core/src/board-plan-interpret.ts` | none | generateObject | none |

## Eval-only prompts

The evals grade with their own prompts, never used in production: `JUDGE_SYSTEM`
(`curator/src/eval/judge.ts`, compares two home pages), `JUDGE_SYSTEM_PROMPT`
(`curator/src/eval/extraction.ts`, grades extracted facts),
`CAPTURE_STANDALONE_JUDGE_SYSTEM_PROMPT` (`curator/src/eval/capture-standalone-judge.ts`) and
`RULE_JUDGE_SYSTEM_PROMPT` (`curator/src/eval/wiki-judge.ts`, rules on a golden wiki answer a
"must not say" pattern flagged, #604; checked with `eval:wiki -- --check-judge`).

## Review status (#567, November 2026)

Rewritten in plain words: the capture prompts (#599), the wiki page, page-rewrite, duplicate-page check, requested-page planner, topic early-refresh and journal-opening prompts (#601), field guessing and the memory merge's add/update rules (#607). The project home prompt gained two rules (#603).

Reviewed and kept as written, because they already say plainly what the input is, what to return and the rules: the memory sweep, conversation sweep, memory reconciler, type classifier, topic inference, the chat prompts and the vision prompts. The topology planner is left to #474.

## Changing a prompt

- A changed built-in reaches every install that has no override for it, at the next deploy.
  Where an override is set, the Settings note says "Built-in default has changed" and the
  override keeps working.
- Keep the output contract: the schema, field names and what code parses. Stored data must not
  change shape.
- Run the eval in the table, where there is one, before merging. `eval:wiki` is required before
  changing a page or home prompt (`packages/curator/AGENTS.md`).
- Update this table.

## Comparing models for a job

`npm run eval:models` (repository root, #570) runs the consolidation, reconcile, typing,
extraction and conversation evals once per model and prints one table: job × model → score,
failures, tokens, latency and estimated cost, with the cost per provider below. Every run makes
paid calls.

```bash
npm run eval:models -- --models "Qwen 3.7 Plus,DeepSeek V4 Pro" --runs 3 --judge-model "Qwen 3.7 Plus" \
  --engine-env <data dir>/engine.env --curator-env <data dir>/curator.env --engine-db <vault.db>
```

- Models are Settings/Models titles. Without `--models` each eval runs its configured model.
  `--evals` picks some of them.
- Run each model three times or more: results vary run to run, and the table shows the range.
- `--judge-model` keeps one judge for the judged evals (extraction, conversation). Without it each
  model judges its own answers.
- Each run appends one line to `evals/history.jsonl` (the commit, whether tracked files had
  uncommitted changes, every row and every eval's raw result). Commit it to keep the trend. On the production host, run in a throwaway clone and copy
  the line back, or pass `--history <file>`; `--no-history` writes none.
- Each eval also takes `--json`, which adds the one result line the runner reads.
