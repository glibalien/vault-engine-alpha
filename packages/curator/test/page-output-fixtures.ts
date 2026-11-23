/** Synthetic provider response; deliberately invalid logical output stays invalid on the wire. */
export function pageOutputFrame(output: unknown): string {
  if (!output || typeof output !== 'object' || !('body' in output) || typeof output.body !== 'string'
    || Object.keys(output).some(key => key !== 'body' && key !== 'log_note')) return JSON.stringify(output);
  const note = 'log_note' in output ? output.log_note : '';
  return `<<<VAULT_PAGE_V1>>>\nlog_note: ${note}\n<<<VAULT_BODY>>>\n${output.body}\n<<<END_VAULT_PAGE>>>`;
}
