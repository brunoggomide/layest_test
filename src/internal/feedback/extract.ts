import type { KnowledgeCandidate } from '../knowledge/types.js';
import { accountSubject } from '../knowledge/keys.js';
import { UNMAPPED_ACCOUNT } from '../runs/agent.js';
import type { RunRow } from '../runs/types.js';
import { extractAdjusted } from './extract-adjusted.js';
import { extractFailed } from './extract-failed.js';
import type { FeedbackDiff, RunError } from './types.js';

export interface ExtractionInput {
  readonly kind: 'adjusted' | 'rejected' | 'failed';
  readonly run: RunRow;
  readonly diff: FeedbackDiff | null;
  readonly error: RunError | null;
}

export interface ExtractionResult {
  readonly candidates: KnowledgeCandidate[];
  /** Why something was or was not extracted; returned to the caller and shown in the dashboard. */
  readonly notes: string[];
}

/**
 * The boundary where feedback becomes knowledge candidates. The deterministic extractor is the only
 * implementation; an LLM-backed one would implement the same contract and its output would still be
 * a candidate that goes through the same review, the same sanitizer and the same row-level security.
 */
export interface KnowledgeExtractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

/** A rejection with no correction still teaches one thing: this account was wrong for this vendor. */
function extractRejected(run: RunRow): ExtractionResult {
  const { vendor } = run.input.invoice;
  const { account } = run.output.suggestion;
  if (account === UNMAPPED_ACCOUNT) return { candidates: [], notes: ['the rejected suggestion had no account to forbid; applied items were marked as contested'] };
  return {
    candidates: [
      {
        type: 'account_veto',
        ...accountSubject(vendor),
        rule: { forbidden_accounts: [account] },
        rule_text: `Vendor ${vendor} must not map to account ${account} (rejected by reviewer, no correction given)`,
        supporting_context: { source: 'reviewer_rejection', rejected_account: account, invoice_ref: run.invoice_ref },
        confidence: 0.3,
      },
    ],
    notes: [],
  };
}

export const deterministicExtractor: KnowledgeExtractor = {
  name: 'deterministic-diff-extractor',
  async extract(input) {
    switch (input.kind) {
      case 'adjusted':
        return extractAdjusted(input.run, input.diff ?? {});
      case 'rejected':
        return extractRejected(input.run);
      case 'failed':
        return extractFailed(input.run, input.error);
    }
  },
};
