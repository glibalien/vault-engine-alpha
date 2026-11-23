import type { CoreDeps } from './core.js';
import { recoverHomeRefreshes } from './home-refresh.js';

/** Startup plus bounded retry. Polling status never starts work. */
export function startHomeRefreshRecovery(deps: CoreDeps): { stop(): void } {
  const recover = () => {
    try { recoverHomeRefreshes(deps); } catch { /* Retry after temporary storage failure. */ }
  };
  recover();
  const timer = setInterval(recover, 30_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
