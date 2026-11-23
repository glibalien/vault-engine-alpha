/** `1 note`, `2 notes`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A command line a POSIX shell reads back as these arguments, for showing commands to copy. */
export function shellCommand(args: readonly string[]): string {
  return args.map(arg => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(' ');
}
