import type { Workspace } from '../App';
import { Badge } from '../components/Badge';
import { JsonBlock } from '../components/JsonBlock';
import { formatDate, shortId, shortSlot } from '../format';
import type { FeedbackResult, FeedbackSummary, RunDetail as Detail, TraceRow } from '../types';
import { FeedbackForm } from './FeedbackForm';
import { FeedbackOutcome } from './FeedbackOutcome';
import { SuggestionView } from './RunResult';

function TraceTable({ ws, trace }: { ws: Workspace; trace: readonly TraceRow[] }) {
  if (trace.length === 0) return <p className="muted">No knowledge was retrieved for this run.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Role</th>
          <th>Item</th>
          <th>Used</th>
          <th>Now</th>
        </tr>
      </thead>
      <tbody>
        {trace.map((row) => (
          <tr key={`${row.knowledge_item_id}-${row.role}`}>
            <td>
              <Badge value={row.role} />
            </td>
            <td className="item-cell">
              <div className="stack">
                <button type="button" className="link mono" onClick={() => ws.openKnowledge(row.knowledge_item_id)}>
                  {shortId(row.knowledge_item_id)} {row.type}
                </button>
                <span className="mono muted" title={row.subject_key}>
                  {shortSlot(row.subject_key)}
                </span>
              </div>
            </td>
            <td className="mono">v{row.version}</td>
            <td>
              <div className="stack">
                <Badge value={row.current_status} />
                <span className="mono">v{row.current_version}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FeedbackView({ feedback }: { feedback: FeedbackSummary }) {
  return (
    <>
      <dl className="kv">
        <dt>Decision</dt>
        <dd>
          <Badge value={feedback.kind} />
        </dd>
        <dt>Reviewer</dt>
        <dd>{feedback.reviewer_id}</dd>
        <dt>When</dt>
        <dd>{formatDate(feedback.created_at)}</dd>
      </dl>
      {feedback.diff !== null && <JsonBlock value={feedback.diff} />}
      {feedback.error !== null && <JsonBlock value={feedback.error} />}
    </>
  );
}

interface Props {
  readonly ws: Workspace;
  readonly detail: Detail;
  readonly feedbackResult: FeedbackResult | null;
  onFeedback(result: FeedbackResult): void;
}

export function RunDetail({ ws, detail, feedbackResult, onFeedback }: Props) {
  const { run } = detail;
  return (
    <>
      <section className="panel">
        <h2>
          Run <span className="mono">{shortId(run.id)}</span> <Badge value={run.status} />
        </h2>
        <dl className="kv">
          <dt>Tenant</dt>
          <dd className="mono">{run.tenant_id}</dd>
          <dt>Reference</dt>
          <dd className="mono">{run.invoice_ref ?? '-'}</dd>
          <dt>Idempotency key</dt>
          <dd className="mono">{run.idempotency_key ?? '-'}</dd>
          <dt>When</dt>
          <dd>{formatDate(run.created_at)}</dd>
        </dl>
        <h3>Input invoice</h3>
        <JsonBlock value={run.input.invoice} />
        <h3>Suggestion</h3>
        <SuggestionView suggestion={run.output.suggestion} />
        <h3>Trace (what was retrieved, what was applied, pinned to the version used)</h3>
        <TraceTable ws={ws} trace={detail.trace} />
        {detail.feedback !== null && (
          <>
            <h3>Reviewer decision</h3>
            <FeedbackView feedback={detail.feedback} />
          </>
        )}
      </section>
      {detail.feedback === null && feedbackResult === null && (
        <FeedbackForm key={run.id} ws={ws} runId={run.id} suggestion={run.output.suggestion} docStructure={run.input.invoice.doc_structure ?? null} onDone={onFeedback} />
      )}
      {feedbackResult !== null && <FeedbackOutcome ws={ws} result={feedbackResult} />}
    </>
  );
}
