import { activatable } from '../components/activatable';
import { Badge } from '../components/Badge';
import { shortSlot } from '../format';
import { KNOWLEDGE_STATUSES, KNOWLEDGE_TYPES, type KnowledgeItem } from '../types';

export interface Filters {
  readonly status: string;
  readonly type: string;
  readonly scope: string;
}

export function filterQuery(filters: Filters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== '') params.set(key, value);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

interface FilterProps {
  readonly filters: Filters;
  onChange(filters: Filters): void;
}

function FilterBar({ filters, onChange }: FilterProps) {
  const select = (key: keyof Filters, label: string, options: readonly string[]): React.JSX.Element => (
    <label>
      {label}
      <select value={filters[key]} onChange={(e) => onChange({ ...filters, [key]: e.target.value })}>
        <option value="">any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="filters">
      {select('status', 'Status', KNOWLEDGE_STATUSES)}
      {select('type', 'Type', KNOWLEDGE_TYPES)}
      {select('scope', 'Scope', ['tenant', 'global'])}
    </div>
  );
}

function Row({ item, selected, onSelect }: { item: KnowledgeItem; selected: boolean; onSelect(id: string): void }) {
  return (
    <tr className={selected ? 'clickable selected' : 'clickable'} {...activatable(() => onSelect(item.id))}>
      <td className="item-cell">
        <div className="stack">
          <span className="mono">{item.type}</span>
          <span className="mono muted" title={item.subject_key}>
            {shortSlot(item.subject_key)}
          </span>
        </div>
      </td>
      <td>{item.rule_text}</td>
      <td className="status-cell">
        <div className="stack">
          <Badge value={item.status} />
          <Badge value={item.scope} />
          <span className="mono signals">
            v{item.version} <span className="muted">conf</span> {item.confidence.toFixed(2)}
          </span>
          <span className="mono signals">
            <span className="muted">evidence</span> {item.evidence_count} <span className="muted">contested</span> {item.contested_count}
          </span>
        </div>
      </td>
    </tr>
  );
}

interface Props {
  readonly items: readonly KnowledgeItem[];
  readonly filters: Filters;
  readonly selectedId: string | null;
  onFilters(filters: Filters): void;
  onSelect(id: string): void;
}

export function KnowledgeTable({ items, filters, selectedId, onFilters, onSelect }: Props) {
  return (
    <section className="panel">
      <h2>Knowledge items</h2>
      <FilterBar filters={filters} onChange={onFilters} />
      {items.length === 0 ? (
        <p className="empty">Nothing matches for this actor.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Rule</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <Row key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
