import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApi, type Api } from './api';
import { ErrorBanner } from './components/ErrorBanner';
import { SessionBar } from './components/SessionBar';
import { KnowledgeTab } from './knowledge/KnowledgeTab';
import { PromotionTab } from './promotion/PromotionTab';
import { RunsTab } from './runs/RunsTab';
import { actorHeaders, loadSession, resolveActor, saveSession, type Actor, type Session } from './session';
import type { Tenant } from './types';

type Tab = 'runs' | 'knowledge' | 'promotion';
const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'runs', label: 'Runs' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'promotion', label: 'Promotion' },
];

/** What every tab needs: who is acting, how to call the API, where errors go and how to jump to an item. */
export interface Workspace {
  readonly api: Api;
  readonly actor: Actor;
  readonly reviewer: string;
  readonly report: (error: unknown) => void;
  readonly openKnowledge: (id: string) => void;
}

interface TabsProps {
  readonly ws: Workspace;
  readonly tab: Tab;
  readonly selectedItem: string | null;
  onTab(tab: Tab): void;
  onSelectItem(id: string | null): void;
}

function Tabs({ ws, tab, selectedItem, onTab, onSelectItem }: TabsProps) {
  return (
    <>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((entry) => (
          <button key={entry.id} type="button" className={entry.id === tab ? 'active' : ''} aria-current={entry.id === tab ? 'page' : undefined} onClick={() => onTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </nav>
      {tab === 'runs' && <RunsTab ws={ws} />}
      {tab === 'knowledge' && <KnowledgeTab ws={ws} selectedId={selectedItem} onSelect={onSelectItem} />}
      {tab === 'promotion' && <PromotionTab ws={ws} />}
    </>
  );
}

export function App() {
  const [session, setSessionState] = useState<Session>(loadSession);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tab, setTab] = useState<Tab>('runs');
  const [error, setError] = useState<unknown>(null);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);

  const setSession = (patch: Partial<Session>): void => {
    const next = { ...session, ...patch };
    saveSession(next);
    setSessionState(next);
  };

  useEffect(() => {
    if (session.token === '') {
      setTenants([]);
      return;
    }
    createApi(actorHeaders({ kind: 'platform' }, session.token)).get<Tenant[]>('/tenants').then(setTenants).catch(setError);
  }, [session.token]);

  const actor = useMemo(() => resolveActor(session.actorKey, tenants), [session.actorKey, tenants]);
  // A selected item may not be visible to the next actor: start the tab clean when the identity changes.
  useEffect(() => setSelectedItem(null), [actor]);

  const report = useCallback((failure: unknown) => setError(failure), []);
  const openKnowledge = useCallback((id: string) => {
    setSelectedItem(id);
    setTab('knowledge');
  }, []);
  const ws = useMemo<Workspace>(
    () => ({ api: createApi(actorHeaders(actor, session.token)), actor, reviewer: session.reviewer.trim(), report, openKnowledge }),
    [actor, session.token, session.reviewer, report, openKnowledge],
  );

  return (
    <>
      <SessionBar session={session} tenants={tenants} actor={actor} onChange={setSession} />
      <main className="app">
        {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
        {session.token === '' ? (
          <p className="empty">Enter the service token (SERVICE_TOKEN in .env) and a reviewer name to load the tenants and start.</p>
        ) : (
          <Tabs ws={ws} tab={tab} selectedItem={selectedItem} onTab={setTab} onSelectItem={setSelectedItem} />
        )}
      </main>
    </>
  );
}
