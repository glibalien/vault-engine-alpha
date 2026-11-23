import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { ToolTrace } from '../src/index.js';

const base = { type: 'dynamic-tool' as const, toolName: 'query-nodes', toolCallId: 't1' };

describe('ToolTrace', () => {
  it('shows a plain-language action and keeps the MCP payload in technical details', () => {
    const { container } = render(<ToolTrace part={{ ...base, state: 'output-available', input: { types: ['task'] }, output: { ok: true, _ms: 12 } } as never} />);
    expect(container.querySelector('.tc-name')?.textContent).toBe('Search vault');
    expect(container.querySelector('.tc-status .ok')?.textContent).toBe('Done');
    expect(container.querySelector('.tc-name.err')).toBeNull();
    expect(screen.queryByText(/query-nodes/)).toBeNull();

    fireEvent.click(container.querySelector('.tc-head')!);
    expect(screen.getByText('Technical details')).toBeTruthy();
    expect(screen.getByText(/Tool: query-nodes/)).toBeTruthy();
    expect(screen.getByText(/12 ms/)).toBeTruthy();
  });
  it('output-error → failed', () => {
    const { container } = render(<ToolTrace part={{ ...base, state: 'output-error', errorText: 'boom' } as never} />);
    expect(container.querySelector('.tc-status .err')?.textContent).toBe('Failed');
  });
  it('ok:false output → failed', () => {
    const { container } = render(<ToolTrace part={{ ...base, state: 'output-available', output: { ok: false } } as never} />);
    expect(container.querySelector('.tc-name.err')).not.toBeNull();
  });
  it('warnings render as a plain count while exact codes remain in details', () => {
    const { container, getByText } = render(<ToolTrace part={{ ...base, state: 'output-available', output: { ok: true, warnings: [{ code: 'STALE', message: 'm' }] } } as never} />);
    expect(getByText('1 warning')).toBeTruthy();
    fireEvent.click(container.querySelector('.tc-head')!);
    expect(getByText(/STALE: m/)).toBeTruthy();
  });
  it('a call without a result shows Working… while its message streams', () => {
    for (const state of ['input-streaming', 'input-available']) {
      const { container, unmount } = render(<ToolTrace part={{ ...base, state, input: {} } as never} />);
      expect(container.querySelector('.tc-status')?.textContent).toBe('Working…');
      expect(container.querySelector('.spin')).not.toBeNull();
      unmount();
    }
  });
  it('a call without a result in a settled message shows Interrupted, not Working…', () => {
    const { container } = render(<ToolTrace part={{ ...base, state: 'input-streaming', input: {} } as never} settled />);
    expect(container.querySelector('.tc-status .err')?.textContent).toBe('Interrupted');
    expect(container.querySelector('.spin')).toBeNull();
    fireEvent.click(container.querySelector('.tc-head')!);
    expect(screen.getByText(/Interrupted: this tool call did not finish\./)).toBeTruthy();
  });
  it('settled does not change a finished call', () => {
    const { container } = render(<ToolTrace part={{ ...base, state: 'output-available', output: { ok: true } } as never} settled />);
    expect(container.querySelector('.tc-status .ok')?.textContent).toBe('Done');
  });
  it('clicking the head expands the detail', () => {
    const { container } = render(<ToolTrace part={{ ...base, state: 'output-available', output: { ok: true } } as never} />);
    expect(container.querySelector('.tc-detail')).toBeNull();
    fireEvent.click(container.querySelector('.tc-head')!);
    expect(container.querySelector('.tc-detail')).not.toBeNull();
  });
});
