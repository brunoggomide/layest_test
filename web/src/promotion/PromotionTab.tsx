import { useState } from 'react';
import type { Workspace } from '../App';
import { Badge } from '../components/Badge';
import { shortId } from '../format';
import type { PromotionDecision, PromotionReport } from '../types';

function DecisionRow({ ws, decision }: { ws: Workspace; decision: PromotionDecision }) {
  const stripped = decision.sanitizer?.stripped ?? [];
  return (
    <tr>
      <td>
        <Badge value={decision.outcome} />
      </td>
      <td className="mono">{decision.type}</td>
      <td className="mono">{decision.subject_key}</td>
      <td className="mono">{decision.tenant_ids.length}</td>
      <td>
        {decision.reason}
        {stripped.length > 0 && <div className="muted mono">stripped: {stripped.join(', ')}</div>}
      </td>
      <td>
        {decision.global_item_id !== undefined && (
          <button type="button" className="link mono" onClick={() => ws.openKnowledge(decision.global_item_id ?? '')}>
            {shortId(decision.global_item_id)}
          </button>
        )}
      </td>
    </tr>
  );
}

export function PromotionTab({ ws }: { ws: Workspace }) {
  const [report, setReport] = useState<PromotionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const platform = ws.actor.kind === 'platform';

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      setReport(await ws.api.post<PromotionReport>('/promotion/run'));
    } catch (error) {
      ws.report(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Global promotion</h2>
      <p className="muted">
        Groups the active tenant items by slot and creates a global candidate only when the type is structural, enough distinct tenants share it, no global item
        exists for the slot and the sanitizer keeps nothing but structure. The platform reviewer still has to accept it.
      </p>
      {!platform && <p className="notice">The promotion job runs with the service token. Choose &quot;Platform reviewer&quot; in &quot;Act as&quot;.</p>}
      <div className="actions">
        <button type="button" disabled={busy || !platform} onClick={() => void run()}>
          {busy ? 'Running...' : 'Run promotion job'}
        </button>
      </div>
      {report !== null && (
        <>
          <h3>Decisions (minimum distinct tenants: {report.min_tenants})</h3>
          {report.decisions.length === 0 ? (
            <p className="muted">No active tenant knowledge to consider.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Type</th>
                  <th>Slot</th>
                  <th>Tenants</th>
                  <th>Reason</th>
                  <th>Global candidate</th>
                </tr>
              </thead>
              <tbody>
                {report.decisions.map((decision) => (
                  <DecisionRow key={`${decision.type}|${decision.subject_key}`} ws={ws} decision={decision} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
