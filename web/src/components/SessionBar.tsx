import { describeActor, PLATFORM, type Actor, type Session } from '../session';
import type { Tenant } from '../types';
import { Badge } from './Badge';

interface Props {
  readonly session: Session;
  readonly tenants: readonly Tenant[];
  readonly actor: Actor;
  onChange(patch: Partial<Session>): void;
}

export function SessionBar({ session, tenants, actor, onChange }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <h1>
            Billay knowledge base
            <span className="brand-sub">Review console</span>
          </h1>
        </div>
        <div className="session-controls">
          <label>
            Service token
            <input type="password" autoComplete="off" value={session.token} placeholder="SERVICE_TOKEN from .env" onChange={(e) => onChange({ token: e.target.value })} />
          </label>
          <label>
            Reviewer
            <input value={session.reviewer} placeholder="anna@alpha" onChange={(e) => onChange({ reviewer: e.target.value })} />
          </label>
          <label>
            Act as
            <select value={actor.kind === 'platform' ? PLATFORM : actor.id} disabled={tenants.length === 0} onChange={(e) => onChange({ actorKey: e.target.value })}>
              <option value={PLATFORM}>Platform reviewer</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="actor" title="Each request carries this identity; isolation is enforced by the database.">
          <Badge value={actor.kind} />
          <span>{describeActor(actor)}</span>
        </div>
      </div>
    </header>
  );
}
