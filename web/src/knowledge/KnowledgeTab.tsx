import { useCallback, useEffect, useState } from 'react';
import type { Workspace } from '../App';
import { KNOWLEDGE_STATUSES, type KnowledgeItem, type KnowledgeStatus } from '../types';
import type { ActionResult } from './KnowledgeActions';
import { KnowledgeDetail } from './KnowledgeDetail';
import { filterQuery, KnowledgeTable, type Filters } from './KnowledgeTable';

interface Props {
  readonly ws: Workspace;
  readonly selectedId: string | null;
  onSelect(id: string | null): void;
}

interface Selected {
  readonly item: KnowledgeItem;
  readonly history: readonly KnowledgeItem[];
}

type Counts = Readonly<Record<KnowledgeStatus, number>>;

const countByStatus = (items: readonly KnowledgeItem[]): Counts => {
  const counts = Object.fromEntries(KNOWLEDGE_STATUSES.map((status) => [status, 0])) as Record<KnowledgeStatus, number>;
  for (const item of items) counts[item.status] += 1;
  return counts;
};

/** The review queue at a glance: how many items sit in each state, each a one-click filter. */
function StatusChips({ counts, active, onPick }: { counts: Counts; active: string; onPick(status: string): void }) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return (
    <div className="chips" role="group" aria-label="Filter by status">
      <button type="button" className={active === '' ? 'chip active' : 'chip'} onClick={() => onPick('')}>
        all <span className="count">{total}</span>
      </button>
      {KNOWLEDGE_STATUSES.map((status) => (
        <button key={status} type="button" className={active === status ? `chip active chip-${status}` : `chip chip-${status}`} onClick={() => onPick(status)}>
          {status} <span className="count">{counts[status]}</span>
        </button>
      ))}
    </div>
  );
}

export function KnowledgeTab({ ws, selectedId, onSelect }: Props) {
  const [filters, setFilters] = useState<Filters>({ status: '', type: '', scope: '' });
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [counts, setCounts] = useState<Counts>(countByStatus([]));
  const [selected, setSelected] = useState<Selected | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const loadList = useCallback(
    () =>
      Promise.all([ws.api.get<KnowledgeItem[]>(`/knowledge${filterQuery(filters)}`), ws.api.get<KnowledgeItem[]>('/knowledge')])
        .then(([filtered, all]) => {
          setItems(filtered);
          setCounts(countByStatus(all));
        })
        .catch(ws.report),
    [ws, filters],
  );
  const loadSelected = useCallback(
    (id: string) =>
      Promise.all([ws.api.get<KnowledgeItem>(`/knowledge/${id}`), ws.api.get<KnowledgeItem[]>(`/knowledge/${id}/history`)])
        .then(([item, history]) => setSelected({ item, history }))
        .catch(ws.report),
    [ws],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    if (selectedId === null) setSelected(null);
    else void loadSelected(selectedId);
  }, [selectedId, loadSelected]);

  const onDone = (result: ActionResult): void => {
    setOutcome(result.message);
    void loadList();
    if (result.selectId !== undefined) onSelect(result.selectId);
    else if (selectedId !== null) void loadSelected(selectedId);
  };
  const select = (id: string): void => {
    setOutcome(null);
    onSelect(id);
  };

  return (
    <>
      <StatusChips counts={counts} active={filters.status} onPick={(status) => setFilters({ ...filters, status })} />
      <div className="columns">
        <KnowledgeTable items={items} filters={filters} selectedId={selectedId} onFilters={setFilters} onSelect={select} />
        <div className="sticky-column">
          {selected === null ? (
            <p className="empty">Select an item to review it.</p>
          ) : (
            <KnowledgeDetail ws={ws} item={selected.item} history={selected.history} outcome={outcome} onSelect={select} onDone={onDone} />
          )}
        </div>
      </div>
    </>
  );
}
