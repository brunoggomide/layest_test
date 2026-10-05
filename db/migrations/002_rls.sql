-- 002_rls.sql: roles and row-level security. This file is the tenant-isolation guarantee.
--
--   billay_app      the HTTP API for tenant requests. Subject to RLS: sees its own tenant rows and
--                   global knowledge (read-only); cannot write global rows.
--   billay_service  the platform scope: global review and the promotion job. BYPASSRLS.
--
-- Per request the API runs, inside a transaction:
--   SELECT set_config('app.tenant_id', $1, true)
-- which is the parameterizable form of SET LOCAL (SET LOCAL cannot take bind parameters).
--
-- The roles are created without a password: no credential lives in a migration file.
-- `npm run migrate` applies the passwords from the environment afterwards.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billay_app') THEN
    CREATE ROLE billay_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billay_service') THEN
    CREATE ROLE billay_service LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO billay_app, billay_service;

-- No DELETE privilege for anyone: knowledge is disabled by status and history is immutable.
GRANT SELECT ON tenants TO billay_app;
GRANT SELECT, INSERT, UPDATE ON tenants TO billay_service;
GRANT SELECT, INSERT, UPDATE ON runs, feedback_events, knowledge_items, knowledge_evidence, run_knowledge_trace
  TO billay_app, billay_service;

-- The current tenant. Unset or empty yields NULL, so a request without tenant context matches no tenant row.
CREATE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_evidence  ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_knowledge_trace ENABLE ROW LEVEL SECURITY;

-- billay_app ------------------------------------------------------------------------------------

CREATE POLICY tenants_self ON tenants FOR SELECT TO billay_app
  USING (id = app_tenant_id());

CREATE POLICY runs_tenant_isolation ON runs FOR ALL TO billay_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY feedback_tenant_isolation ON feedback_events FOR ALL TO billay_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY evidence_tenant_isolation ON knowledge_evidence FOR ALL TO billay_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Own tenant rows, plus global rows read-only.
CREATE POLICY knowledge_app_select ON knowledge_items FOR SELECT TO billay_app
  USING (scope = 'global' OR tenant_id = app_tenant_id());

-- A tenant connection can only ever create or modify tenant rows of its own tenant.
CREATE POLICY knowledge_app_insert ON knowledge_items FOR INSERT TO billay_app
  WITH CHECK (scope = 'tenant' AND tenant_id = app_tenant_id());

CREATE POLICY knowledge_app_update ON knowledge_items FOR UPDATE TO billay_app
  USING (scope = 'tenant' AND tenant_id = app_tenant_id())
  WITH CHECK (scope = 'tenant' AND tenant_id = app_tenant_id());

-- Trace rows carry no tenant id: they are isolated through the run that owns them.
CREATE POLICY trace_tenant_isolation ON run_knowledge_trace FOR ALL TO billay_app
  USING (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_knowledge_trace.run_id AND r.tenant_id = app_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_knowledge_trace.run_id AND r.tenant_id = app_tenant_id()));

-- billay_service (explicit allow-all; the role also has BYPASSRLS) -------------------------------

CREATE POLICY tenants_service_all   ON tenants             FOR ALL TO billay_service USING (true) WITH CHECK (true);
CREATE POLICY runs_service_all      ON runs                FOR ALL TO billay_service USING (true) WITH CHECK (true);
CREATE POLICY feedback_service_all  ON feedback_events     FOR ALL TO billay_service USING (true) WITH CHECK (true);
CREATE POLICY knowledge_service_all ON knowledge_items     FOR ALL TO billay_service USING (true) WITH CHECK (true);
CREATE POLICY evidence_service_all  ON knowledge_evidence  FOR ALL TO billay_service USING (true) WITH CHECK (true);
CREATE POLICY trace_service_all     ON run_knowledge_trace FOR ALL TO billay_service USING (true) WITH CHECK (true);
