import { Modal } from 'obsidian';
import type { App } from 'obsidian';

/** A model's price for add-model's `pricing` argument, in USD per million tokens. */
export interface ModelPricingInput {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/** What the user chose for an unpriced model. */
export type PriceChoice =
  | { kind: 'priced'; pricing: ModelPricingInput }
  | { kind: 'unpriced' }
  | { kind: 'cancel' };

export interface PriceFormValues { input: string; output: string; cacheRead: string; cacheWrite: string }

/** Validate the price form: input and output are required, cache prices optional (blank
 *  leaves them out). Every price must be a finite number of zero or more. */
export function parsePriceForm(values: PriceFormValues): { ok: true; pricing: ModelPricingInput } | { ok: false; message: string } {
  const read = (raw: string, label: string, required: boolean): number | undefined | string => {
    const text = raw.trim();
    if (text === '') return required ? `Enter the ${label} price` : undefined;
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? n : `The ${label} price must be a number of 0 or more`;
  };
  const input = read(values.input, 'input', true);
  const output = read(values.output, 'output', true);
  const cacheRead = read(values.cacheRead, 'cache read', false);
  const cacheWrite = read(values.cacheWrite, 'cache write', false);
  for (const v of [input, output, cacheRead, cacheWrite]) if (typeof v === 'string') return { ok: false, message: v };
  return { ok: true, pricing: {
    input: input as number, output: output as number,
    ...(cacheRead !== undefined ? { cache_read: cacheRead as number } : {}),
    ...(cacheWrite !== undefined ? { cache_write: cacheWrite as number } : {}),
  } };
}

/**
 * Asks for a price before adding a model that has no list price (#273). Anthropic and
 * OpenAI list no prices, and a capped Curator budget refuses an unpriced model. Offers
 * the price form, "Add without a price", and Cancel; closing the window counts as Cancel.
 */
class PriceModal extends Modal {
  private settled = false;

  constructor(app: App, private readonly modelName: string, private readonly resolve: (choice: PriceChoice) => void) {
    super(app);
  }

  private finish(choice: PriceChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(choice);
    this.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `Price for ${this.modelName}` });
    contentEl.createEl('p', {
      text: 'This model has no list price. Enter its price in US dollars per million tokens, or '
        + "add it without one. Curator's daily budget won't use a model with no price.",
    });
    const field = (label: string, placeholder: string): HTMLInputElement => {
      const row = contentEl.createDiv({ cls: 've-price-row' });
      row.createEl('label', { text: label });
      const input = row.createEl('input', { type: 'text', placeholder });
      input.inputMode = 'decimal';
      return input;
    };
    const input = field('Input', 'e.g. 3');
    const output = field('Output', 'e.g. 15');
    const cacheRead = field('Cache read (optional)', '');
    const cacheWrite = field('Cache write (optional)', '');
    const error = contentEl.createEl('p', { cls: 've-price-error' });
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const add = buttons.createEl('button', { text: 'Add with this price', cls: 'mod-cta' });
    add.addEventListener('click', () => {
      const parsed = parsePriceForm({ input: input.value, output: output.value, cacheRead: cacheRead.value, cacheWrite: cacheWrite.value });
      if (!parsed.ok) { error.setText(parsed.message); return; }
      this.finish({ kind: 'priced', pricing: parsed.pricing });
    });
    buttons.createEl('button', { text: 'Add without a price' })
      .addEventListener('click', () => this.finish({ kind: 'unpriced' }));
    buttons.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.finish({ kind: 'cancel' }));
    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) { this.settled = true; this.resolve({ kind: 'cancel' }); }
  }
}

/** Open the price form for `modelName` and resolve with the user's choice. */
export function askModelPrice(app: App, modelName: string): Promise<PriceChoice> {
  return new Promise((resolve) => new PriceModal(app, modelName, resolve).open());
}
