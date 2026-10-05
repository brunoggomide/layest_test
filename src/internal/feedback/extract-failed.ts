import type { JsonObject } from '../../shared/json.js';
import { asStructuralIdentifier, docPatternSubject, structuralFeatures } from '../knowledge/keys.js';
import type { KnowledgeCandidate } from '../knowledge/types.js';
import type { RunRow } from '../runs/types.js';
import type { ExtractionResult } from './extract.js';
import type { RunError } from './types.js';

/** Errors that say nothing about the document: recorded on the run, never turned into knowledge. */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set(['TIMEOUT', 'RATE_LIMIT', 'UPSTREAM_5XX']);

export type FailureClass = 'transient' | 'structural';

export function classifyFailure(error: RunError): FailureClass {
  return TRANSIENT_ERROR_CODES.has(error.code.toUpperCase()) ? 'transient' : 'structural';
}

function patternCandidate(docStructure: JsonObject, code: string, error: RunError): KnowledgeCandidate {
  const features = structuralFeatures(docStructure);
  const missingField = asStructuralIdentifier(error.missing_field);
  const errorSignature = missingField === undefined ? code : `${code}:${missingField}`;
  const recovery = asStructuralIdentifier(error.suggested_recovery);
  const docType = asStructuralIdentifier(error.doc_type) ?? (typeof features['doc_type'] === 'string' ? features['doc_type'] : undefined);

  const rule: JsonObject = { doc_structure: features, error_signature: errorSignature };
  if (missingField !== undefined) rule['missing_field'] = missingField;
  if (recovery !== undefined) rule['recovery_strategy'] = recovery;
  const featureText = Object.entries(features)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  return {
    type: 'extraction_failure_pattern',
    ...docPatternSubject(docStructure),
    rule,
    rule_text: `Documents with structure {${featureText}} fail with ${errorSignature}${recovery === undefined ? '' : `; recover with '${recovery}'`}`,
    // Structural facts only, by construction: the error message and the invoice payload never enter the knowledge base.
    supporting_context: docType === undefined ? {} : { doc_type: docType },
    confidence: 0.5,
  };
}

export function extractFailed(run: RunRow, error: RunError | null): ExtractionResult {
  if (error === null) return { candidates: [], notes: ['failed feedback carried no error payload; nothing to learn'] };
  if (classifyFailure(error) === 'transient') return { candidates: [], notes: [`error ${error.code} is transient; recorded on the run, no knowledge created`] };
  const code = asStructuralIdentifier(error.code);
  if (code === undefined) return { candidates: [], notes: [`error code '${error.code}' is not an identifier; no error signature to learn`] };
  const docStructure = error.doc_structure ?? run.input.invoice.doc_structure;
  if (docStructure === undefined) return { candidates: [], notes: [`structural failure ${code} carries no doc_structure; no document pattern to learn`] };
  return { candidates: [patternCandidate(docStructure, code, error)], notes: [] };
}
