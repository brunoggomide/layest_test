import { useState } from 'react';
import { displayValue, parseJsonObject, parseScalar } from '../format';
import type { Diff, JsonObject, RunError, Suggestion } from '../types';

export interface AdjustedState {
  readonly account: string;
  readonly edits: Readonly<Record<string, string>>;
}

export function initialAdjusted(suggestion: Suggestion): AdjustedState {
  return { account: suggestion.account, edits: Object.fromEntries(Object.entries(suggestion.fields).map(([field, value]) => [field, displayValue(value)])) };
}

/** Only what the reviewer changed: before is the suggestion, after is the parsed input. */
export function buildDiff(suggestion: Suggestion, state: AdjustedState): Diff {
  const diff: Diff = {};
  if (state.account.trim() !== suggestion.account) diff['account'] = { before: suggestion.account, after: state.account.trim() };
  for (const [field, text] of Object.entries(state.edits)) {
    const before = suggestion.fields[field] ?? null;
    if (displayValue(before) === text) continue;
    diff[field] = { before, after: parseScalar(text) };
  }
  return diff;
}

interface AdjustedProps {
  readonly state: AdjustedState;
  onChange(state: AdjustedState): void;
}

export function AdjustedEditor({ state, onChange }: AdjustedProps) {
  const [newField, setNewField] = useState('');
  const setEdit = (field: string, value: string): void => onChange({ ...state, edits: { ...state.edits, [field]: value } });
  const addField = (): void => {
    const name = newField.trim();
    if (name === '' || name in state.edits) return;
    setEdit(name, '');
    setNewField('');
  };
  return (
    <>
      <h3>Corrected output (leave a field unchanged to keep it; empty means null)</h3>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Corrected value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono">account</td>
            <td>
              <input value={state.account} onChange={(e) => onChange({ ...state, account: e.target.value })} />
            </td>
          </tr>
          {Object.entries(state.edits).map(([field, value]) => (
            <tr key={field}>
              <td className="mono">{field}</td>
              <td>
                <input value={value} onChange={(e) => setEdit(field, e.target.value)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input value={newField} placeholder="new field name (e.g. cost_center)" onChange={(e) => setNewField(e.target.value)} />
        <button type="button" className="secondary" onClick={addField}>
          Add field
        </button>
      </div>
    </>
  );
}

export interface FailedState {
  readonly code: string;
  readonly message: string;
  readonly missingField: string;
  readonly docType: string;
  readonly recovery: string;
  readonly docStructure: string;
}

export function initialFailed(docStructure: JsonObject | null): FailedState {
  return { code: 'MISSING_FIELD', message: '', missingField: 'total_amount', docType: 'invoice', recovery: 'sum_line_items', docStructure: docStructure === null ? '' : JSON.stringify(docStructure) };
}

const optional = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());

export function buildError(state: FailedState): RunError {
  const code = state.code.trim();
  if (code === '') throw new Error('Error code is required');
  const error: RunError = { code };
  const message = optional(state.message);
  const missingField = optional(state.missingField);
  const docType = optional(state.docType);
  const recovery = optional(state.recovery);
  const docStructure = state.docStructure.trim() === '' ? undefined : parseJsonObject(state.docStructure, 'Document structure');
  return {
    ...error,
    ...(message === undefined ? {} : { message }),
    ...(missingField === undefined ? {} : { missing_field: missingField }),
    ...(docType === undefined ? {} : { doc_type: docType }),
    ...(recovery === undefined ? {} : { suggested_recovery: recovery }),
    ...(docStructure === undefined ? {} : { doc_structure: docStructure }),
  };
}

interface FailedProps {
  readonly state: FailedState;
  onChange(state: FailedState): void;
}

export function FailedEditor({ state, onChange }: FailedProps) {
  const field = (key: keyof FailedState, label: string, placeholder = ''): React.JSX.Element => (
    <label>
      {label}
      <input value={state[key]} placeholder={placeholder} onChange={(e) => onChange({ ...state, [key]: e.target.value })} />
    </label>
  );
  return (
    <>
      <h3>Failure report (TIMEOUT, RATE_LIMIT and UPSTREAM_5XX are transient and teach nothing)</h3>
      {field('code', 'Error code')}
      {field('message', 'Message (free text; never enters the knowledge base)')}
      {field('missingField', 'Missing field')}
      {field('docType', 'Document type')}
      {field('recovery', 'Suggested recovery')}
      <label>
        Document structure (JSON object; defaults to the invoice&apos;s when left empty)
        <textarea value={state.docStructure} placeholder='{"layout":"table","header":false,"columns":5}' onChange={(e) => onChange({ ...state, docStructure: e.target.value })} />
      </label>
    </>
  );
}
