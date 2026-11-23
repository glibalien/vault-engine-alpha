/** Work shutdown is waiting for, as the shutdown log names it. */
export interface PendingWork {
  readonly label: string;
  /** When it was accepted (ISO). */
  readonly since: string;
}

/** Track queue producers independently of HTTP sockets, which can disconnect
 * before a tool's async validation/dependency loading finishes. This does not
 * execute curation: CurationQueue remains the sole serialization point. */
export class ServerLifecycle {
  private accepting = true;
  private readonly active = new Map<Promise<unknown>, PendingWork>();

  run<T>(action: () => Promise<T>, label = 'a tool call'): Promise<T> | undefined {
    if (!this.accepting) return undefined;
    const pending = Promise.resolve().then(action);
    this.track(pending, label);
    return pending;
  }

  /** Keep shutdown waiting for work an accepted call started but did not await,
   * such as an on-demand build that runs after its tool call has replied. */
  keepAlive(work: Promise<unknown>, label = 'background work'): void {
    this.track(work, label);
  }

  /** True once shutdown has begun: long background work checks this between steps. */
  get stopping(): boolean {
    return !this.accepting;
  }

  /** What is still tracked, oldest first. */
  pending(): PendingWork[] {
    return [...this.active.values()].sort((a, b) => a.since.localeCompare(b.since));
  }

  /** Close admission synchronously; accepted producers may still enqueue work.
   * Only after this resolves is a final queue drain safe. Waits until nothing is
   * tracked, so work handed to keepAlive by a call still running is included. */
  async stop(): Promise<void> {
    this.accepting = false;
    while (this.active.size > 0) await Promise.allSettled([...this.active.keys()]);
  }

  private track(work: Promise<unknown>, label: string): void {
    this.active.set(work, { label, since: new Date().toISOString() });
    void work.then(() => this.active.delete(work), () => this.active.delete(work));
  }
}

/**
 * Wait for `work`, but at most `limitMs` (#405). systemd kills a service that hasn't stopped
 * within its TimeoutStopSec, which records nothing; giving up first lets shutdown say what it
 * cut off and exit cleanly. Calls `waiting` every `everyMs` while it waits, so the log shows
 * what shutdown is held by. Resolves true when the work finished, false when the limit came first.
 */
export async function finishWithin(work: Promise<unknown>, limitMs: number, everyMs: number,
  waiting: (elapsedMs: number) => void): Promise<boolean> {
  const started = Date.now();
  let limit: ReturnType<typeof setTimeout> | undefined;
  const ticker = setInterval(() => {
    try { waiting(Date.now() - started); } catch { /* Logging never holds shutdown. */ }
  }, everyMs);
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<boolean>(resolve => { limit = setTimeout(() => resolve(false), limitMs); }),
    ]);
  } finally {
    clearInterval(ticker);
    if (limit !== undefined) clearTimeout(limit);
  }
}
