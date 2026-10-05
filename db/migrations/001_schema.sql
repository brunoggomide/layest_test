-- 001_schema.sql: the data model. Applied by the admin role, which owns the tables; the application
-- roles created in 002 do not own them, so row-level security applies to everything they do.

CREATE TABLE tenants (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  invoice_ref     text,
  -- A caller-chosen key makes a retried request return the run it already created instead of a second one.
  idempotency_key text,
  input           jsonb NOT NULL,
  output          jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review', 'accepted', 'adjusted', 'rejected', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX runs_tenant_created_idx ON runs (tenant_id, created_at DESC);

CREATE TABLE feedback_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One reviewer decision per run: a replay of the same decision is idempotent, a different one is refused.
  run_id      uuid NOT NULL UNIQUE REFERENCES runs(id),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL CHECK (kind IN ('accepted', 'adjusted', 'rejected', 'failed')),
  diff        jsonb,
  error       jsonb,
  reviewer_id text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_events_tenant_idx ON feedback_events (tenant_id, created_at DESC);

CREATE TABLE knowledge_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 text NOT NULL CHECK (scope IN ('tenant', 'global')),
  tenant_id             uuid REFERENCES tenants(id),
  type                  text NOT NULL CHECK (type IN (
                          'account_mapping', 'account_veto', 'booking_rule', 'naming_convention',
                          'field_mapping', 'extraction_failure_pattern')),
  -- What the item is about ('vendor=rossi', 'tenant', 'doc_pattern=<sha1>'): the retrieval key.
  anchor                text NOT NULL,
  -- The slot of truth ('vendor=rossi|account'): at most one ACTIVE item per slot and scope.
  subject_key           text NOT NULL,
  rule                  jsonb NOT NULL,
  rule_text             text NOT NULL,
  supporting_context    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'candidate' CHECK (status IN (
                          'candidate', 'accepted', 'active', 'rejected', 'disabled', 'superseded')),
  confidence            numeric(3, 2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count        int NOT NULL DEFAULT 1,
  contested_count       int NOT NULL DEFAULT 0,
  distinct_tenant_count int NOT NULL DEFAULT 1,
  source_event_id       uuid REFERENCES feedback_events(id),
  source_run_id         uuid REFERENCES runs(id),
  version               int NOT NULL DEFAULT 1,
  supersedes_id         uuid REFERENCES knowledge_items(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           text,
  activated_at          timestamptz,
  valid_until           timestamptz,
  CHECK ((scope = 'global') = (tenant_id IS NULL))
);

-- Exactly one active truth per (scope, tenant, slot), for every role. Global rows share one sentinel tenant.
CREATE UNIQUE INDEX one_active_per_key
  ON knowledge_items (scope, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), subject_key)
  WHERE status = 'active';

CREATE INDEX knowledge_items_retrieval_idx ON knowledge_items (anchor, scope, tenant_id) WHERE status = 'active';
CREATE INDEX knowledge_items_tenant_status_idx ON knowledge_items (tenant_id, status);
CREATE INDEX knowledge_items_subject_idx ON knowledge_items (subject_key, type, status);
CREATE INDEX knowledge_items_supersedes_idx ON knowledge_items (supersedes_id);

-- Which feedback events support an item. A global item links the events of every source tenant.
CREATE TABLE knowledge_evidence (
  knowledge_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  feedback_event_id uuid NOT NULL REFERENCES feedback_events(id),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (knowledge_item_id, feedback_event_id)
);

-- Provenance of a run: what was handed to the agent and what changed its output, version pinned.
CREATE TABLE run_knowledge_trace (
  run_id            uuid NOT NULL REFERENCES runs(id),
  knowledge_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  version           int NOT NULL,
  role              text NOT NULL CHECK (role IN ('retrieved', 'applied')),
  PRIMARY KEY (run_id, knowledge_item_id, role)
);
CREATE INDEX run_knowledge_trace_item_idx ON run_knowledge_trace (knowledge_item_id);
