import { useState } from 'react';
import type { Workspace } from '../App';
import { FEEDBACK_KINDS, type FeedbackBody, type FeedbackKind, type FeedbackResult, type JsonObject, type Suggestion } from '../types';
import { JsonBlock } from '../components/JsonBlock';
import { AdjustedEditor, buildDiff, buildError, FailedEditor, initialAdjusted, initialFailed, type AdjustedState, type FailedState } from './FeedbackEditors';

interface Props {
  readonly ws: Workspace;
  readonly runId: string;
  readonly suggestion: Suggestion;
  readonly docStructure: JsonObject | null;
  onDone(result: FeedbackResult): void;
}

interface BodyInput {
  readonly kind: FeedbackKind;
  readonly runId: string;
  readonly reviewer: string;
  readonly suggestion: Suggestion;
  readonly adjusted: AdjustedState;
  readonly failed: FailedState;
}

function buildBody(input: BodyInput): FeedbackBody {
  const base = { run_id: input.runId, kind: input.kind, reviewer_id: input.reviewer };
  if (input.kind === 'adjusted') {
    const diff = buildDiff(input.suggestion, input.adjusted);
    if (Object.keys(diff).length === 0) throw new Error('An adjustment needs at least one changed value');
    return { ...base, diff };
  }
  if (input.kind === 'failed') return { ...base, error: buildError(input.failed) };
  return base;
}

/** What the API will receive: only the fields that changed, with before and after. */
function DiffPreview({ suggestion, state }: { suggestion: Suggestion; state: AdjustedState }) {
  const diff = buildDiff(suggestion, state);
  const changed = Object.keys(diff).length;
  return (
    <>
      <h3>Diff to send ({changed === 0 ? 'nothing changed yet' : `${changed} field${changed === 1 ? '' : 's'}`})</h3>
      {changed > 0 && <JsonBlock value={diff} />}
    </>
  );
}

function blocker(ws: Workspace): string | null {
  if (ws.actor.kind === 'platform') return 'Feedback is given by a tenant reviewer. Pick a tenant in "Act as".';
  if (ws.reviewer === '') return 'Enter a reviewer name in the session bar.';
  return null;
}

export function FeedbackForm({ ws, runId, suggestion, docStructure, onDone }: Props) {
  const [kind, setKind] = useState<FeedbackKind>('accepted');
  const [adjusted, setAdjusted] = useState<AdjustedState>(() => initialAdjusted(suggestion));
  const [failed, setFailed] = useState<FailedState>(() => initialFailed(docStructure));
  const [busy, setBusy] = useState(false);
  const hint = blocker(ws);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const body = buildBody({ kind, runId, reviewer: ws.reviewer, suggestion, adjusted, failed });
      onDone(await ws.api.post<FeedbackResult>('/feedback', body));
    } catch (error) {
      ws.report(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="panel form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>Reviewer feedback</h2>
      <label>
        Decision
        <select value={kind} onChange={(e) => setKind(e.target.value as FeedbackKind)}>
          {FEEDBACK_KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {kind === 'adjusted' && <AdjustedEditor state={adjusted} onChange={setAdjusted} />}
      {kind === 'adjusted' && <DiffPreview suggestion={suggestion} state={adjusted} />}
      {kind === 'failed' && <FailedEditor state={failed} onChange={setFailed} />}
      {hint !== null && <p className="notice">{hint}</p>}
      <div className="actions">
        <button type="submit" disabled={busy || hint !== null}>
          {busy ? 'Sending...' : 'Send feedback'}
        </button>
      </div>
    </form>
  );
}
