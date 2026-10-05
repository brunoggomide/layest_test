import type { Workspace } from '../App';
import { Badge } from '../components/Badge';
import { displayValue, shortId } from '../format';
import type { KnowledgeRef, RunResponse, Suggestion } from '../types';

export function SuggestionView({ suggestion }: { suggestion: Suggestion }) {
  return (
    <>
      <dl className="kv">
        <dt>Account</dt>
        <dd className="mono">{suggestion.account}</dd>
        {suggestion.recovery_strategy !== undefined && (
          <>
            <dt>Recovery strategy</dt>
            <dd className="mono">{suggestion.recovery_strategy}</dd>
          </>
        )}
      </dl>
      <h3>Fields</h3>
      <table>
        <tbody>
          {Object.entries(suggestion.fields).map(([field, value]) => (
            <tr key={field}>
              <td className="mono">{field}</td>
              <td className="mono">{displayValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {suggestion.notes.length > 0 && (
        <>
          <h3>Why</h3>
          <ul className="plain">
            {suggestion.notes.map((note) => (
              <li key={note} className="mono">
                {note}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function RefList({ ws, title, refs }: { ws: Workspace; title: string; refs: readonly KnowledgeRef[] }) {
  return (
    <>
      <h3>{title}</h3>
      {refs.length === 0 ? (
        <p className="muted">none</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Scope</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {refs.map((ref) => (
              <tr key={ref.id}>
                <td className="item-cell">
                  <div className="stack">
                    <button type="button" className="link mono" onClick={() => ws.openKnowledge(ref.id)}>
                      {shortId(ref.id)} v{ref.version}
                    </button>
                    <span className="mono muted">{ref.type}</span>
                  </div>
                </td>
                <td>
                  <Badge value={ref.scope} />
                </td>
                <td>{ref.rule_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function RunResult({ ws, result }: { ws: Workspace; result: RunResponse }) {
  return (
    <section className="panel">
      <h2>
        Run <span className="mono">{shortId(result.run_id)}</span>
        {result.replayed && <Badge value="replayed" />}
      </h2>
      {result.replayed && <p className="notice">This idempotency key already had a run: the stored result is returned and nothing executed again.</p>}
      <SuggestionView suggestion={result.suggestion} />
      <h3>Retrieval anchors</h3>
      <div className="row">
        {result.anchors.map((anchor) => (
          <code key={anchor}>{anchor}</code>
        ))}
      </div>
      <RefList ws={ws} title="Applied knowledge (changed the output)" refs={result.applied_knowledge} />
      <RefList ws={ws} title="Retrieved knowledge (handed to the agent)" refs={result.retrieved_knowledge} />
      <RefList ws={ws} title="Shadowed global knowledge (a tenant item won the slot)" refs={result.shadowed_global_knowledge} />
    </section>
  );
}
