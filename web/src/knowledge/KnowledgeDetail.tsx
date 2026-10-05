import type { Workspace } from '../App';
import { Badge } from '../components/Badge';
import { JsonBlock } from '../components/JsonBlock';
import { asString, formatDate, shortId } from '../format';
import type { KnowledgeItem } from '../types';
import { KnowledgeActions, type ActionResult } from './KnowledgeActions';

function Provenance({ item }: { item: KnowledgeItem }) {
  const conflictsWith = asString(item.supporting_context['conflicts_with']);
  return (
    <dl className="kv">
      <dt>Scope</dt>
      <dd>
        <Badge value={item.scope} /> <span className="mono">{item.tenant_id ?? 'all tenants'}</span>
      </dd>
      <dt>Slot</dt>
      <dd className="mono">{item.subject_key}</dd>
      {conflictsWith !== null && (
        <>
          <dt>Conflicts with</dt>
          <dd>
            <span className="highlight mono">{conflictsWith}</span> (active on the same slot; a reviewer decides)
          </dd>
        </>
      )}
      <dt>Confidence</dt>
      <dd className="mono">
        {item.confidence.toFixed(2)} (evidence {item.evidence_count}, contested {item.contested_count}, tenants {item.distinct_tenant_count})
      </dd>
      <dt>Source run / event</dt>
      <dd className="mono">
        {item.source_run_id ?? '-'} / {item.source_event_id ?? '-'}
      </dd>
      <dt>Created</dt>
      <dd>{formatDate(item.created_at)}</dd>
      <dt>Reviewed</dt>
      <dd>
        {formatDate(item.reviewed_at)} {item.reviewed_by === null ? '' : `by ${item.reviewed_by}`}
      </dd>
      <dt>Activated</dt>
      <dd>{formatDate(item.activated_at)}</dd>
      <dt>Valid until</dt>
      <dd>{formatDate(item.valid_until)}</dd>
    </dl>
  );
}

function History({ chain, current, onSelect }: { chain: readonly KnowledgeItem[]; current: string; onSelect(id: string): void }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Version</th>
          <th>Item</th>
          <th>Status</th>
          <th>Rule</th>
        </tr>
      </thead>
      <tbody>
        {chain.map((entry) => (
          <tr key={entry.id} className={entry.id === current ? 'selected' : ''}>
            <td className="mono">v{entry.version}</td>
            <td>
              <button type="button" className="link mono" onClick={() => onSelect(entry.id)}>
                {shortId(entry.id)}
              </button>
            </td>
            <td>
              <Badge value={entry.status} />
            </td>
            <td className="mono">{JSON.stringify(entry.rule)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Props {
  readonly ws: Workspace;
  readonly item: KnowledgeItem;
  readonly history: readonly KnowledgeItem[];
  readonly outcome: string | null;
  onSelect(id: string): void;
  onDone(result: ActionResult): void;
}

export function KnowledgeDetail({ ws, item, history, outcome, onSelect, onDone }: Props) {
  return (
    <section className="panel">
      <h2>
        <span className="mono">{item.type}</span> <span className="mono">{shortId(item.id)}</span> v{item.version} <Badge value={item.status} />
      </h2>
      <p>{item.rule_text}</p>
      {outcome !== null && <p className="success">{outcome}</p>}
      <KnowledgeActions ws={ws} item={item} onDone={onDone} />
      <h3>Rule</h3>
      <JsonBlock value={item.rule} />
      <h3>Supporting context</h3>
      <JsonBlock value={item.supporting_context} />
      <h3>Provenance</h3>
      <Provenance item={item} />
      <h3>Version history</h3>
      <History chain={history} current={item.id} onSelect={onSelect} />
    </section>
  );
}
