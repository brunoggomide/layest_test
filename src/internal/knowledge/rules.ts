import { z } from 'zod';
import { validation } from '../../http/errors.js';
import type { JsonObject } from '../../shared/json.js';
import type { KnowledgeType } from './types.js';

const identifier = z.string().min(1).max(200);
const primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** The shape the agent can apply, per type. An edit that does not fit is refused before it can become active. */
const RULE_SCHEMAS: Readonly<Record<KnowledgeType, z.ZodTypeAny>> = {
  account_mapping: z.object({ account: z.string().min(1).max(50) }).strict(),
  account_veto: z.object({ forbidden_accounts: z.array(z.string().min(1).max(50)).min(1) }).strict(),
  booking_rule: z.object({ field: identifier, value: primitive }).strict(),
  naming_convention: z.object({ field: identifier, template: z.string().min(1).max(500) }).strict(),
  field_mapping: z.object({ from: identifier, to: identifier }).strict(),
  extraction_failure_pattern: z
    .object({
      doc_structure: z.record(primitive),
      error_signature: identifier,
      missing_field: identifier.optional(),
      recovery_strategy: identifier.optional(),
    })
    .strict(),
};

export function parseRule(type: KnowledgeType, rule: JsonObject): JsonObject {
  const result = RULE_SCHEMAS[type].safeParse(rule);
  if (!result.success) throw validation(`rule does not match type '${type}'`, result.error.issues);
  return rule;
}
