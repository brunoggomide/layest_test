import type { JsonObject, JsonValue } from '../../shared/json.js';

export const FEEDBACK_KINDS = ['accepted', 'adjusted', 'rejected', 'failed'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** What the reviewer changed: field -> { before, after }. `account` is the accounting account. */
export type FeedbackDiff = Readonly<Record<string, { readonly before: JsonValue; readonly after: JsonValue }>>;

/** What a failed workflow reports. Anything beyond these fields is stored with the event and ignored by the extractor. */
export interface RunError {
  readonly code: string;
  readonly message?: string;
  readonly missing_field?: string;
  readonly doc_type?: string;
  readonly doc_structure?: JsonObject;
  readonly suggested_recovery?: string;
}

export interface FeedbackEventRow {
  readonly id: string;
  readonly run_id: string;
  readonly tenant_id: string;
  readonly kind: FeedbackKind;
  readonly diff: FeedbackDiff | null;
  readonly error: RunError | null;
  readonly reviewer_id: string;
  readonly created_at: Date;
}
