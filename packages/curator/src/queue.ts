export interface QueueState {
  /** A task is currently executing. */
  running: boolean;
  /** Tasks pending, including the one currently running. */
  depth: number;
  /** Label of the task currently running, if any. */
  current?: string;
}

/**
 * A single-lane async mutex. enqueue() chains every task onto one tail promise,
 * so tasks run strictly one at a time regardless of arrival order — the one
 * serialization point that prevents two curations from overlapping. A rejected
 * task settles its own promise but does not break the chain.
 */
export class CurationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private _depth = 0;
  private _running = false;
  private _current?: string;

  enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this._depth += 1;
    const run = this.tail.then(async (): Promise<T> => {
      this._running = true;
      this._current = label;
      try {
        return await fn();
      } finally {
        this._running = false;
        this._current = undefined;
        this._depth -= 1;
      }
    });
    // Keep the chain alive even if this task rejects.
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  get state(): QueueState {
    return { running: this._running, depth: this._depth, current: this._current };
  }
}
