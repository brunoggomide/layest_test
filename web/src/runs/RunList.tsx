import { activatable } from '../components/activatable';
import { Badge } from '../components/Badge';
import { formatDate, shortId } from '../format';
import type { RunSummary } from '../types';

interface Props {
  readonly runs: readonly RunSummary[];
  readonly selectedId: string | null;
  onOpen(id: string): void;
}

export function RunList({ runs, selectedId, onOpen }: Props) {
  return (
    <section className="panel">
      <h2>Recent runs</h2>
      {runs.length === 0 ? (
        <p className="empty">No runs yet for this actor.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Vendor</th>
              <th>Account</th>
              <th>Status</th>
              <th>Ref</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className={run.id === selectedId ? 'clickable selected' : 'clickable'} {...activatable(() => onOpen(run.id))}>
                <td className="mono">{shortId(run.id)}</td>
                <td>{run.vendor}</td>
                <td className="mono">{run.account}</td>
                <td>
                  <Badge value={run.status} />
                </td>
                <td className="mono">{run.invoice_ref ?? '-'}</td>
                <td>{formatDate(run.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
