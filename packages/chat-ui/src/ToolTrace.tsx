import { useState } from 'react';
import { envelopeMs, envelopeOk, envelopeWarnings } from './envelope.js';
import { Icon } from './Icon.js';

interface DynamicToolPart {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

const TOOL_LABELS: Record<string, string> = {
  'query-nodes': 'Search vault',
  'get-node': 'Read note',
  'create-node': 'Create note',
  'update-node': 'Update note',
  'delete-node': 'Delete note',
  'vault-stats': 'Check vault',
  'usage-report': 'Review usage and cost',
  'project-evidence': 'Review project evidence',
  'inspect-provenance': 'Check note history',
  'find-affected-outputs': 'Find affected notes',
  'present-viz': 'Prepare results card',
};

function toolLabel(name: string): string {
  const known = TOOL_LABELS[name];
  if (known) return known;
  const words = name.replaceAll(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Use vault tool';
}

/** `settled`: the part's message is no longer streaming, so a call still without a
 *  result will never get one. It shows as interrupted, not as working (#283). */
export function ToolTrace({ part, settled = false }: { part: DynamicToolPart; settled?: boolean }) {
  const [open, setOpen] = useState(false);
  const unfinished = part.state === 'input-streaming' || part.state === 'input-available';
  const running = unfinished && !settled;
  const interrupted = unfinished && settled;
  const failed = part.state === 'output-error' || (part.state === 'output-available' && !envelopeOk(part.output));
  const warnings = part.state === 'output-available' ? envelopeWarnings(part.output) : [];
  const ms = envelopeMs(part.output);
  const detail = [
    `Tool: ${part.toolName}`,
    ms !== undefined ? `Duration: ${ms} ms` : null,
    warnings.length
      ? `Warnings:\n${warnings.map((warning) => `${warning.code}: ${warning.message}`).join('\n')}`
      : null,
    `Input:\n${JSON.stringify(part.input, null, 2)}`,
    `Output:\n${
      part.state === 'output-error'
        ? part.errorText
        : interrupted
          ? 'Interrupted: this tool call did not finish.'
          : JSON.stringify(part.output, null, 2)
    }`,
  ].filter((line): line is string => line !== null).join('\n\n');
  return (
    <div className="toolcall">
      <div
        className="tc-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
      >
        <span className="tc-icon"><Icon name="cmd" /></span>
        <span className={`tc-name${failed ? ' err' : ''}`}>{toolLabel(part.toolName)}</span>
        <span className="tc-args" />
        {warnings.length > 0 && (
          <span className="chip" title={warnings.map((warning) => warning.message).join('\n')}>
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
          </span>
        )}
        <span className="tc-status">
          {running
            ? <><span className="spin" /><span>Working…</span></>
            : interrupted
              ? <span className="err">Interrupted</span>
            : failed
              ? <span className="err">Failed</span>
              : <span className="ok">Done</span>}
          <Icon name="chevron" className={open ? 'chev open' : 'chev'} />
        </span>
      </div>
      {open && (
        <div className="tc-detail">
          <strong>Technical details</strong>
          <pre>{detail}</pre>
        </div>
      )}
    </div>
  );
}
