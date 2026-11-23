import { describe, expect, it, vi } from 'vitest';
import { sendConsoleToStderr } from '../src/transport/stdio-logs.js';

describe('sendConsoleToStderr', () => {
  it('sends log, info and debug where error goes, and leaves warn and error alone', () => {
    const error = vi.fn();
    const warn = vi.fn();
    const target = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn, error } as unknown as Console;
    const stdoutMethods = [target.log, target.info, target.debug];

    sendConsoleToStderr(target);
    target.log('a %s', 'log');
    target.info('info');
    target.debug('debug');

    expect(error.mock.calls).toEqual([['a %s', 'log'], ['info'], ['debug']]);
    for (const method of stdoutMethods) expect(method).not.toHaveBeenCalled();
    expect(target.warn).toBe(warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
