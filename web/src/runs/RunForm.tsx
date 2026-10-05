import { useState } from 'react';
import type { Workspace } from '../App';
import { parseJsonObject } from '../format';
import type { Invoice, JsonObject, RunResponse } from '../types';

interface Preset {
  readonly label: string;
  readonly vendor: string;
  readonly fields: string;
  readonly doc: string;
}

/** Ready-made invoices that line up with the scenarios, so a demo does not start by typing JSON. */
const PRESETS: readonly Preset[] = [
  { label: 'Rossi S.p.A. (plain invoice)', vendor: 'Rossi S.p.A.', fields: '{"invoice_number":"R-1001","total":1200.5,"due_date":"2026-10-01"}', doc: '' },
  { label: 'Bianchi Logistics (table layout, no header)', vendor: 'Bianchi Logistics', fields: '{"invoice_number":"B-77","line_items":3}', doc: '{"layout":"table","header":false,"columns":5}' },
  { label: 'Evergreen Farms (same table layout, new vendor)', vendor: 'Evergreen Farms', fields: '{"invoice_number":"EV-1","line_items":6}', doc: '{"layout":"table","header":false,"columns":5}' },
];

interface Props {
  readonly ws: Workspace;
  onResult(result: RunResponse, docStructure: JsonObject | null): void;
}

interface Draft {
  readonly vendor: string;
  readonly fields: string;
  readonly doc: string;
  readonly ref: string;
  readonly key: string;
}

function buildInvoice(draft: Draft): Invoice {
  const fields = parseJsonObject(draft.fields, 'Fields');
  const vendor = draft.vendor.trim();
  if (vendor === '') throw new Error('Vendor is required');
  return draft.doc.trim() === '' ? { vendor, fields } : { vendor, fields, doc_structure: parseJsonObject(draft.doc, 'Document structure') };
}

const newKey = (): string => `ui-${Math.random().toString(36).slice(2, 10)}`;

function PresetPicker({ onPick }: { onPick(preset: Preset): void }) {
  return (
    <label>
      Example invoice
      <select
        defaultValue=""
        onChange={(e) => {
          const preset = PRESETS[Number(e.target.value)];
          if (preset !== undefined) onPick(preset);
        }}
      >
        <option value="" disabled>
          Fill the form from an example
        </option>
        {PRESETS.map((preset, index) => (
          <option key={preset.label} value={index}>
            {preset.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RunForm({ ws, onResult }: Props) {
  const first = PRESETS[0] as Preset;
  const [draft, setDraft] = useState<Draft>({ vendor: first.vendor, fields: first.fields, doc: first.doc, ref: '', key: '' });
  const [busy, setBusy] = useState(false);
  const platform = ws.actor.kind === 'platform';
  const update = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const invoice = buildInvoice(draft);
      const body = draft.ref.trim() === '' ? { invoice } : { invoice, invoice_ref: draft.ref.trim() };
      const key = draft.key.trim();
      onResult(await ws.api.post<RunResponse>('/runs', body, key === '' ? {} : { 'idempotency-key': key }), invoice.doc_structure ?? null);
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
      <h2>Run the invoice agent</h2>
      {platform && <p className="notice">Runs belong to a tenant. Pick a tenant in &quot;Act as&quot; to run the agent.</p>}
      <PresetPicker onPick={(preset) => update({ vendor: preset.vendor, fields: preset.fields, doc: preset.doc })} />
      <label>
        Vendor
        <input value={draft.vendor} onChange={(e) => update({ vendor: e.target.value })} />
      </label>
      <label>
        Invoice fields (JSON object)
        <textarea value={draft.fields} onChange={(e) => update({ fields: e.target.value })} />
      </label>
      <label>
        Document structure (optional JSON object; drives the doc_pattern anchor)
        <textarea value={draft.doc} placeholder='{"layout":"table","header":false,"columns":5}' onChange={(e) => update({ doc: e.target.value })} />
      </label>
      <div className="grid-2">
        <label>
          Invoice reference (optional)
          <input value={draft.ref} placeholder="INV-A-1" onChange={(e) => update({ ref: e.target.value })} />
        </label>
        <label>
          Idempotency key (optional; the same key returns the same run)
          <span className="row">
            <input value={draft.key} placeholder="none: every call is a new run" onChange={(e) => update({ key: e.target.value })} />
            <button type="button" className="secondary" onClick={() => update({ key: newKey() })}>
              New key
            </button>
          </span>
        </label>
      </div>
      <div className="actions">
        <button type="submit" disabled={busy || platform}>
          {busy ? 'Running...' : 'Run'}
        </button>
      </div>
    </form>
  );
}
