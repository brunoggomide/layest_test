import type { JsonObject } from '../../shared/json.js';
import type { KnowledgeType, Scope } from '../knowledge/types.js';

/** What the (mocked) extraction step hands to the agent. */
export interface Invoice {
  readonly vendor: string;
  readonly fields: JsonObject;
  readonly doc_structure?: JsonObject;
}

export interface Suggestion {
  account: string;
  fields: JsonObject;
  recovery_strategy?: string;
  /** One line per applied item, so a reviewer reads why the suggestion looks the way it does. */
  notes: string[];
}

export interface AppliedRef {
  readonly id: string;
  readonly version: number;
}

/** A knowledge item as the run saw it: the version and text of that moment, whatever happens to the item later. */
export interface KnowledgeRef {
  readonly id: string;
  readonly version: number;
  readonly scope: Scope;
  readonly type: KnowledgeType;
  readonly subject_key: string;
  readonly rule_text: string;
  readonly confidence: number;
}

/** Everything the agent produced for one run; stored as is, so a replay returns exactly what the first call did. */
export interface RunOutput {
  readonly suggestion: Suggestion;
  readonly anchors: readonly string[];
  readonly applied_knowledge: readonly KnowledgeRef[];
  readonly retrieved_knowledge: readonly KnowledgeRef[];
  readonly shadowed_global_knowledge: readonly KnowledgeRef[];
}

export type RunStatus = 'pending_review' | 'accepted' | 'adjusted' | 'rejected' | 'failed';

export interface RunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly invoice_ref: string | null;
  readonly idempotency_key: string | null;
  readonly input: { readonly invoice: Invoice };
  readonly output: RunOutput;
  readonly status: RunStatus;
  readonly created_at: Date;
}

export interface RunRequest {
  readonly tenantId: string;
  readonly invoice: Invoice;
  readonly invoiceRef: string | null;
  readonly idempotencyKey: string | null;
}

export interface RunResponse extends RunOutput {
  readonly run_id: string;
  /** True when the idempotency key matched an earlier run: nothing was executed again. */
  readonly replayed: boolean;
}
