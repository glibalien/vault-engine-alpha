/** A build that a tool call queued and has not finished yet. */
export interface InFlightBuild {
  /** When the build was queued (ISO). */
  readonly since: string;
  /** The project's node id, when known. */
  readonly projectId: string | null;
  /** What a repeat call names the build by, when its starter gave a name (a dossier's page title). */
  readonly name?: string;
}

/**
 * On-demand wiki builds that run after their tool call has replied (#284). On-demand
 * builds take minutes, longer than callers wait, so create-project-wiki and live
 * curate-project-wiki runs queue the build and reply at once. One instance per server
 * process. It remembers which builds are queued or running so a retried call doesn't
 * queue a second one. It also hands each build to `keepAlive`, so shutdown waits for it
 * just as it waited for the tool call that used to run it.
 *
 * This only starts work. The work itself still goes through `CurationQueue`, the single
 * serialization point, so a queued build never overlaps another curation.
 */
export class BackgroundBuilds {
  private readonly inFlight = new Map<string, InFlightBuild>();
  /** How to record each in-flight build if shutdown cuts it off (#405). */
  private readonly interrupts = new Map<InFlightBuild, { label: string; record?: (detail: string) => void }>();

  constructor(
    private readonly keepAlive: (work: Promise<unknown>, label: string) => void,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** The build queued under `key`, if it is still queued or running. */
  get(key: string): InFlightBuild | undefined {
    return this.inFlight.get(key);
  }

  /** Start `work` unless a build is already in flight under any of `keys` (every name the
   *  project goes by: the caller's argument, its title, its node id). Returns the build that
   *  is now in flight and whether this call started it. A failure is logged, never thrown:
   *  the caller has already replied. `interrupted` records the build if shutdown gives up on it. */
  start(keys: string | readonly string[], label: string, projectId: string | null,
    work: () => Promise<unknown>, interrupted?: (detail: string) => void, name?: string): { started: boolean; build: InFlightBuild } {
    const names = [...new Set(typeof keys === 'string' ? [keys] : keys)];
    for (const key of names) {
      const existing = this.inFlight.get(key);
      if (existing) return { started: false, build: existing };
    }
    const build: InFlightBuild = { since: new Date().toISOString(), projectId, ...(name === undefined ? {} : { name }) };
    for (const key of names) this.inFlight.set(key, build);
    this.interrupts.set(build, { label, ...(interrupted ? { record: interrupted } : {}) });
    let run: Promise<unknown>;
    try {
      run = work();
    } catch (err) {
      run = Promise.reject(err);
    }
    const settled = run
      .catch((err: unknown) => this.log(`${label} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        for (const key of names) this.inFlight.delete(key);
        this.interrupts.delete(build);
      });
    this.keepAlive(settled, label);
    return { started: true, build };
  }

  /** Shutdown is giving up on every build still queued or running: record each as interrupted
   *  with `detail`, at most once, and return their labels. Recording is best-effort. */
  interruptAll(detail: string): string[] {
    const labels: string[] = [];
    for (const [build, { label, record }] of [...this.interrupts]) {
      this.interrupts.delete(build);
      labels.push(label);
      try {
        record?.(detail);
      } catch (err) {
        this.log(`${label}: interruption not recorded: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return labels;
  }
}

/** The in-flight key for one project's on-demand build, shared by both tools. Takes any
 *  name the project goes by (a title or a node id). */
export const projectBuildKey = (name: string): string => `project:${name}`;

/** Every in-flight key for a project: the name the caller used, its title and its node id. */
export const projectBuildKeys = (...names: Array<string | null | undefined>): string[] =>
  names.filter((n): n is string => typeof n === 'string' && n !== '').map(projectBuildKey);

/** The in-flight key for an on-demand sweep. */
export const SWEEP_BUILD_KEY = 'sweep';
