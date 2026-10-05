import type { PromotionReport } from './promote.js';

export function formatPromotionReport(report: PromotionReport): string[] {
  const lines = [`global promotion report (min distinct tenants: ${report.min_tenants})`];
  if (report.decisions.length === 0) return [...lines, '  no active tenant knowledge to consider'];
  for (const decision of report.decisions) {
    lines.push(`  [${decision.outcome.toUpperCase().padEnd(8)}] ${decision.type} ${decision.subject_key} | tenants=${decision.tenant_ids.length} items=${decision.source_item_ids.length}`);
    lines.push(`             reason: ${decision.reason}`);
    if (decision.sanitizer?.ok === true) {
      lines.push(`             sanitizer stripped: ${JSON.stringify(decision.sanitizer.stripped)}`);
      lines.push(`             sanitized rule: ${JSON.stringify(decision.sanitizer.rule)}`);
      lines.push(`             sanitized rule_text: ${decision.sanitizer.rule_text}`);
    }
    if (decision.global_item_id !== undefined) lines.push(`             global candidate: ${decision.global_item_id}`);
  }
  return lines;
}
