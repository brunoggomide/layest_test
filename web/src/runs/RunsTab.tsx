import { useCallback, useEffect, useState } from 'react';
import type { Workspace } from '../App';
import type { FeedbackResult, JsonObject, RunDetail as Detail, RunResponse, RunSummary } from '../types';
import { FeedbackForm } from './FeedbackForm';
import { FeedbackOutcome } from './FeedbackOutcome';
import { RunDetail } from './RunDetail';
import { RunForm } from './RunForm';
import { RunList } from './RunList';
import { RunResult } from './RunResult';

interface Fresh {
  readonly run: RunResponse;
  readonly docStructure: JsonObject | null;
}

/** The left column: run the agent, read the result, give feedback on it. */
function Workbench({ ws, onChange }: { ws: Workspace; onChange(): void }) {
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null);
  useEffect(() => {
    setFresh(null);
    setFeedback(null);
  }, [ws]);

  const onResult = (run: RunResponse, docStructure: JsonObject | null): void => {
    setFresh({ run, docStructure });
    setFeedback(null);
    onChange();
  };
  const onFeedback = (result: FeedbackResult): void => {
    setFeedback(result);
    onChange();
  };

  return (
    <div>
      <RunForm ws={ws} onResult={onResult} />
      {fresh !== null && <RunResult ws={ws} result={fresh.run} />}
      {fresh !== null && feedback === null && (
        // Keyed by run: a new run gets a fresh form instead of inheriting the previous run's edits.
        <FeedbackForm key={fresh.run.run_id} ws={ws} runId={fresh.run.run_id} suggestion={fresh.run.suggestion} docStructure={fresh.docStructure} onDone={onFeedback} />
      )}
      {feedback !== null && <FeedbackOutcome ws={ws} result={feedback} />}
    </div>
  );
}

export function RunsTab({ ws }: { ws: Workspace }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailFeedback, setDetailFeedback] = useState<FeedbackResult | null>(null);

  const loadRuns = useCallback(() => ws.api.get<RunSummary[]>('/runs').then(setRuns).catch(ws.report), [ws]);
  const openRun = useCallback((id: string) => ws.api.get<Detail>(`/runs/${id}`).then(setDetail).catch(ws.report), [ws]);
  useEffect(() => {
    setDetail(null);
    setDetailFeedback(null);
    void loadRuns();
  }, [loadRuns]);

  const onDetailFeedback = (result: FeedbackResult): void => {
    setDetailFeedback(result);
    void loadRuns();
    void openRun(result.run_id);
  };

  return (
    <div className="columns">
      <Workbench ws={ws} onChange={() => void loadRuns()} />
      <div>
        <RunList
          runs={runs}
          selectedId={detail?.run.id ?? null}
          onOpen={(id) => {
            setDetailFeedback(null);
            void openRun(id);
          }}
        />
        {detail !== null && <RunDetail ws={ws} detail={detail} feedbackResult={detailFeedback} onFeedback={onDetailFeedback} />}
      </div>
    </div>
  );
}
