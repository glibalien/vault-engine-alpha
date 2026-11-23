import { inspect } from 'node:util';

export const REDACTED = '[redacted]';

/**
 * An API key held in memory only. JSON, string conversion and `util.inspect` all print
 * `[redacted]`, so a plan or log that includes one by mistake still never shows it.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
