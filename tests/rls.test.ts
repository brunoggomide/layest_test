import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertItem } from '../src/internal/knowledge/repository.js';
import type { InsertItem } from '../src/internal/knowledge/repository.js';
import { createHarness, TENANTS, type Harness } from '../scenarios/harness.js';

interface Row {
  id: string;
  scope: string;
  tenant_id: string | null;
}

const item = (overrides: Partial<InsertItem>): InsertItem => ({
  scope: 'tenant',
  tenant_id: TENANTS.A.id,
  type: 'account_mapping',
  anchor: 'vendor=rossi',
  subject_key: 'vendor=rossi|account',
  rule: { account: '6820' },
  rule_text: 'x',
  supporting_context: {},
  confidence: 0.5,
  status: 'active',
  ...overrides,
});

describe('row-level security', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.database.withService(async (db) => {
      await insertItem(db, item({}));
      await insertItem(db, item({ tenant_id: TENANTS.B.id, rule: { account: '7000' } }));
      await insertItem(db, item({ scope: 'global', tenant_id: null, type: 'extraction_failure_pattern', anchor: 'doc_pattern=x', subject_key: 'doc_pattern=x|failure', rule: { doc_structure: { layout: 'table' }, error_signature: 'X' } }));
    });
  });
  afterAll(() => h.finish());

  it('tenant A cannot read tenant B rows even with a query that has no WHERE clause', async () => {
    const rows = await h.database.withTenant(TENANTS.A.id, async (db) => (await db.query<Row>('SELECT id, scope, tenant_id FROM knowledge_items')).rows);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.tenant_id === TENANTS.A.id || row.scope === 'global')).toBe(true);
  });

  it('without a tenant context the app role sees global rows only, and no tenant at all', async () => {
    const rows = await h.database.withTenant('', async (db) => (await db.query<Row>('SELECT scope FROM knowledge_items')).rows);
    expect(rows.map((row) => row.scope)).toEqual(['global']);
    const tenants = await h.database.withTenant('', async (db) => (await db.query('SELECT id FROM tenants')).rows);
    expect(tenants).toHaveLength(0);
  });

  it('a tenant sees its own tenant row only', async () => {
    const rows = await h.database.withTenant(TENANTS.A.id, async (db) => (await db.query<{ id: string }>('SELECT id FROM tenants')).rows);
    expect(rows.map((row) => row.id)).toEqual([TENANTS.A.id]);
    const listed = await h.tenant(TENANTS.B.id).get<Array<{ id: string }>>('/tenants');
    expect(listed.data?.map((row) => row.id)).toEqual([TENANTS.B.id]);
  });

  it('the app role cannot insert a global row or a row of another tenant', async () => {
    await expect(h.database.withTenant(TENANTS.A.id, (db) => insertItem(db, item({ scope: 'global', tenant_id: null, status: 'candidate' })))).rejects.toThrow(/row-level security/);
    await expect(h.database.withTenant(TENANTS.A.id, (db) => insertItem(db, item({ tenant_id: TENANTS.B.id, status: 'candidate' })))).rejects.toThrow(/row-level security/);
  });

  it('updates against global or foreign rows affect nothing', async () => {
    const touched = await h.database.withTenant(TENANTS.A.id, async (db) => {
      const global = await db.query("UPDATE knowledge_items SET rule_text = 'hacked' WHERE scope = 'global'");
      const foreign = await db.query("UPDATE knowledge_items SET rule_text = 'hacked' WHERE tenant_id = $1", [TENANTS.B.id]);
      return (global.rowCount ?? 0) + (foreign.rowCount ?? 0);
    });
    expect(touched).toBe(0);
    const hacked = await h.database.withService(async (db) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM knowledge_items WHERE rule_text = 'hacked'")).rows[0]?.n);
    expect(hacked).toBe(0);
  });

  it('nobody can hard-delete knowledge: no role has the DELETE privilege', async () => {
    await expect(h.database.withTenant(TENANTS.A.id, (db) => db.query('DELETE FROM knowledge_items'))).rejects.toThrow(/permission denied/);
    await expect(h.database.withService((db) => db.query('DELETE FROM knowledge_items'))).rejects.toThrow(/permission denied/);
  });

  it('the HTTP layer refuses a request without an actor and a malformed tenant id', async () => {
    const h2 = h.tenant('not-a-uuid');
    expect((await h2.get('/knowledge')).status).toBe(400);
    expect((await h.tenant('').get('/knowledge')).status).toBe(401);
  });
});
