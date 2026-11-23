import type { AnswerId } from './answers.js';
import { formatBytes, type BackupPlan } from './backup.js';
import type { CuratorPlan } from './curator-plan.js';
import type { Host } from './host.js';
import { renderMapScreen } from './map-screen.js';
import type { ModelsPlan, VisionProvider } from './models.js';
import { createDefaultsPrompter, type ConfirmQuestion, type Prompter } from './prompter.js';
import {
  askKey, MODEL_PROVIDERS, NO_MODEL_KEY_WARNING, pickProviders, providerInfo, type ProviderId, type ProviderInfo, type ProviderKey,
} from './providers.js';
import { dollars } from './review.js';
import { defaultSource, detectStructure, type StructurePlan, type StructureStageDeps } from './structure.js';
import { count } from './text.js';
import { wrap } from './tui.js';

/**
 * Quick setup: an interactive run that asks for the notes folder, one AI key, and the
 * approval, and takes for everything else the default a headless run takes. The notes
 * step's map is shown, not asked. What no default can settle still interrupts: kind names
 * that differ only by case, a type line the Analyzer refuses, a usual folder (Settings/,
 * Wikis/, Topics/) the vault already has, a failed check of this computer, and a key the
 * provider refuses. "Choose everything" is the full walk-through.
 */

/** The choice after the welcome screen; a headless run never sees it. */
export const SETUP_MODE_QUESTION: ConfirmQuestion = {
  message: 'How would you like to set up Vault?',
  initialValue: true,
  active: 'Quick setup (recommended)',
  inactive: 'Choose everything',
};

/**
 * The questions quick setup answers with their defaults, as a headless run without these
 * answers does. Any other question is asked; the notes step settles its own through
 * `detectStructure`.
 */
export const QUICK_DEFAULTS: ReadonlySet<AnswerId> = new Set<AnswerId>([
  'vault.exclude', 'vault.settings_dir', 'vault.wiki_dir', 'vault.topic_dir',
  'curator.install', 'curator.daily_budget_cents', 'curator.sweep_at', 'curator.tz', 'curator.wiki_mode',
  'models.preset', 'models.vision_provider',
  'backup.mode',
]);

/** The prompter for quick setup's folder, Curator, models, and backup steps. */
export function quickDefaults(real: Prompter): Prompter {
  return createDefaultsPrompter(real, {}, QUICK_DEFAULTS);
}

/** Asked when the user declines to install from quick setup's review. */
export const ADJUST_QUESTION: ConfirmQuestion = {
  message: 'Change how your notes are sorted, then see the plan again?',
  initialValue: false,
  active: 'Adjust the kinds of notes',
  inactive: 'No, stop here',
};

export const CHOOSE_EVERYTHING_HINT = said('To choose every answer yourself, run the installer again and pick Choose everything.');

const SEVERAL = '\u0000several';
const NONE = '\u0000none';

/** What each service adds, short enough for a focused option's hint at 80 columns. */
const SHORT_UNLOCKS: Record<ProviderId, string> = {
  anthropic: 'Claude models',
  fireworks: 'low-cost open models',
  openrouter: 'many models through one key',
  openai: 'GPT models',
  gemini: 'extra: reads images and scanned PDFs',
  deepgram: 'extra: turns audio into text',
  exa: 'extra: web search',
};

const isModelProvider = (id: ProviderId) => (MODEL_PROVIDERS as readonly string[]).includes(id);

/**
 * Quick setup's keys step: which AI service the user has a key for, then that key through
 * the full step's prompt (`askKey`: taken from this computer or pasted, checked with a free
 * request, asked again when refused). "More than one…" shows the full step's tick-list
 * (`pickProviders`) instead of walking all seven. Skipping every key asks which service
 * again; "None for now" goes on without one.
 */
export async function runQuickKeys(input: { host: Host; prompter: Prompter; checkKeys: boolean }): Promise<ProviderKey[]> {
  const { host, prompter, checkKeys } = input;
  const onComputer = (provider: ProviderInfo) => Boolean(host.env(provider.envVar)?.trim());
  const found = MODEL_PROVIDERS.filter(id => onComputer(providerInfo(id)));
  for (;;) {
    const choice = await prompter.select<string>({
      id: 'providers',
      message: 'Which AI service do you have a key for? One is enough to start, and you can add more later.',
      options: [
        ...MODEL_PROVIDERS.map(id => ({
          value: id,
          label: providerInfo(id).label,
          hint: found.includes(id) ? `${SHORT_UNLOCKS[id]}; a key is on this computer` : SHORT_UNLOCKS[id],
        })),
        { value: SEVERAL, label: 'More than one…', hint: 'tick each service you have a key for' },
        { value: NONE, label: 'None for now', hint: 'Curator and chat need one' },
      ],
      initialValue: found[0] ?? 'anthropic',
    });
    if (choice === NONE) {
      prompter.warn(NO_MODEL_KEY_WARNING);
      return [];
    }
    const services = choice === SEVERAL ? await pickProviders(host, prompter) : [providerInfo(choice as ProviderId)];
    const keys: ProviderKey[] = [];
    for (const provider of services) {
      const key = await askKey(host, prompter, provider, checkKeys);
      if (key) keys.push(key);
    }
    if (keys.length === 0) {
      prompter.info(said('No key was added. Choose a service again, or None for now.'));
      continue;
    }
    // As in the full step: the tick-list has already warned when no model service was ticked.
    if (services.some(provider => isModelProvider(provider.id)) && !keys.some(key => isModelProvider(key.provider))) {
      prompter.warn(NO_MODEL_KEY_WARNING);
    }
    return keys;
  }
}

/**
 * Quick setup's notes step: the map detected from the notes, shown with no question. Notes
 * no line says the kind of are left without kinds rather than sorted by folder.
 */
export async function runQuickNotes(deps: StructureStageDeps, installing: boolean): Promise<StructurePlan> {
  const plan = await detectStructure(deps, { sortByFolders: false });
  deps.prompter.note(renderMapScreen(deps.vault, plan, { quick: true }), 'What Vault found in your notes');
  const unsorted = plan.source === 'none' && defaultSource(deps.vault.discovery) === 'folders'
    ? 'No line in your notes says what kind each one is, so quick setup leaves them without kinds rather than sorting them by folder. '
    : '';
  deps.prompter.info(said(installing
    ? `${unsorted}To change how your notes are sorted, answer No when asked to install; you can then adjust it.`
    : `${unsorted}To change how your notes are sorted, run this again and pick Choose everything.`));
  return plan;
}

/** What quick setup chose for Curator, in one line. */
export function describeQuickCurator(curator: CuratorPlan | null): string {
  if (!curator) return said('Curator: not installed. It needs a key from Anthropic, Fireworks, OpenRouter, or OpenAI.');
  return said(`Curator: installed. It spends at most ${dollars(curator.dailyBudgetCents)} a day on AI, and updates the wikis you create every day at ${curator.sweepAt} (${curator.tz || 'this computer\'s time zone'}).`);
}

const VISION_WORDS: Record<Exclude<VisionProvider, 'model' | 'off'>, string> = { gemini: 'Gemini', claude: 'Claude' };

/** What quick setup chose for the AI models, in one line. */
export function describeQuickModels(models: ModelsPlan): string {
  const main = models.assignments.find(assignment => assignment.role.id === 'chat.defaultModel')?.model;
  if (!main) return said('AI models: none, since there is no AI key to use.');
  const reader = models.visionProvider === 'model'
    ? models.assignments.find(assignment => assignment.role.id === 'engine.visionModel')?.model?.title ?? null
    : models.visionProvider === 'off' ? null : VISION_WORDS[models.visionProvider];
  return said(`AI models: the balanced choice, led by ${main.title}. ${reader
    ? `Images and scanned PDFs: read by ${reader}, but only once you approve it after setup.`
    : 'Images and scanned PDFs: not read.'}`);
}

/** What quick setup chose for the backup, in one line. */
export function describeQuickBackup(backup: BackupPlan): string {
  if (backup.mode === 'skip') return 'Backup: none.';
  const what = backup.mode === 'markdown' ? count(backup.files, 'Markdown file') : count(backup.files, 'file');
  return said(`Backup: a copy of your ${what} (${formatBytes(backup.bytes)}), made before anything in your notes changes.`);
}

/** A message broken into lines an 80-column terminal does not wrap again. */
function said(text: string): string {
  return wrap(text, 74).join('\n');
}
