/**
 * On the stdio transport stdout is the MCP channel: a client reads every line there as a
 * JSON-RPC message, so a log line on stdout is a protocol error. This sends console's
 * stdout methods to stderr. The transport itself writes to `process.stdout` directly and is
 * unaffected.
 */
export function sendConsoleToStderr(target: Console = console): void {
  const toStderr = target.error.bind(target);
  target.log = toStderr;
  target.info = toStderr;
  target.debug = toStderr;
}
