import { useEffect, useRef, useState } from 'react';
import type { NodeCandidate } from '../node-candidate.js';

export function AddContextRows({ candidates, onPick }: { candidates: NodeCandidate[]; onPick: (c: NodeCandidate) => void }) {
  if (!candidates.length) return <div className="ctx-add-empty">no matches</div>;
  return (
    <div className="ctx-add-rows">
      {candidates.map((c) => (
        <button key={c.id} className="ctx-add-row" onClick={() => onPick(c)}>
          <span className="t">{c.title}</span>
          {c.type && <span className="ty">{c.type}</span>}
        </button>
      ))}
    </div>
  );
}

export function AddContextPicker({ searchNodes, onPick, onClose }: {
  searchNodes: (query: string) => Promise<NodeCandidate[]>;
  onPick: (c: NodeCandidate) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<NodeCandidate[]>([]);
  const seq = useRef(0);

  // Debounced search with a monotonic-sequence stale-guard.
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchNodes(query)
        .then((rs) => { if (mine === seq.current) setCandidates(rs); })
        .catch(() => { if (mine === seq.current) setCandidates([]); });
    }, 120);
    return () => clearTimeout(t);
  }, [query, searchNodes]);

  return (
    <div className="ctx-add-pop">
      <input
        autoFocus
        className="ctx-add-input"
        placeholder="add node to context…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      />
      <AddContextRows candidates={candidates} onPick={onPick} />
    </div>
  );
}
