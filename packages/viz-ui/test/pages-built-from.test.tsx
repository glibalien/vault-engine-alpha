// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type {
  CallFn,
  ProvenanceImpactOutput,
} from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context.js';
import { PagesBuiltFrom } from '../src/PagesBuiltFrom.js';
import { ProvenanceInspector } from '../src/ProvenanceInspector.js';
import type { ImpactCandidate } from '../src/use-source-impact-review.js';
import {
  defaultCall,
  env,
  inputPage,
  output,
  status,
} from './helpers/provenance-inspector.js';
import {
  impactOutput,
  impactPage,
} from './helpers/source-impact-review.js';

afterEach(cleanup);

const SOURCE = { nodeId: 'source-input', title: 'Source', path: 'Source.md' };

/** "Pages built from this note" as the wiki panel hosts it: "See what it was built from" shows that
 *  build in the panel, with the note's inputs highlighted and a way back (#545). */
function Review({ call }: { call: CallFn }) {
  const [review, setReview] = useState<{ candidate: ImpactCandidate; namespace: string | null } | null>(null);
  return (
    <VizClientProvider call={call}>
      {review ? (
        <ProvenanceInspector
          target={review.candidate.target}
          targetError={null}
          connectionKey={1}
          hasInspectionTool
          expectedNamespace={review.namespace ?? undefined}
          preferredOutputId={review.candidate.impact.receipt.output_revision_id}
          highlightInputIds={review.candidate.impact.inputs.map((input) => input.input_id)}
          backTo="Source"
          onBack={() => setReview(null)}
          onOpenNode={async () => {}}
        />
      ) : (
        <PagesBuiltFrom
          target={SOURCE}
          connectionKey={1}
          hasInspectionTool
          hasImpactTool
          onOpen={() => {}}
          onReview={(candidate, namespace) => setReview({ candidate, namespace })}
        />
      )}
    </VizClientProvider>
  );
}

/** Open "Older builds that used it", as a click on its summary does. */
async function openOlder() {
  const older = screen.getByText('Older builds that used it').closest('details')!;
  await act(async () => {
    older.open = true;
    fireEvent(older, new Event('toggle'));
  });
}

function hydratedNode(id = 'generated-home') {
  return {
    id,
    file_path: 'Wikis/Home.md',
    title: 'Home',
    version: 2,
    types: ['wiki'],
    field_count: 0,
  };
}

function renderSourceReview(
  candidates: ProvenanceImpactOutput | ProvenanceImpactOutput[],
  options: {
    nextCursor?: string | null;
    hydrate?: boolean;
    onImpact?: (request: Record<string, unknown>) => void;
  } = {},
) {
  const outputs = Array.isArray(candidates) ? candidates : [candidates];
  const call: CallFn = async (request) => {
    if (request.name === 'find-affected-outputs') {
      options.onImpact?.(request.arguments);
      return env(impactPage(outputs, options.nextCursor ?? null));
    }
    if (request.name === 'query-nodes')
      return env({
        nodes:
          options.hydrate === false
            ? []
            : [hydratedNode(outputs[0]?.receipt.output_node_id)],
        total: options.hydrate === false ? 0 : 1,
      });
    if (request.name === 'inspect-provenance') {
      if (request.arguments.select === 'node')
        return env({
          select: 'node',
          outputs: [
            output('latest', String(request.arguments.node_id)),
          ],
          current_provenance: 'captured',
          next_cursor: null,
        });
      if (request.arguments.select === 'output') {
        const page = inputPage(
          String(request.arguments.output_revision_id),
          outputs[0]?.receipt.output_node_id,
        );
        if (page.select !== 'output') throw Error('Invalid fixture');
        return env({
          ...page,
          inputs: page.inputs.map((input) => ({
            ...input,
            id: 'source-input',
          })),
        });
      }
    }
    return defaultCall(request);
  };
  return render(<Review call={call} />);
}

it('shows an unknown candidate as uncertainty and inspects its exact revision', async () => {
  renderSourceReview(
    impactOutput('revision-a', 'generated-home', 'comparison_unknown'),
  );
  expect(await screen.findByText("can't check")).toBeTruthy();
  expect(screen.queryByText('note changed since')).toBeNull();
  expect(screen.getByText(/Only builds with saved records are checked/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'See what it was built from' }));
  expect(await screen.findByText('revision-a', { selector: 'code' })).toBeTruthy();
});

it('continues a zero-result page before saying no page is behind', async () => {
  let calls = 0;
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return defaultCall(request);
    if (request.name === 'find-affected-outputs')
      return env(impactPage([], calls++ === 0 ? 'next-page' : null));
    throw Error(`Unexpected tool ${request.name}`);
  };
  render(<Review call={call} />);
  expect(await screen.findByText(/Nothing found yet/)).toBeTruthy();
  expect(screen.queryByText(/No wiki page is behind/)).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Keep checking' }));
  expect(await screen.findByText('No wiki page is behind on this note.')).toBeTruthy();
  expect(screen.getByText(/Checked 1000 recorded uses\.$/)).toBeTruthy();
  expect(calls).toBe(2);
});

it('says when no older build used an earlier version', async () => {
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return defaultCall(request);
    if (request.name === 'find-affected-outputs')
      return env(
        request.arguments.currentness === 'historical'
          ? impactPage([])
          : impactPage([impactOutput()]),
      );
    if (request.name === 'query-nodes')
      return env({ nodes: [hydratedNode()], total: 1 });
    throw Error(`Unexpected tool ${request.name}`);
  };
  render(<Review call={call} />);
  await screen.findByText('note changed since');
  expect(screen.queryByText(/No older build used/)).toBeNull();

  await openOlder();
  expect(
    await screen.findByText('No older build used an earlier version of this note.'),
  ).toBeTruthy();
});

it('summarizes why a note needs review and preserves exact audit data in technical details', async () => {
  const candidate = impactOutput('revision-a');
  candidate.inputs[0] = {
    ...candidate.inputs[0]!,
    role: 'human_correction',
    reason: 'captured digest differs',
  };
  candidate.inputs_truncated = true;
  candidate.dependency_coverage = 'direct_with_opaque_components';
  renderSourceReview(candidate);
  expect(await screen.findByText('1 wiki page is behind on this note')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
  expect(screen.getByText('note changed since')).toBeTruthy();
  expect(screen.getByText(/used it as a correction/)).toBeTruthy();
  const details = screen.getByText('Technical details').closest('details') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('Technical details'));
  expect(details.open).toBe(true);
  expect(screen.getByText('Version ID: revision-a')).toBeTruthy();
  expect(screen.getByText(/Created 2026-09-19/)).toBeTruthy();
  expect(screen.getByText(/Review snapshot 2026-09-20/)).toBeTruthy();
  expect(screen.getByText(/Read /)).toBeTruthy();
  expect(screen.getByText('Role: Human correction')).toBeTruthy();
  expect(screen.getByText('Reason: captured digest differs')).toBeTruthy();
  expect(screen.getByText(/Some matching source records were left out/)).toBeTruthy();
  expect(screen.getByText(/Some recorded inputs cannot be checked individually/)).toBeTruthy();
});

it('keeps same-node revisions separate and keeps the raw node ID out of the title', async () => {
  renderSourceReview(
    [impactOutput('revision-a'), impactOutput('revision-b')],
    { hydrate: false },
  );
  const buttons = await screen.findAllByRole('button', {
    name: 'See what it was built from',
  });
  expect(buttons).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Untitled page' })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /generated-home/ })).toBeNull();
  const details = screen.getAllByText('Technical details');
  details.forEach((summary) => fireEvent.click(summary));
  expect(screen.getByText('Version ID: revision-a')).toBeTruthy();
  expect(screen.getByText('Version ID: revision-b')).toBeTruthy();
});

it('loads historical uses only on action', async () => {
  const impact = vi.fn();
  renderSourceReview(impactOutput(), { onImpact: impact });
  await screen.findByText('note changed since');
  expect(impact).toHaveBeenCalledTimes(1);
  await openOlder();
  await waitFor(() => expect(impact).toHaveBeenCalledTimes(2));
  expect(impact.mock.calls[1]?.[0]?.currentness).toBe('historical');
});

it('returns to loaded impact results and labels the reviewed source input', async () => {
  const impact = vi.fn();
  const { container } = renderSourceReview(impactOutput('revision-a'), {
    onImpact: impact,
  });
  fireEvent.click(
    await screen.findByRole('button', { name: 'See what it was built from' }),
  );
  expect(await screen.findByText('The note you came from.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show captured text' }));
  expect(
    await screen.findByText('<img src=x onerror=alert(1)>'),
  ).toBeTruthy();
  expect(container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Source' }));
  expect(await screen.findByRole('button', { name: 'See what it was built from' })).toBeTruthy();
  // Back shows the note's section afresh, which reads its pages again (a free query).
  expect(impact).toHaveBeenCalledTimes(2);
});

it('rejects a replacement vault before inspecting a loaded candidate', async () => {
  let vaultNamespace = 'fixture';
  let wrongVaultReads = 0;
  const call: CallFn = async (request) => {
    if (request.name === 'find-affected-outputs')
      return env(impactPage([impactOutput('revision-a')]));
    if (request.name === 'query-nodes')
      return env({ nodes: [hydratedNode()], total: 1 });
    if (request.name === 'inspect-provenance') {
      if (request.arguments.select === 'status')
        return env({ ...status(), vault_namespace: vaultNamespace });
      if (vaultNamespace === 'replacement') wrongVaultReads++;
      return defaultCall(request);
    }
    throw Error(`Unexpected tool ${request.name}`);
  };
  render(<Review call={call} />);
  const review = await screen.findByRole('button', { name: 'See what it was built from' });
  vaultNamespace = 'replacement';
  fireEvent.click(review);
  expect((await screen.findByRole('alert')).textContent).toMatch(/vault changed/i);
  expect(wrongVaultReads).toBe(0);
});

it('does not look for pages built from a note that could not be resolved', () => {
  const call = vi.fn<CallFn>();
  render(
    <VizClientProvider call={call}>
      <ProvenanceInspector
        target={null}
        targetError="Current note could not be resolved"
        connectionKey={1}
        hasInspectionTool
        hasImpactTool
        onOpenNode={async () => {}}
      />
    </VizClientProvider>,
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'Current note could not be resolved',
  );
  expect(screen.queryByRole('group', { name: 'Pages built from this note' })).toBeNull();
  expect(call.mock.calls.map(([request]) => request.name)).not.toContain('find-affected-outputs');
});

it('describes an expected merge-source publication transition accurately', async () => {
  renderSourceReview(impactOutput('revision-merge', 'canonical-page', 'expected_self_transition'));
  expect(await screen.findByText('This captured source changed as part of publishing this generation.')).toBeTruthy();
});

it('groups older builds by page and names a deleted page plainly', async () => {
  const build = (revision: string, node: string, at: string) => {
    const candidate = impactOutput(revision, node);
    candidate.receipt = { ...candidate.receipt, committed_at: at };
    candidate.currentness = node === 'gone' ? 'missing' : 'changed';
    return candidate;
  };
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return defaultCall(request);
    if (request.name === 'find-affected-outputs')
      return env(
        request.arguments.currentness === 'historical'
          ? impactPage([
              build('night-1', 'generated-home', '2026-09-01T09:00:00Z'),
              build('night-2', 'generated-home', '2026-09-02T09:00:00Z'),
              build('night-3', 'generated-home', '2026-09-03T09:00:00Z'),
              build('old', 'gone', '2026-08-01T09:00:00Z'),
            ])
          : impactPage([]),
      );
    if (request.name === 'query-nodes')
      return env({ nodes: [hydratedNode()], total: 1 });
    throw Error(`Unexpected tool ${request.name}`);
  };
  const inspect: CallFn = (request) =>
    request.name === 'inspect-provenance' && request.arguments.select === 'output'
      ? Promise.resolve(env(inputPage(String(request.arguments.output_revision_id), 'generated-home')))
      : call(request);
  render(<Review call={inspect} />);
  expect(await screen.findByText('No recorded build has used this note.')).toBeTruthy();
  await openOlder();
  expect(await screen.findByText(/3 builds,/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Home' })).toHaveLength(1);
  expect(screen.getByText('A deleted page')).toBeTruthy();
  expect(screen.getByText('page deleted')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'See the newest one' }));
  expect(await screen.findByText('night-3', { selector: 'code' })).toBeTruthy();
});
