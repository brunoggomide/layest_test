import { useState } from 'react';
import type { Workspace } from '../App';
import { asString, parseJsonObject, shortId } from '../format';
import type { AcceptOutcome, KnowledgeItem } from '../types';

export interface ActionResult {
  readonly message: string;
  /** The item to show next, when the action created one (an edit). */
  readonly selectId?: string;
}

interface Props {
  readonly ws: Workspace;
  readonly item: KnowledgeItem;
  onDone(result: ActionResult): void;
}

const REVIEWABLE = new Set(['candidate', 'accepted']);
const EDITABLE = new Set(['candidate', 'accepted', 'active']);

function describeAccept(outcome: AcceptOutcome): string {
  if (outcome.status === 'active') {
    return outcome.superseded_id === undefined ? 'Accepted and activated.' : `Accepted and activated; superseded ${shortId(outcome.superseded_id)}.`;
  }
  if (outcome.status === 'accepted') return `Accepted but held: item ${shortId(outcome.pending_conflict_with ?? '')} holds the slot. Resolve the conflict.`;
  return 'Rejected.';
}

function blocker(ws: Workspace, item: KnowledgeItem): string | null {
  if (item.scope === 'global' && ws.actor.kind !== 'platform') return 'Global knowledge is reviewed by the platform reviewer only.';
  if (item.scope === 'tenant' && ws.actor.kind === 'platform') return 'Tenant knowledge is reviewed by that tenant. Pick the tenant in "Act as".';
  if (ws.reviewer === '') return 'Enter a reviewer name in the session bar.';
  return null;
}

function EditForm({ ws, item, onDone }: Props) {
  const [rule, setRule] = useState(() => JSON.stringify(item.rule, null, 2));
  const [text, setText] = useState(item.rule_text);
  const submit = async (): Promise<void> => {
    try {
      const body = { reviewer_id: ws.reviewer, rule: parseJsonObject(rule, 'Rule'), rule_text: text.trim() };
      const created = await ws.api.post<KnowledgeItem>(`/knowledge/${item.id}/edit`, body);
      onDone({ message: `Created version ${created.version} as a candidate; version ${item.version} is untouched until it is accepted.`, selectId: created.id });
    } catch (error) {
      ws.report(error);
    }
  };
  return (
    <div className="form">
      <h3>Edit (creates a new version as a candidate)</h3>
      <label>
        Rule (JSON, must fit the type {item.type})
        <textarea value={rule} onChange={(e) => setRule(e.target.value)} />
      </label>
      <label>
        Rule text
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="actions">
        <button type="button" onClick={() => void submit()}>
          Save as new version
        </button>
      </div>
    </div>
  );
}

export function KnowledgeActions({ ws, item, onDone }: Props) {
  const [validUntil, setValidUntil] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const hint = blocker(ws, item);
  if (hint !== null) return <p className="notice">{hint}</p>;

  const post = async (action: string, body: Record<string, unknown>, describe: (result: unknown) => string): Promise<void> => {
    setBusy(true);
    try {
      const result = await ws.api.post<unknown>(`/knowledge/${item.id}/${action}`, { reviewer_id: ws.reviewer, ...body });
      onDone({ message: describe(result) });
    } catch (error) {
      ws.report(error);
    } finally {
      setBusy(false);
    }
  };
  const accept = (): Promise<void> => post('accept', validUntil === '' ? {} : { valid_until: new Date(validUntil).toISOString() }, (r) => describeAccept(r as AcceptOutcome));
  const resolve = (winner: 'new' | 'existing'): Promise<void> => post('resolve-conflict', { winner }, (r) => describeAccept(r as AcceptOutcome));
  const conflictsWith = asString(item.supporting_context['conflicts_with']);

  return (
    <>
      <div className="actions" aria-busy={busy}>
        {REVIEWABLE.has(item.status) && (
          <>
            <label className="row">
              <span className="muted">valid until (optional)</span>
              <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </label>
            <button type="button" disabled={busy} onClick={() => void accept()}>
              Accept
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void post('reject', {}, () => 'Rejected.')}>
              Reject
            </button>
          </>
        )}
        {item.status === 'accepted' && conflictsWith !== null && (
          <>
            <button type="button" className="secondary" disabled={busy} onClick={() => void resolve('existing')}>
              Keep existing ({shortId(conflictsWith)})
            </button>
            <button type="button" disabled={busy} onClick={() => void resolve('new')}>
              Use this one
            </button>
          </>
        )}
        {EDITABLE.has(item.status) && (
          <button type="button" className="secondary" onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
        )}
        {EDITABLE.has(item.status) && (
          <button type="button" className="danger" disabled={busy} onClick={() => void post('disable', {}, () => 'Disabled: the row stays, the slot is free.')}>
            Disable
          </button>
        )}
      </div>
      {editing && <EditForm ws={ws} item={item} onDone={onDone} />}
    </>
  );
}
