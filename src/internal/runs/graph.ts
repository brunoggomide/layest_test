import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import type { Db } from '../../infrastructure/db/database.js';
import type { KnowledgeItem } from '../knowledge/types.js';
import { mockInvoiceAgent } from './agent.js';
import { insertRun } from './repository.js';
import { deriveAnchors, retrieveKnowledge } from './retrieve.js';
import type { AppliedRef, Invoice, KnowledgeRef, RunOutput, RunRequest, Suggestion } from './types.js';

/**
 * One agent run is a three-node graph: retrieve -> generate -> trace. The generate node is the seam
 * where the real LLM agent replaces the mock; retrieval and tracing do not change when it does.
 */
const RunState = Annotation.Root({
  request: Annotation<RunRequest>,
  invoice: Annotation<Invoice>,
  anchors: Annotation<string[]>,
  retrieved: Annotation<KnowledgeItem[]>,
  shadowedGlobal: Annotation<KnowledgeItem[]>,
  suggestion: Annotation<Suggestion | null>,
  applied: Annotation<AppliedRef[]>,
  output: Annotation<RunOutput | null>,
  runId: Annotation<string | null>,
});
type RunStateType = typeof RunState.State;

/** The tenant-scoped connection travels in `configurable`, so the compiled graph is one shared instance. */
function dbOf(config: LangGraphRunnableConfig | undefined): Db {
  const db = config?.configurable?.['db'] as Db | undefined;
  if (db === undefined || typeof db.query !== 'function') throw new Error('run graph invoked without configurable.db');
  return db;
}

const toRef = (item: KnowledgeItem): KnowledgeRef => ({
  id: item.id,
  version: item.version,
  scope: item.scope,
  type: item.type,
  subject_key: item.subject_key,
  rule_text: item.rule_text,
  confidence: item.confidence,
});

async function retrieve(state: RunStateType, config?: LangGraphRunnableConfig): Promise<Partial<RunStateType>> {
  const anchors = deriveAnchors(state.invoice);
  const { retrieved, shadowed_global } = await retrieveKnowledge(dbOf(config), state.request.tenantId, anchors);
  return { anchors, retrieved, shadowedGlobal: shadowed_global };
}

async function generate(state: RunStateType): Promise<Partial<RunStateType>> {
  return mockInvoiceAgent(state.invoice, state.retrieved);
}

async function trace(state: RunStateType, config?: LangGraphRunnableConfig): Promise<Partial<RunStateType>> {
  if (state.suggestion === null) throw new Error('trace reached without a suggestion');
  const byId = new Map(state.retrieved.map((item) => [item.id, item]));
  const output: RunOutput = {
    suggestion: state.suggestion,
    anchors: state.anchors,
    applied_knowledge: state.applied.flatMap((ref) => {
      const item = byId.get(ref.id);
      return item === undefined ? [] : [toRef(item)];
    }),
    retrieved_knowledge: state.retrieved.map(toRef),
    shadowed_global_knowledge: state.shadowedGlobal.map(toRef),
  };
  const runId = await insertRun(dbOf(config), state.request, output);
  return { output, runId };
}

const runGraph = new StateGraph(RunState)
  .addNode('retrieve', retrieve)
  .addNode('generate', generate)
  .addNode('trace', trace)
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', 'generate')
  .addEdge('generate', 'trace')
  .addEdge('trace', END)
  .compile();

/** retrieve -> generate -> trace, inside the caller's tenant transaction. */
export async function executeRun(db: Db, request: RunRequest): Promise<{ runId: string; output: RunOutput }> {
  const final = await runGraph.invoke(
    { request, invoice: request.invoice, anchors: [], retrieved: [], shadowedGlobal: [], suggestion: null, applied: [], output: null, runId: null },
    { configurable: { db } },
  );
  if (final.runId === null || final.output === null) throw new Error('run graph finished without a run id');
  return { runId: final.runId, output: final.output };
}
