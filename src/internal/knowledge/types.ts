import type { JsonObject } from '../../shared/json.js';

export type Scope = 'tenant' | 'global';

export const KNOWLEDGE_TYPES = [
  'account_mapping',
  'account_veto',
  'booking_rule',
  'naming_convention',
  'field_mapping',
  'extraction_failure_pattern',
] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export const KNOWLEDGE_STATUSES = ['candidate', 'accepted', 'active', 'rejected', 'disabled', 'superseded'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

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
  readonly created_at: Date;
  readonly reviewed_at: Date | null;
  readonly reviewed_by: string | null;
  readonly activated_at: Date | null;
  readonly valid_until: Date | null;
}

/** What an extractor proposes. Persistence adds scope, status, provenance and timestamps. */
export interface KnowledgeCandidate {
  readonly type: KnowledgeType;
  readonly anchor: string;
  readonly subject_key: string;
  readonly rule: JsonObject;
  readonly rule_text: string;
  readonly supporting_context: JsonObject;
  readonly confidence: number;
}
