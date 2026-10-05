export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type Scope = 'tenant' | 'global';

export const KNOWLEDGE_TYPES = ['account_mapping', 'account_veto', 'booking_rule', 'naming_convention', 'field_mapping', 'extraction_failure_pattern'] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export const KNOWLEDGE_STATUSES = ['candidate', 'accepted', 'active', 'rejected', 'disabled', 'superseded'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const FEEDBACK_KINDS = ['accepted', 'adjusted', 'rejected', 'failed'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface Tenant {
  readonly id: string;
  readonly name: string;
}

export interface KnowledgeItem {
  readonly id: string;
  readonly scope: Scope;
  readonly tenant_id: string | null;
  readonly type: KnowledgeType;
  readonly anchor: string;
  readonly subject_key: string;
  readonly rule: JsonObject;
  readonly rule_text: string;
  readonly supporting_context: JsonObject;
  readonly status: KnowledgeStatus;
  readonly confidence: number;
  readonly evidence_count: number;
  readonly contested_count: number;
  readonly distinct_tenant_count: number;
  readonly source_event_id: string | null;
  readonly source_run_id: string | null;
  readonly version: number;
  readonly supersedes_id: string | null;
  readonly created_at: string;
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
  readonly activated_at: string | null;
  readonly valid_until: string | null;
}

export interface KnowledgeRef {
  readonly id: string;
  readonly version: number;
  readonly scope: Scope;
  readonly type: KnowledgeType;
  readonly subject_key: string;
  readonly rule_text: string;
  readonly confidence: number;
}

export interface Suggestion {
  readonly account: string;
  readonly fields: JsonObject;
  readonly recovery_strategy?: string;
  readonly notes: readonly string[];
}

export interface Invoice {
  readonly vendor: string;
  readonly fields: JsonObject;
  readonly doc_structure?: JsonObject;
}

export interface RunOutput {
  readonly suggestion: Suggestion;
  readonly anchors: readonly string[];
  readonly applied_knowledge: readonly KnowledgeRef[];
  readonly retrieved_knowledge: readonly KnowledgeRef[];
  readonly shadowed_global_knowledge: readonly KnowledgeRef[];
}

export interface RunResponse extends RunOutput {
  readonly run_id: string;
  /** The idempotency key matched an earlier run: nothing executed again. */
  readonly replayed: boolean;
}

export interface RunSummary {
  readonly id: string;
  readonly tenant_id: string;
  readonly invoice_ref: string | null;
  readonly vendor: string;
  readonly account: string;
  readonly status: string;
  readonly created_at: string;
}

export interface TraceRow {
  readonly knowledge_item_id: string;
  readonly version: number;
  readonly role: 'retrieved' | 'applied';
  readonly scope: Scope;
  readonly type: KnowledgeType;
  readonly subject_key: string;
  readonly rule_text: string;
  readonly current_status: KnowledgeStatus;
  readonly current_version: number;
}

export interface FeedbackSummary {
  readonly id: string;
  readonly kind: FeedbackKind;
  readonly reviewer_id: string;
  readonly diff: Json | null;
  readonly error: Json | null;
  readonly created_at: string;
}

export interface RunDetail {
  readonly run: {
    readonly id: string;
    readonly tenant_id: string;
    readonly invoice_ref: string | null;
    readonly idempotency_key: string | null;
    readonly input: { readonly invoice: Invoice };
    readonly output: RunOutput;
    readonly status: string;
    readonly created_at: string;
  };
  readonly feedback: FeedbackSummary | null;
  readonly trace: readonly TraceRow[];
}

export interface DiffEntry {
  readonly before: Json;
  readonly after: Json;
}
export type Diff = Record<string, DiffEntry>;

export interface RunError {
  readonly code: string;
  readonly message?: string;
  readonly missing_field?: string;
  readonly doc_type?: string;
  readonly doc_structure?: JsonObject;
  readonly suggested_recovery?: string;
}

export interface FeedbackBody {
  readonly run_id: string;
  readonly kind: FeedbackKind;
  readonly reviewer_id: string;
  readonly diff?: Diff;
  readonly error?: RunError;
}

export interface FeedbackResult {
  readonly event_id: string;
  readonly run_id: string;
  readonly kind: FeedbackKind;
  readonly idempotent_replay: boolean;
  readonly classification?: 'transient' | 'structural';
  readonly created_items: readonly KnowledgeItem[];
  readonly reinforced_item_ids: readonly string[];
  readonly contested_item_ids: readonly string[];
  readonly notes: readonly string[];
}

export interface AcceptOutcome {
  readonly item: KnowledgeItem;
  readonly status: 'active' | 'accepted' | 'rejected';
  readonly pending_conflict_with?: string;
  readonly superseded_id?: string;
}

export interface PromotionDecision {
  readonly type: KnowledgeType;
  readonly subject_key: string;
  readonly tenant_ids: readonly string[];
  readonly source_item_ids: readonly string[];
  readonly outcome: 'promoted' | 'refused' | 'skipped';
  readonly reason: string;
  readonly sanitizer?: { readonly ok: boolean; readonly stripped: readonly string[]; readonly rule?: JsonObject; readonly rule_text?: string; readonly reason?: string };
  readonly global_item_id?: string;
}

export interface PromotionReport {
  readonly min_tenants: number;
  readonly decisions: readonly PromotionDecision[];
}
