/* global document */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

/**
 * Drives the review dashboard in a real Chrome, end to end: session, review queue, a run and its
 * feedback, idempotent replay, a conflict and its resolution, promotion, isolation and a phone-width
 * sanity check. Needs the API and the dashboard running (`npm run dev`, `npm run web`), Google
 * Chrome installed, and the SERVICE_TOKEN from .env. Screenshots land in web/e2e/screenshots.
 */
process.loadEnvFile('.env');
const API = process.env['E2E_API_URL'] ?? 'http://127.0.0.1:3000/api/v1';
const UI = process.env['E2E_UI_URL'] ?? 'http://localhost:5173/';
const SHOTS = 'web/e2e/screenshots';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const token = process.env['SERVICE_TOKEN'];
if (token === undefined) throw new Error('SERVICE_TOKEN is not set');
mkdirSync(SHOTS, { recursive: true });

async function api(path, body, headers) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = await res.json();
  if (json.error) throw new Error(`seed failed ${path}: ${JSON.stringify(json.error)}`);
  return json.data;
}

/** The state scenario 1 and 2 would leave for tenant A: three corrections and one structural failure, all still candidates. */
async function seed() {
  const h = { 'x-tenant-id': A };
  const r1 = await api('/runs', { invoice: { vendor: 'Rossi S.p.A.', fields: { invoice_number: 'R-1001', total: 1200.5, due_date: '2026-10-01' } }, invoice_ref: 'INV-A-1' }, h);
  await api('/feedback', { run_id: r1.run_id, kind: 'adjusted', reviewer_id: 'anna@alpha', diff: { account: { before: '6000', after: '6820' }, cost_center: { before: null, after: 'CC-7' }, booking_text: { before: null, after: 'Rossi S.p.A. / R-1001' } } }, h);
  const r2 = await api('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-77', line_items: 3 }, doc_structure: { layout: 'table', header: false, columns: 5 } }, invoice_ref: 'INV-A-2' }, h);
  await api('/feedback', { run_id: r2.run_id, kind: 'failed', reviewer_id: 'pipeline', error: { code: 'MISSING_FIELD', missing_field: 'total_amount', doc_type: 'invoice', doc_structure: { layout: 'table', header: false, columns: 5 }, suggested_recovery: 'sum_line_items', message: 'total not found; IBAN IT60X0542811101000000123456' } }, h);
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` -> ${detail}` : ''}`);
}

await seed();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
let n = 0;
const shot = async (name) => {
  n += 1;
  await page.screenshot({ path: `${SHOTS}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: true });
};
const text = async (locator) => ((await locator.textContent()) ?? '').trim();

try {
  await page.goto(UI, { waitUntil: 'networkidle' });
  await shot('start');

  // Session
  await page.getByLabel('Service token').fill(token);
  await page.getByLabel('Reviewer', { exact: true }).fill('anna@alpha');
  const actAs = page.getByRole('combobox', { name: /Act as/ });
  await actAs.waitFor();
  await page.waitForFunction(() => document.querySelector('select')?.options.length > 1);
  await actAs.selectOption({ label: 'Alpha Srl' });
  await page.getByText('Tenant: Alpha Srl').waitFor();
  check('session: token accepted, tenants loaded, acting as Alpha Srl', true);
  await shot('session');

  // Knowledge: four candidates from the seed
  await page.getByRole('button', { name: 'Knowledge' }).click();
  const rows = page.locator('section.panel table tbody tr');
  await rows.first().waitFor();
  const count = await rows.count();
  check('knowledge: 4 candidates listed for Alpha Srl', count === 4, `rows=${count}`);
  const candidateChip = await text(page.locator('.chip', { hasText: 'candidate' }));
  check('knowledge: status chips count 4 candidates', /candidate\s*4/.test(candidateChip), candidateChip);
  await page.locator('.chip', { hasText: 'active' }).first().click();
  await page.getByText('Nothing matches for this actor.').waitFor();
  check('knowledge: clicking the active chip filters to an empty list', true);
  await page.locator('.chip', { hasText: 'all' }).click();
  await rows.first().waitFor();
  await shot('knowledge-candidates');

  for (const type of ['account_mapping', 'booking_rule', 'naming_convention', 'extraction_failure_pattern']) {
    await page.locator('section.panel table tbody tr', { hasText: type }).first().click();
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await page.locator('.success').waitFor();
    const outcome = await text(page.locator('.success'));
    check(`knowledge: accept ${type}`, outcome.startsWith('Accepted and activated'), outcome);
    if (type === 'extraction_failure_pattern') {
      const detail = await text(page.locator('section.panel').nth(1));
      check('knowledge: failure pattern detail carries no IBAN', !/IT60X|IBAN/.test(detail));
      await shot('knowledge-accepted');
    }
  }
  const active = page.locator('section.panel').first().locator('tbody tr .badge-active');
  check('knowledge: all four items now active', (await active.count()) === 4, `active badges=${await active.count()}`);

  // Runs: a new Rossi invoice applies the three rules
  await page.getByRole('button', { name: 'Runs' }).click();
  await page.getByRole('combobox', { name: /Example invoice/ }).selectOption({ label: 'Rossi S.p.A. (plain invoice)' });
  check('runs: the example picker fills the vendor', (await page.getByRole('textbox', { name: 'Vendor' }).inputValue()) === 'Rossi S.p.A.');
  await page.locator('label', { hasText: 'Invoice fields' }).locator('textarea').fill('{"invoice_number":"R-1002","total":980,"due_date":"2026-11-01"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const result = page.locator('section.panel', { hasText: /^Run [0-9a-f]{8}/ }).first();
  await result.waitFor();
  const resultText = await text(result);
  check('run: account 6820 from the accepted mapping', /Account\s*6820/.test(resultText));
  check('run: booking text rendered for R-1002, not copied', resultText.includes('Rossi S.p.A. / R-1002'));
  check('run: cost center CC-7 applied', resultText.includes('CC-7'));
  const applied = result.locator('h3', { hasText: 'Applied knowledge' }).locator('xpath=following-sibling::table[1]//tbody/tr');
  check('run: applied knowledge lists 3 items', (await applied.count()) === 3, `applied=${await applied.count()}`);
  await shot('run-result');

  // Feedback: accepted -> reinforced
  await page.getByLabel('Decision').first().selectOption('accepted');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const outcome = page.locator('section.panel', { hasText: 'Feedback recorded' });
  await outcome.waitFor();
  const reinforced = outcome.locator('dl.kv dd').first().locator('button');
  check('feedback: accepted run reinforces 3 items', (await reinforced.count()) === 3, `reinforced=${await reinforced.count()}`);
  await shot('feedback-accepted');

  // Idempotency from the UI: same key twice -> replayed badge, same run id
  await page.getByRole('button', { name: 'New key' }).click();
  const fresh = page.locator('section.panel', { hasText: /^Run [0-9a-f]{8}/ }).first();
  const panelId = () => text(fresh.locator('h2 .mono').first());
  const previous = await panelId();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction((prev) => document.querySelector('section.panel h2 .mono')?.textContent?.trim() !== prev, previous);
  const firstId = await panelId();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await fresh.locator('.badge-replayed').waitFor();
  const secondId = await panelId();
  check('idempotency: the same key from the UI replays the same run', firstId === secondId, `${firstId} / ${secondId}`);
  await shot('run-replayed');
  await page.locator('label', { hasText: 'Idempotency key' }).locator('input').fill('');

  // Recent runs -> detail with trace
  const recent = page.locator('section.panel', { hasText: 'Recent runs' }).locator('tbody tr');
  check('runs: recent list shows runs', (await recent.count()) >= 3, `runs=${await recent.count()}`);
  await recent.filter({ hasText: /accepted/i }).first().focus();
  await page.keyboard.press('Enter');
  check('runs: a row opens from the keyboard', true);
  const detail = page.locator('section.panel', { hasText: 'Trace (what was retrieved' });
  await detail.waitFor();
  const traceRows = detail.locator('table').last().locator('tbody tr');
  check('run detail: trace has retrieved and applied rows', (await traceRows.count()) >= 3, `trace rows=${await traceRows.count()}`);
  check('run detail: reviewer decision shown', (await text(detail)).includes('Reviewer decision'));
  await shot('run-detail');

  // Conflict: adjust to 6830 on a new run
  await page.getByRole('textbox', { name: 'Vendor' }).fill('Rossi S.p.A.');
  await page.locator('label', { hasText: 'Invoice fields' }).locator('textarea').fill('{"invoice_number":"R-1003","total":50}');
  const beforeConflict = await panelId();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction((prev) => document.querySelector('section.panel h2 .mono')?.textContent?.trim() !== prev, beforeConflict);
  await page.getByLabel('Decision').first().selectOption('adjusted');
  await page.getByRole('row', { name: /^account/ }).locator('input').fill('6830');
  await page.locator('h3', { hasText: 'Diff to send (1 field)' }).waitFor();
  check('feedback: the diff preview shows exactly the changed field', (await text(page.locator('h3', { hasText: 'Diff to send' }).locator('xpath=following-sibling::pre[1]'))).includes('"6830"'));
  await shot('feedback-adjusted-form');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const created = page.locator('section.panel', { hasText: 'Feedback recorded' }).locator('h3', { hasText: 'Knowledge candidates created' }).locator('xpath=following-sibling::table[1]//tbody/tr');
  await created.first().waitFor();
  await shot('feedback-adjusted-outcome');
  const createdCount = await created.count();
  check('feedback: adjustment created a candidate', createdCount === 1, `created rows=${createdCount}; outcome panels=${await page.locator('section.panel', { hasText: 'Feedback recorded' }).count()}`);
  await created.first().locator('button').click();
  const conflict = page.locator('section.panel', { hasText: 'Conflicts with' });
  await conflict.waitFor();
  check('knowledge: candidate shows conflicts_with the active mapping', true);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.locator('.success').waitFor();
  const held = await text(page.locator('.success'));
  check('knowledge: accept parks it as held', held.includes('held'), held);
  await shot('knowledge-conflict-held');
  await page.getByRole('button', { name: /Keep existing/ }).click();
  await page.waitForFunction(() => document.querySelector('.success')?.textContent?.includes('Rejected'));
  check('knowledge: keep existing rejects the newcomer', true);
  check('knowledge: detail badge is rejected', (await page.locator('section.panel h2 .badge-rejected').count()) === 1);
  await shot('knowledge-conflict-resolved');

  // Platform: promotion
  await actAs.selectOption({ label: 'Platform reviewer' });
  await page.locator('.actor', { hasText: 'Platform reviewer' }).waitFor();
  await page.getByRole('button', { name: 'Promotion' }).click();
  await page.getByRole('button', { name: 'Run promotion job' }).click();
  const decisions = page.locator('section.panel table tbody tr');
  await decisions.first().waitFor();
  const decisionText = await text(page.locator('section.panel'));
  check('promotion: report lists decisions', (await decisions.count()) >= 2, `decisions=${await decisions.count()}`);
  check('promotion: pattern skipped below 3 tenants', /skipped/.test(decisionText) && /distinct tenants/.test(decisionText));
  check('promotion: account mapping refused', /refused/.test(decisionText) && /chart of accounts/.test(decisionText));
  await shot('promotion');

  // Isolation: Beta sees nothing
  await actAs.selectOption({ label: 'Beta GmbH' });
  await page.getByText('Tenant: Beta GmbH').waitFor();
  await page.getByRole('button', { name: 'Knowledge' }).click();
  await page.getByText('Nothing matches for this actor.').waitFor();
  check('isolation: Beta GmbH sees no knowledge', true);
  await shot('isolation-beta');

  // Responsive sanity at phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Runs' }).click();
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('responsive: no horizontal page scroll at 390px', !overflow);
  await shot('mobile-runs');
} finally {
  await browser.close();
}

check('console: no browser errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
