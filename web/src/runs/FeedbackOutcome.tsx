import type { Workspace } from '../App';
import { Badge } from '../components/Badge';
import { shortId } from '../format';
import type { FeedbackResult } from '../types';

function IdList({ ws, ids }: { ws: Workspace; ids: readonly string[] }) {
  if (ids.length === 0) return <span className="muted">none</span>;
  return (
    <span className="row">
      {ids.map((id) => (
        <button key={id} type="button" className="link mono" onClick={() => ws.openKnowledge(id)}>
          {shortId(id)}
        </button>
      ))}
    </span>
  );
}

export function FeedbackOutcome({ ws, result }: { ws: Workspace; result: FeedbackResult }) {
  return (
    <section className="panel">
      <h2>
        Feedback recorded <Badge value={result.kind} />
      </h2>
      {result.idempotent_replay && <p className="notice">This decision was already recorded for the run: nothing changed.</p>}
      {result.classification !== undefined && (
        <p>
          Failure classification: <strong>{result.classification}</strong>
        </p>
      )}
      <h3>Knowledge candidates created</h3>
      {result.created_items.length === 0 ? (
        <p className="muted">none</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th>Slot</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {result.created_items.map((item) => (
              <tr key={item.id}>
                <td>
                  <button type="button" className="link mono" onClick={() => ws.openKnowledge(item.id)}>
                    {shortId(item.id)} v{item.version}
                  </button>
                </td>
                <td className="mono">{item.type}</td>
                <td className="mono">{item.subject_key}</td>
                <td>{item.rule_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="kv">
        <dt>Reinforced</dt>
        <dd>
          <IdList ws={ws} ids={result.reinforced_item_ids} />
        </dd>
        <dt>Contested</dt>
        <dd>
          <IdList ws={ws} ids={result.contested_item_ids} />
        </dd>
      </dl>
      {result.notes.length > 0 && (
        <>
          <h3>Notes</h3>
          <ul className="plain">
            {result.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
