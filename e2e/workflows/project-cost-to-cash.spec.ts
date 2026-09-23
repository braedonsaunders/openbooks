import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { authedContext, dismissSetupWizard } from '../auth';
import { withIdempotencyKey } from "./idempotency";

/**
 * Project cost-to-cash end-to-end (construction / AIA progress billing).
 *
 * The flagship path for the product's largest real tenant, previously without
 * any automated coverage: a Schedule-of-Values project takes cost three ways
 * (job-tagged vendor bill, approved labour time that posts to WIP, an
 * equipment project charge) plus an overhead net-zero pair; a first progress
 * application bills with 10% retainage held; the invoice posts; a partial
 * receipt lands; the balance bills; overbilling is refused; retainage
 * releases at the end without re-recognising revenue.
 *
 * No mocked routes, no SQL seeding: prerequisites are created through the
 * product's own HTTP APIs (the same calls its drawers make) and every
 * workflow state is asserted on real rendered pages and the product's own
 * report/document reads. Every amount is asserted exactly — computed in-test
 * with bigint 4dp math mirroring engine/src/money/money.ts.
 *
 * Tenant contract: the suite runs on its own pristine tenant (CI clones one
 * database per suite file). The setup wizard establishes the
 * construction_contractor/US/USD foundation, which seeds the retainage
 * control accounts (1110/2140), the WIP account (1300), and the
 * projects/fieldTickets/equipment/timeTracking features. All money moves in
 * the attempt month (current UTC month + retry index) so month-filtered
 * reports isolate this suite — and each of its attempts — exactly.
 * Pay-application approval requires a second actor (the submitter cannot
 * approve); the browser job seeds approver@openbooks.test, and both log in
 * through the real /api/login.
 *
 * Product truths this suite pins (assert the invariant, not the accident):
 * - documents.total on a progress invoice equals the posted net due
 *   (gross work minus the retainage line). A real defect this year overstated
 *   70 progress-invoice headers by the holdback.
 * - Customer-side retainage held is a BALANCE-SHEET contract asset
 *   (Retainage Receivable), not revenue; releasing it moves DR AR / CR
 *   Retainage Receivable and recognises no revenue. (The liability side of
 *   retainage lives on subcontractor bills as Retainage Payable.)
 * - Overhead never changes company profit: the burden pair nets to zero.
 * - Cumulative billed work can never exceed a schedule line (no double bill).
 */

const RUN = process.env.E2E_RUN ?? '';
const APPROVER_EMAIL = process.env.E2E_APPROVER_EMAIL ?? 'approver@openbooks.test';
const APPROVER_PASSWORD = process.env.E2E_APPROVER_PASSWORD ?? 'approver-test-password-123';
// Local re-runs hit a dirty dev database while CI always runs pristine, so
// the tag salts per process (stable within one file run); retries append
// their index, or the second attempt collides with the first.
const SALT = (RUN || Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'e2e';

/**
 * Per-attempt tag. A Playwright retry re-runs the story against an org the
 * failed attempt already seeded, so every unique-keyed row (project type key,
 * project code, party/item names) carries the retry index or the second
 * attempt collides with the first ("already exists").
 */
function tag(base: string): string {
  const retry = test.info().retry;
  return `${base}${SALT}${retry > 0 ? `R${retry}` : ''}`;
}

/** Minor-unit money (4dp): '12000.00' -> 120000000n (API/ledger precision). */
function toUnits(amount: string): bigint {
  const neg = amount.trim().startsWith('-');
  const digits = amount.trim().replace('-', '');
  const [whole = '0', frac = ''] = digits.split('.');
  const units = BigInt(whole) * 10_000n + BigInt((frac + '0000').slice(0, 4));
  return neg ? -units : units;
}
/** Minor-unit money (2dp cents): '12000.00' -> 1200000n (UI cell precision). */
function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(amount.trim());
  if (!m) throw new Error(`bad money literal ${amount}`);
  const sign = m[1] === '-' ? -1n : 1n;
  return sign * (BigInt(m[2] as string) * 100n + BigInt(m[3] as string));
}
/** Attempt month: current UTC month + retry index. A Playwright retry
 * re-runs the story against an org the failed attempt already seeded, and
 * month-filtered reports cannot tell attempts apart by name — so each
 * attempt owns a different calendar month and every exact report cell stays
 * isolated. The base is the current month (not a fixed date) because the
 * equipment project-charge route posts on the run date with no date
 * override: the attempt-zero month must contain today whenever the suite
 * runs, and each retry owns a later month. */
function attemptMonth(): { ym: string; from: string; to: string; due: string } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + test.info().retry, 1));
  const ym = d.toISOString().slice(0, 7);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const dueYm = next.toISOString().slice(0, 7);
  return { ym, from: `${ym}-01`, to: `${ym}-${pad(last)}`, due: `${dueYm}-15` };
}
function grouped(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** UI money cell in USD: 3600000n cents -> '$36,000.00', negatives parenthesized. */
function fmtUSD(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const text = `$${grouped((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `(${text})` : text;
}
/** Parse a rendered money cell back to cents: '$36,000.00' -> 3600000n. */
function parseUSD(cell: string): bigint {
  const s = cell.trim();
  const neg = s.startsWith('(') && s.endsWith(')');
  const digits = s.replace(/[$,()]/g, '');
  const [whole = '0', frac = '00'] = digits.split('.');
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

type Json = Record<string, unknown>;
interface ApiResult { status: number; body: Json }

/** Real product API call from inside the page (authenticated session). */
async function api(page: Page, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResult> {
  const retryable = method === 'GET';
  return page.evaluate(
    async ({ method, path, data, retryable, extraHeaders }) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < (retryable ? 4 : 1); attempt += 1) {
        try {
          const res = await fetch(path, {
            method,
            headers: { 'Content-Type': 'application/json', ...extraHeaders },
            body: data === undefined ? undefined : JSON.stringify(data),
          });
          const text = await res.text();
          let parsed: unknown = {};
          try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 500) }; }
          return { status: res.status, body: parsed as Json };
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      throw lastError;
    },
    { method, path, data: body, retryable, extraHeaders: withIdempotencyKey(method, headers) },
  );
}
function req(result: ApiResult, url: string): Json {
  expect(result.status, `${url}: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 500)}`).toBeLessThan(300);
  return result.body;
}
async function apiOk(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Json> {
  return req(await api(page, method, path, body, headers), `${method} ${path}`);
}
function str(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !value) throw new Error(`expected ${what} string, got ${JSON.stringify(value)?.slice(0, 80)}`);
  return value;
}
function revOf(payload: Json): string {
  for (const key of ['updated_at', 'updatedAt']) {
    const direct = payload[key];
    if (typeof direct === 'string' && direct.length > 0) return direct;
    for (const nest of ['doc', 'order', 'flow', 'party', 'item', 'asset']) {
      const value = (payload[nest] as Json | undefined)?.[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  throw new Error(`no revision token in ${JSON.stringify(payload).slice(0, 300)}`);
}
function docOf(body: Json): Json {
  return (body.doc ?? body.order ?? body) as Json;
}

/** Open a drawer by URL and wait for it (generous: dev compiles per-route). */
async function openDrawer(page: Page, drawerUrl: string) {
  await page.goto(drawerUrl);
  await dismissSetupWizard(page);
  const drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible({ timeout: 60000 });
  return drawer;
}

/** Read a report table as rows of cell texts. */
async function reportRows(page: Page): Promise<string[][]> {
  return page.evaluate(() => {
    const table = document.querySelectorAll('table')[0];
    if (!table) return [];
    return [...table.querySelectorAll('tr')].map((tr) =>
      [...tr.querySelectorAll('th,td')].map((c) => (c.textContent ?? '').trim().replace(/\s+/g, ' ')));
  });
}
function findRow(rows: string[][], needle: string): string[] {
  const row = rows.find((r) => r.some((c) => c.includes(needle)));
  expect(row, `report row containing ${needle}`).toBeTruthy();
  return row as string[];
}
/** Footer totals row ('Totals'): the 'Total' column header must not match. */
function findTotalsRow(rows: string[][]): string[] {
  return findRow(rows, 'Totals');
}

/** Submit then post a document drawer (two-step lifecycle) through the UI. */
async function uiSubmitAndPost(page: Page, drawerUrl: string): Promise<void> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith('/api/documents/actions') && r.request().method() === 'POST',
  );
  await page.locator('button', { hasText: 'Submit for approval' }).click();
  const resSubmit = await submitted;
  expect(resSubmit.status(), await resSubmit.text()).toBe(200);
  await expect(drawer.getByText('Approved')).toBeVisible({ timeout: 15000 });
  await openDrawer(page, drawerUrl);
  const drawer2 = page.locator('[role="dialog"]').first();
  await drawer2.getByRole('button', { name: 'Actions', exact: true }).click();
  const posted = page.waitForResponse(
    (r) => r.url().endsWith('/api/documents/actions') && r.request().method() === 'POST',
  );
  await page.locator('button', { hasText: /^Post$/ }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(200);
}

/**
 * Allocate a partial amount to an invoice through the receipts drawer UI,
 * save, then post. The allocation itself is an operator decision, so it is
 * clicked, not seeded: the operator enters the amount received, Auto-apply
 * pairs it against the open invoice, Save persists, and Receive & post
 * settles. (Hand-editing the apply amount is intentionally avoided: for
 * same-currency rows the drawer only exposes the target leg, so a hand trim
 * desyncs source from target and the row filters out of the valid set.)
 */
async function uiAllocateAndPostReceipt(page: Page, payId: string, invNumber: string, amount: string): Promise<void> {
  await openDrawer(page, `/receipts?payment=${payId}`);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(drawer.locator('tr', { hasText: invNumber }).first()).toBeVisible();
  const received = drawer.getByPlaceholder('Amount received');
  await received.fill(amount);
  // The pairing call sends whatever committed into this input; assert the
  // commit before clicking or a slow keystroke lands the full open instead.
  await expect(received).toHaveValue(amount, { timeout: 15000 });
  await drawer.getByRole('button', { name: 'Auto-apply' }).click();
  await expect(drawer.getByText(`Total ${fmtUSD(toCents(amount))}`).first()).toBeVisible({ timeout: 30000 });
  // In edit mode Save is the drawer's primary header button (UX-18); the
  // Actions menu is hidden until the drawer returns to view mode.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/payments/${payId}`) && r.request().method() === 'PATCH',
  );
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).status(), 'receipt allocation saved').toBe(200);
  await expect(drawer.getByRole('button', { name: 'Edit', exact: true })).toBeVisible({ timeout: 15000 });
  // The final post goes through the same route with the same body the
  // Receive & post button sends ({documentId, expectedUpdatedAt,
  // allocations}), but issued after re-reading the post-save revision: the
  // drawer's in-hand revision is pre-save until its refresh lands, and racing
  // that refresh 409s. The allocation decision itself stayed in the UI above.
  {
    const fresh = await apiOk(page, 'GET', `/api/payments/${payId}`);
    const posted = await api(page, 'POST', '/api/payments/post-with-applications', {
      documentId: payId,
      expectedUpdatedAt: revOf(fresh),
      allocations: (fresh as Json).allocations,
    });
    expect(posted.status, `post receipt: ${JSON.stringify(posted.body).slice(0, 300)}`).toBe(200);
  }
}

// ---------------------------------------------------------------------------
// Deterministic story data (attempt month, USD, exact decimals throughout).
// ---------------------------------------------------------------------------

/** Story calendar: every date derives from the attempt month (see attemptMonth),
 * so a retried attempt never shares a reporting window with the attempt that
 * seeded before it. Day-of-month anchors: bill 10th, labour week of the 12th,
 * overhead 11th, app1 period 12th, receipt 13th, app2 period 15th, release 16th. */

const M = {
  materials: '12000.00',   // job-tagged vendor bill (5000 Materials)
  wageRate: '45.00',       // labour cost rate ($/hr)
  hours: '40',             // 8h x 5 days
  labour: '1800.00',       // 40 x 45 -> WIP 1300 / clearing 2100
  equipQty: '3',
  equipRate: '800.00',
  equipment: '2400.00',    // project charge (5200 Equipment Rental Cost)
  overhead: '500.00',      // net-zero pair on 5400 Project Overhead
  actualCost: '14900.00',  // 12000 + 2400 + 500 (WIP labour excluded by type policy)
  contract: '100000.00',
  sov1: '60000.00',
  sov2: '40000.00',
  app1L1: '30000.00',
  app1L2: '10000.00',
  app1Gross: '40000.00',
  app1Ret: '4000.00',
  app1Due: '36000.00',
  receipt1: '20000.00',
  bal1: '16000.00',
  app2L1: '30000.00',
  app2L2: '30000.00',
  app2Gross: '60000.00',
  app2Ret: '6000.00',
  app2Due: '54000.00',
  release: '10000.00',
  income: '100000.00',
  recovery: '2400.00',     // equipment cost-recovery income (4300)
  net: '88000.00',         // 100000 + 2400 - 12000 - 2400 - 500 + 500:
                           // the overhead pair nets to zero inside the P&L
  openAR: '80000.00',      // 16000 + 54000 + 10000
} as const;

// Sanity: the story's arithmetic, stated once so a typo reads as a failure.
for (const [a, b, c] of [
  [M.app1L1, M.app1L2, M.app1Gross],
  [M.app2L1, M.app2L2, M.app2Gross],
] as const) {
  if (toUnits(a) + toUnits(b) !== toUnits(c)) throw new Error(`story math broken: ${a}+${b}!=${c}`);
}
if (toUnits(M.app1Gross) - toUnits(M.app1Ret) !== toUnits(M.app1Due)) throw new Error('app1 net broken');
if (toUnits(M.app2Gross) - toUnits(M.app2Ret) !== toUnits(M.app2Due)) throw new Error('app2 net broken');
if (toUnits(M.materials) + toUnits(M.equipment) + toUnits(M.overhead) !== toUnits(M.actualCost)) {
  throw new Error('actual cost broken');
}

test.describe('project cost-to-cash (construction billing, retainage, WIP)', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  let storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
  let approverState: Awaited<ReturnType<BrowserContext['storageState']>>;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error('e2e baseURL is required');
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto('/login');
      await dismissSetupWizard(page);
      // The browser job seeds this user before the specs run; provisioning
      // here is impossible (no product API creates users). Both sessions log
      // in through the real /api/login.
      const origin = new URL(baseURL).origin;
      const apiCtx = await browser.newContext({ baseURL });
      const loginRes = await apiCtx.request.post('/api/login', {
        data: { email: APPROVER_EMAIL, password: APPROVER_PASSWORD },
        headers: { Origin: origin },
      });
      expect(loginRes.ok(), await loginRes.text()).toBe(true);
      approverState = await apiCtx.storageState();
      await apiCtx.close();
      storageState = await context.storageState();
    } finally {
      await context.close();
    }
  });

  async function freshPage(browser: Browser, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      baseURL,
      storageState,
      ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
    });
    const page = await context.newPage();
    await page.goto('/login');
    await dismissSetupWizard(page);
    return { context, page };
  }

  async function approverPage(browser: Browser, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      baseURL,
      storageState: approverState,
      ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
    });
    const page = await context.newPage();
    await page.goto('/login');
    await dismissSetupWizard(page);
    return { context, page };
  }

/** SOV financial policy: the builtin schedule_of_values profile, which the
 * custom type below carries unchanged (the cockpit basis under test). */
function sovFinancialProfile(): Json {
  const line = (measure: string, variant: string) => ({ measure, variant });
  return {
    invoicedToDate: { docKinds: ['customer_invoice'], creditKinds: ['customer_credit'] },
    actualCost: { source: 'account_types', accountTypes: ['expense', 'cogs', 'expense_other', 'expense_deferred'] },
    laborCost: { source: 'in_actual_cost' },
    overhead: { method: 'none' },
    committedCost: { docKinds: ['purchase_order'] },
    billableValue: { includeUnbilledTime: true, includeUnbilledCostLines: true, timeRate: 'bill_rate' },
    costBudget: { source: 'wbs_estimates' },
    totalPrice: { method: 'contract_field' },
    couldBeInvoiced: { formula: 'price_minus_invoiced' },
    totalCost: { components: ['actual_cost', 'committed_cost'] },
    layout: [
      line('invoiced_to_date', 'line'),
      line('could_be_invoiced', 'line'),
      line('total_price', 'subtotal'),
      line('actual_cost', 'line'),
      line('committed_cost', 'line'),
      line('total_cost', 'subtotal'),
      line('cost_budget', 'line'),
      line('remaining_budget', 'line'),
      line('gross_profit', 'total'),
    ],
  };
}

  test('project cost to cash: build cost, bill with retainage, collect, release', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    const approver = await approverPage(browser, baseURL);
    const apage = approver.page;
    try {
      const t = tag('W1');
      let app1AgingTotal = 0n;
      let finalAgingTotal = 0n;
      let chargeDate = '';
      const MO = attemptMonth();
      const PERIOD = `period=custom&from=${MO.from}&to=${MO.to}`;
      const D = (day: string) => `${MO.ym}-${day}`;

      // -- 1. Construction foundation through the setup wizard (real onboarding).
      await apiOk(page, 'PUT', '/api/admin/setup/wizard', {
        name: 'OpenBooks',
        country: 'US',
        baseCurrency: 'USD',
        fiscalYearStartMonth: 1,
        industry: 'construction_contractor',
        features: {},
        workspaceProfile: {
          teamSize: 'small',
          complexity: 'essentials',
          bookStart: 'fresh',
          taxPosition: 'not_registered',
          monthlyActivity: 'light',
          closeCadence: 'monthly',
        },
      });
      await apiOk(page, 'PUT', '/api/admin/setup/features', { features: { wipBilling: true } });

      // Root subsidiary: a fresh journal draft defaults to it (probe deleted).
      const probeDraft = await apiOk(page, 'POST', '/api/journals/draft', {});
      const probeFetched = await apiOk(page, 'GET', `/api/journals/${str(probeDraft.id)}`);
      const rootSub = str((probeFetched.doc as Json).subsidiary_id, 'root subsidiary');
      await apiOk(page, 'DELETE', `/api/journals/${str(probeDraft.id)}`);

      // Resolve the template chart by number (the pickers the UI uses).
      const acct: Record<string, string> = {};
      async function reloadAccounts() {
        const options = await apiOk(page, 'GET', '/api/forms/options?source=gl_accounts');
        for (const opt of (options.options ?? []) as { value: string; label: string }[]) {
          acct[opt.label.split(' ')[0]!] = opt.value;
        }
      }
      await reloadAccounts();
      for (const n of ['1000', '4100', '5300']) {
        expect(acct[n], `account ${n}`).toBeTruthy();
      }
      // Attempt-owned accounts: the trial balance is cumulative as-of, so an
      // exact cell on a shared template account cannot tell this attempt's
      // postings from a previous attempt's (a CI retry re-runs the story on
      // the same tenant). Every account asserted exactly below is created
      // fresh per attempt through the product's accounts route —
      // retry-shifted numbers, tagged names — so each exact cell isolates.
      // Shared controls (AR, retainage receivable, AP) stay shared: they are
      // asserted through attempt-agnostic ties, never exact cells.
      const R = test.info().retry;
      const ano = (base: number) => String(base + R);
      const owned: Record<string, string> = {};
      const ownedName: Record<string, string> = {};
      for (const [key, number, name, type] of [
        ['MAT', 5060, `${t} Materials`, 'cogs'],
        ['EQUIP', 5260, `${t} Equipment Cost`, 'cogs'],
        ['REC', 4360, `${t} Equipment Recovery`, 'income'],
        ['OH', 5460, `${t} Site Overhead`, 'cogs'],
        ['SOVINC', 4060, `${t} Contract Revenue`, 'income'],
        ['WIP', 1360, `${t} Contract WIP`, 'asset_current_other'],
        ['CLR', 2160, `${t} Labor Clearing`, 'liability_current_other'],
      ] as const) {
        const created = await api(page, 'POST', '/api/accounts', { name, number: ano(number), type }, { 'Idempotency-Key': randomUUID() });
        if (created.status === 201 || created.status === 200) {
          owned[key] = str((created.body.account as Json).id, `${name} id`);
        } else {
          await reloadAccounts();
          owned[key] = str(acct[ano(number)], `${name} id`);
        }
        ownedName[key] = name;
      }

      // -- 2. Parties: customer, vendor, and a site employee with an active role.
      async function party(role: string, name: string, extra?: Json) {
        const draft = await apiOk(page, 'POST', '/api/parties/draft', { role });
        const id = str(draft.id, `${role} id`);
        const current = await apiOk(page, 'GET', `/api/parties/${id}`);
        await apiOk(page, 'PATCH', `/api/parties/${id}`, {
          displayName: name,
          ...(role === 'employee' ? { kind: 'person' } : {}),
          isActive: true,
          changeReason: 'project cost-to-cash seed',
          expectedUpdatedAt: revOf(current),
          ...(extra ?? {}),
        });
        return id;
      }
      const customerId = await party('customer', `${t} Civic Authority`);
      const vendorId = await party('vendor', `${t} Readymix Supply`);
      const employeeId = await party('employee', `${t} Site Foreman`, {
        roles: { employee: { enabled: true, jobTitle: 'Foreman', hiredOn: '2026-01-05' } },
      });

      // Labour posts to the ledger on approval: DR Labor WIP / CR clearing.
      await apiOk(page, 'PUT', '/api/admin/setup/labor-costing', {
        settings: { mode: 'post' },
        laborWip: owned.WIP,
        laborClearing: owned.CLR,
      });
      await apiOk(page, 'POST', '/api/admin/setup/labor-costing', {
        action: 'save-rate',
        employeePartyId: employeeId,
        currency: 'USD',
        rate: M.wageRate,
        basis: 'hour',
        effectiveFrom: '2026-01-01',
      });

      // Items: billable field-labour hour and an equipment usage charge.
      async function item(patch: Json) {
        const created = await apiOk(page, 'POST', '/api/items', { isActive: true, ...patch }, {
          'Idempotency-Key': crypto.randomUUID(),
        });
        return str((created.item as Json).id, 'item id');
      }
      const labourItem = await item({
        kind: 'service',
        name: `${t} Field Labour Hour`,
        incomeAccountId: acct['4100'],
        expenseAccountId: acct['5300'],
        defaultRate: '150.00',
        defaultCost: M.wageRate,
      });
      const equipItem = await item({
        kind: 'other_charge',
        name: `${t} Excavator Use`,
        incomeAccountId: acct['4100'],
        expenseAccountId: owned.EQUIP,
        costRecoveryAccountId: owned.REC,
        defaultRate: '950.00',
        defaultCost: M.equipRate,
      });

      // -- 3. Project type (AIA billing procedure) + project with contract value.
      // No product GET lists types, so the suite creates its own through the
      // same setup route the admin UI saves through (retry-aware key).
      const typeRes = await apiOk(page, 'POST', '/api/admin/setup/project-types', {
        key: `sov_e2e_${t}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        name: `${t} Schedule of Values`,
        description: 'E2E construction billing type',
        billingMethod: 'fixed_price',
        sortOrder: 60,
        financialProfile: sovFinancialProfile(),
        invoicingProfile: {
          billingProcedure: 'application_for_payment',
          allowedBases: ['draw_amount'],
          defaultBasis: 'draw_amount',
          lineBuilder: 'draw',
          revenueAccount: 'item_income',
          recognition: 'as_invoiced',
        },
        backupProfile: { required: false, defaultBackupType: 'none', allowedBackupTypes: ['none'] },
      });
      const typeId = str(typeRes.id, 'project type id');
      const projDraft = await apiOk(page, 'POST', '/api/projects/draft', {});
      const projectId = str(projDraft.id, 'project id');
      await apiOk(page, 'PATCH', `/api/projects/${projectId}`, {
        name: `${t} Civic Library Build`,
        code: `${t}-LIB`.toUpperCase().slice(0, 24),
        customerId,
        contractValue: M.contract,
        projectTypeId: typeId,
        subsidiaryId: rootSub,
        status: 'active',
        isActive: true,
        invoicingPreference: { defaultBasis: 'draw_amount' },
      });

      // Schedule of values: two lines summing to the contract.
      async function addSov(description: string, scheduledValue: string) {
        const res = await api(page, 'POST', '/api/construction', {
          action: 'addSov',
          projectId,
          description,
          scheduledValue,
          incomeAccountId: owned.SOVINC,
        });
        expect(res.status, `addSov ${description}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(201);
        return str(res.body.id, 'sov line id');
      }
      const sov1 = await addSov(`${t} Site work and foundations`, M.sov1);
      const sov2 = await addSov(`${t} Structure and envelope`, M.sov2);
      const construction = await apiOk(page, 'GET', `/api/construction?projectId=${projectId}`);
      expect(construction.contractSum, 'contract sum from SOV').toBe('100000.0000');
      expect(construction.retainageConfigured, 'retainage account configured').toBe(true);

      // -- 4a. Cost path one: job-tagged vendor bill (materials).
      const billDraft = await apiOk(page, 'POST', '/api/documents/draft', { kind: 'vendor_bill' });
      const billId = str(billDraft.id, 'bill id');
      const billToken = revOf(await apiOk(page, 'GET', `/api/documents/${billId}`));
      await apiOk(page, 'PATCH', `/api/documents/${billId}`, {
        expectedUpdatedAt: billToken,
        partyId: vendorId,
        subsidiaryId: rootSub,
        documentDate: D('10'),
        dueDate: MO.due,
        lines: [{
          accountId: owned.MAT,
          description: `${t} Ready-mix concrete`,
          quantity: '1',
          unitPrice: M.materials,
          amount: M.materials,
          projectId,
        }],
      });
      const billPosted = await apiOk(page, 'POST', '/api/documents/actions', { action: 'post', documentId: billId });
      expect(billPosted.ok).toBe(true);

      // -- 4b. Cost path two: labour via approved time (posts DR WIP / CR clearing).
      await apiOk(page, 'PUT', '/api/timesheets', {
        employee: employeeId,
        week: D('12'),
        rows: [{
          projectId,
          itemId: labourItem,
          hours: ['', '8', '8', '8', '8', '8', ''],
          isBillable: true,
          memo: `${t} foundation crew`,
        }],
      });
      await apiOk(page, 'POST', '/api/timesheets/submit', { employee: employeeId, week: D('12') });
      await apiOk(page, 'POST', '/api/timesheets/approve', { employee: employeeId, week: D('12') });
      const week = await apiOk(page, 'GET', `/api/timesheets?employee=${employeeId}&week=${D('12')}`);
      {
        const rows = (week.rows ?? []) as { hours: string[]; entryStatuses: string[] }[];
        expect(rows.length, 'one time row').toBe(1);
        let dayUnits = 0n;
        for (const cell of rows[0]!.hours) dayUnits += cell === '' ? 0n : toUnits(cell);
        expect(dayUnits, 'approved 40h on the week').toBe(toUnits(M.hours));
        expect(new Set(rows[0]!.entryStatuses).size, 'single status').toBe(1);
        expect(rows[0]!.entryStatuses[0], 'entries approved').toBe('approved');
      }

      // -- 4c. Cost path three: equipment project charge.
      const charge = await apiOk(page, 'POST', '/api/project-charges', {
        projectId,
        referenceNumber: `${t}-EQ-1`,
        lines: [{ itemId: equipItem, quantity: M.equipQty, costRate: M.equipRate }],
      });
      const chargeId = str((charge.id ?? charge.chargeId ?? charge.documentId) as string, 'charge id');
      expect(charge.approvalPending ?? false, 'charge auto-posted').toBe(false);

      // -- 4d. Overhead burden as a net-zero pair: tagged debit + untagged
      // credit on the same account (standing doctrine: burden must not move
      // company profit, while the job carries its share).
      const ohDraft = await apiOk(page, 'POST', '/api/journals/draft', { subsidiaryId: rootSub });
      const ohId = str(ohDraft.id, 'overhead journal id');
      const ohToken = revOf(await apiOk(page, 'GET', `/api/journals/${ohId}`));
      await apiOk(page, 'PATCH', `/api/journals/${ohId}`, {
        expectedUpdatedAt: ohToken,
        documentDate: D('11'),
        memo: `${t} site overhead allocation`,
        lines: [
          { accountId: owned.OH, description: `${t} burden on job`, amount: M.overhead, projectId },
          { accountId: owned.OH, description: `${t} burden offset`, amount: `-${M.overhead}` },
        ],
      });
      const ohPosted = await apiOk(page, 'POST', '/api/journals/actions', { action: 'post', documentId: ohId });
      expect(ohPosted.ok).toBe(true);

      // Costs on the trial balance: exact cells on this attempt's own
      // accounts, overhead netting to zero.
      await page.goto(`/reports/trial-balance?${PERIOD}`);
      await dismissSetupWizard(page);
      {
        const rows = await reportRows(page);
        const mat = findRow(rows, ownedName.MAT!);
        expect(mat[2]).toBe(fmtUSD(toCents(M.materials)));
        const equip = findRow(rows, ownedName.EQUIP!);
        expect(equip[2]).toBe(fmtUSD(toCents(M.equipment)));
        const oh = findRow(rows, ownedName.OH!);
        expect(oh[2]).toBe(fmtUSD(toCents(M.overhead)));
        expect(oh[3]).toBe(fmtUSD(toCents(M.overhead)));
        expect(oh[oh.length - 1]).toBe(fmtUSD(0n));
        const wip = findRow(rows, ownedName.WIP!);
        expect(wip[2]).toBe(fmtUSD(toCents(M.labour)));
        const clr = findRow(rows, ownedName.CLR!);
        expect(clr[3]).toBe(fmtUSD(toCents(M.labour)));
        // The equipment charge relieves its recovery pool, not the job.
        const rec = findRow(rows, ownedName.REC!);
        expect(rec[3]).toBe(fmtUSD(toCents(M.recovery)));
        const totals = findRow(rows, 'Totals');
        expect(totals[2]).toBe(totals[3]);
      }

      // Project charges list carries the equipment charge with its source.
      const charges = await apiOk(page, 'GET', `/api/project-charges?projectId=${projectId}`);
      {
        const list = (charges.charges ?? []) as Json[];
        expect(list.length, 'one project charge').toBe(1);
        expect(String(list[0]!.documentNumber)).toContain('CHG-');
        expect(Number(list[0]!.lines)).toBe(1);
        // The charge route posts on the run date (no date override), so its
        // document date decides which attempt's P&L window carries its legs.
        chargeDate = String(list[0]!.documentDate).slice(0, 10);
      }

      /** documents.total must equal the posted line sum (the holdback defect). */
      async function expectInvoiceInvariant(invoiceId: string, expectedTotal: string, label: string) {
        const got = await apiOk(page, 'GET', `/api/documents/${invoiceId}`);
        const doc = docOf(got);
        const lines = (got.lines ?? []) as { amount: string }[];
        expect(lines.length > 0, `${label} has lines`).toBe(true);
        let sum = 0n;
        for (const l of lines) sum += toUnits(String(l.amount));
        expect(sum, `${label} lines sum`).toBe(toUnits(expectedTotal));
        expect(toUnits(str(doc.total, `${label} total`)), `${label} header total`).toBe(toUnits(expectedTotal));
      }

      // -- 5. Progress application 1: 40% of the work, 10% retainage held.
      const app1 = await apiOk(page, 'POST', '/api/construction', {
        action: 'createPayApp', projectId, periodEnd: D('12'), retainagePercent: '10',
      });
      const app1Id = str(app1.id, 'app1 id');
      // A second application cannot start while one is open.
      {
        const blocked = await api(page, 'POST', '/api/construction', {
          action: 'createPayApp', projectId, periodEnd: D('13'), retainagePercent: '10',
        });
        expect(blocked.status, 'parallel application refused').toBe(422);
      }
      await apiOk(page, 'POST', '/api/construction', {
        action: 'submitPayApp',
        payApplicationId: app1Id,
        lines: [
          { sovLineId: sov1, thisPeriodCompleted: M.app1L1, materialsStored: '0' },
          { sovLineId: sov2, thisPeriodCompleted: M.app1L2, materialsStored: '0' },
        ],
      });
      // Segregation of duties: the submitter cannot approve their own draw.
      {
        const selfApprove = await api(page, 'POST', '/api/construction', {
          action: 'approvePayApp', payApplicationId: app1Id,
        });
        expect(selfApprove.status, 'self-approval refused').toBe(422);
        expect(JSON.stringify(selfApprove.body)).toContain('submitter cannot approve');
      }
      await apiOk(apage, 'POST', '/api/construction', { action: 'approvePayApp', payApplicationId: app1Id });
      const billed1 = await apiOk(page, 'POST', '/api/construction', { action: 'billPayApp', payApplicationId: app1Id });
      const inv1Id = str(billed1.invoiceId, 'invoice 1 id');
      expect(toUnits(str(billed1.currentDue, 'app1 due')), 'app1 current due').toBe(toUnits(M.app1Due));
      expect(toUnits(str(billed1.retainage, 'app1 retainage')), 'app1 retainage').toBe(toUnits(M.app1Ret));
      await expectInvoiceInvariant(inv1Id, M.app1Due, 'progress invoice 1');
      const inv1Number = str(billed1.documentNumber, 'invoice 1 number');

      // Post the invoice through the real drawer lifecycle.
      await uiSubmitAndPost(page, `/ar/invoices?doc=${inv1Id}`);
      await openDrawer(page, `/ar/invoices?doc=${inv1Id}`);
      {
        const drawer = page.locator('[role="dialog"]').first();
        await expect(drawer.getByText(fmtUSD(toCents(M.app1Due))).first()).toBeVisible();
        await expect(drawer.getByText('Open').first()).toBeVisible();
        await expect(drawer.getByText('Less retainage held').first()).toBeVisible();
      }
      await page.goto('/ar/invoices');
      await dismissSetupWizard(page);
      {
        const row = page.locator('tr', { hasText: inv1Number }).first();
        await expect(row.getByText(fmtUSD(toCents(M.app1Due))).first()).toBeVisible();
      }
      // AR aging carries the FULL customer position: the net collectible
      // plus the held retainage. The report folds every asset_receivable
      // control (1100 AR and 1110 Retainage Receivable) into the party total,
      // so it reads 40,000 while the invoice balance reads 36,000 due now.
      // The party row is attempt-scoped (tagged customer); the Total row is
      // kept for the cross-report tie below (it holds across attempts).
      await page.goto(`/reports/aging?${PERIOD}&side=ar`);
      {
        const rows = await reportRows(page);
        const ar = findRow(rows, `${t} Civic Authority`);
        expect(ar[ar.length - 1]).toBe(fmtUSD(toCents(M.app1Gross)));
        const totalRow = findTotalsRow(rows);
        app1AgingTotal = parseUSD(totalRow[totalRow.length - 1]!);
      }
      // Retainage held is a balance-sheet contract asset, not revenue: the
      // construction read reports it, and the P&L recognises the gross work.
      {
        const state = await apiOk(page, 'GET', `/api/construction?projectId=${projectId}`);
        expect(toUnits(str(state.retainageHeld, 'retainage held')), 'retainage held 4,000').toBe(toUnits(M.app1Ret));
      }
      // The same held figure on the rendered Billing tab (per-project, so it
      // isolates across attempts): a balance-sheet contract asset, not revenue.
      await openDrawer(page, `/projects?project=${projectId}`);
      {
        const drawer = page.locator('[role="dialog"]').first();
        await drawer.getByRole('tab', { name: 'Billing' }).click();
        const row = drawer.locator('div').filter({ hasText: 'Retainage held' }).filter({ hasText: fmtUSD(toCents(M.app1Ret)) }).last();
        await expect(row, 'billing tab shows 4,000 held').toBeVisible();
      }
      await page.goto(`/reports/trial-balance?${PERIOD}`);
      {
        const rows = await reportRows(page);
        const rev = findRow(rows, ownedName.SOVINC!);
        expect(rev[3]).toBe(fmtUSD(toCents(M.app1Gross)));
        expect(rev[rev.length - 1]).toBe(fmtUSD(-toCents(M.app1Gross)));
        // Shared controls tie attempt-agnostically: every receivable leg
        // ever posted (this attempt's and any earlier attempt's) sits in AR
        // plus retainage receivable, and the aging total folds exactly that
        // set — so the sums agree at every stop however many attempts ran.
        const ar = findRow(rows, 'Accounts Receivable');
        const ret = findRow(rows, 'Retainage Receivable');
        expect(parseUSD(ar[ar.length - 1]!) + parseUSD(ret[ret.length - 1]!)).toBe(app1AgingTotal);
      }

      // -- 6. Partial payment of 20,000: the receipt shell is seeded, then
      // the operator allocates, saves, and posts in the receipts drawer.
      const payDraft = await apiOk(page, 'POST', '/api/payments/draft', { kind: 'customer_payment' });
      const payId = str(payDraft.id, 'receipt id');
      const payToken = revOf(await apiOk(page, 'GET', `/api/payments/${payId}`));
      await apiOk(page, 'PATCH', `/api/payments/${payId}`, {
        partyId: customerId,
        bankAccountId: acct['1000'],
        documentDate: D('13'),
        expectedUpdatedAt: payToken,
      });
      await uiAllocateAndPostReceipt(page, payId, inv1Number, M.receipt1);
      await page.goto('/ar/invoices');
      {
        const row = page.locator('tr', { hasText: inv1Number }).first();
        await expect(row.getByText(fmtUSD(toCents(M.bal1))).first()).toBeVisible();
      }
      await openDrawer(page, `/ar/invoices?doc=${inv1Id}`);
      await expect(page.locator('[role="dialog"]').first().getByText(fmtUSD(toCents(M.bal1))).first()).toBeVisible();
      await page.goto(`/reports/aging?${PERIOD}&side=ar`);
      {
        const rows = await reportRows(page);
        const ar = findRow(rows, `${t} Civic Authority`);
        // 16,000 still due on the invoice + 4,000 held = 20,000 position.
        expect(ar[ar.length - 1]).toBe(fmtUSD(toCents(M.bal1) + toCents(M.app1Ret)));
      }

      // -- 7. Application 2 bills the balance; billed work cannot bill twice.
      const app2 = await apiOk(page, 'POST', '/api/construction', {
        action: 'createPayApp', projectId, periodEnd: D('15'), retainagePercent: '10',
      });
      const app2Id = str(app2.id, 'app2 id');
      // Billing one dollar past the scheduled value is refused (cumulative cap).
      {
        const over = await api(page, 'POST', '/api/construction', {
          action: 'submitPayApp',
          payApplicationId: app2Id,
          lines: [
            { sovLineId: sov1, thisPeriodCompleted: '30001.00', materialsStored: '0' },
            { sovLineId: sov2, thisPeriodCompleted: M.app2L2, materialsStored: '0' },
          ],
        });
        expect(over.status, 'overbilling refused').toBe(422);
        expect(JSON.stringify(over.body)).toContain('exceeds the scheduled value');
      }
      await apiOk(page, 'POST', '/api/construction', {
        action: 'submitPayApp',
        payApplicationId: app2Id,
        lines: [
          { sovLineId: sov1, thisPeriodCompleted: M.app2L1, materialsStored: '0' },
          { sovLineId: sov2, thisPeriodCompleted: M.app2L2, materialsStored: '0' },
        ],
      });
      await apiOk(apage, 'POST', '/api/construction', { action: 'approvePayApp', payApplicationId: app2Id });
      const billed2 = await apiOk(page, 'POST', '/api/construction', { action: 'billPayApp', payApplicationId: app2Id });
      const inv2Id = str(billed2.invoiceId, 'invoice 2 id');
      const inv2Number = str(billed2.documentNumber, 'invoice 2 number');
      await expectInvoiceInvariant(inv2Id, M.app2Due, 'progress invoice 2');
      await uiSubmitAndPost(page, `/ar/invoices?doc=${inv2Id}`);
      // With the schedule fully billed, any further draw is refused, then voided.
      {
        const app3 = await apiOk(page, 'POST', '/api/construction', {
          action: 'createPayApp', projectId, periodEnd: D('16'), retainagePercent: '10',
        });
        const app3Id = str(app3.id, 'app3 id');
        const again = await api(page, 'POST', '/api/construction', {
          action: 'submitPayApp',
          payApplicationId: app3Id,
          lines: [{ sovLineId: sov1, thisPeriodCompleted: '1.00', materialsStored: '0' }],
        });
        expect(again.status, 're-billing refused').toBe(422);
        expect(JSON.stringify(again.body)).toContain('exceeds the scheduled value');
        await apiOk(page, 'POST', '/api/construction', { action: 'voidPayApp', payApplicationId: app3Id });
      }

      // -- 8. Release the 10,000 holdback: a balance-sheet move, not revenue.
      {
        const over = await api(page, 'POST', '/api/construction', {
          action: 'releaseRetainage', projectId, periodEnd: D('16'), amount: '10001.00',
        });
        expect(over.status, 'over-release refused').toBe(422);
        expect(JSON.stringify(over.body)).toContain('exceeds available retained funds');
      }
      const released = await apiOk(page, 'POST', '/api/construction', {
        action: 'releaseRetainage', projectId, periodEnd: D('16'), amount: M.release,
      });
      const relId = str(released.invoiceId, 'release invoice id');
      const relNumber = str(released.documentNumber, 'release invoice number');
      await expectInvoiceInvariant(relId, M.release, 'retainage release invoice');
      {
        const rel = await apiOk(page, 'POST', '/api/documents/actions', { action: 'submit', documentId: relId });
        expect(rel.ok).toBe(true);
        const posted = await apiOk(page, 'POST', '/api/documents/actions', { action: 'post', documentId: relId });
        expect(posted.ok).toBe(true);
      }
      // Retainage held returns to zero; the P&L recognises nothing new.
      {
        const state = await apiOk(page, 'GET', `/api/construction?projectId=${projectId}`);
        expect(toUnits(str(state.retainageHeld, 'retainage held')), 'retainage fully released').toBe(0n);
      }
      // Aging first: the tie below needs its total, and the party row is
      // attempt-scoped while the Total row accumulates every attempt.
      await page.goto(`/reports/aging?${PERIOD}&side=ar`);
      {
        const rows = await reportRows(page);
        const ar = findRow(rows, `${t} Civic Authority`);
        expect(ar[ar.length - 1]).toBe(fmtUSD(toCents(M.openAR)));
        const totalRow = findTotalsRow(rows);
        finalAgingTotal = parseUSD(totalRow[totalRow.length - 1]!);
      }
      await page.goto(`/reports/trial-balance?${PERIOD}`);
      {
        const rows = await reportRows(page);
        const rev = findRow(rows, ownedName.SOVINC!);
        expect(rev[3], 'revenue is the contract, not contract-plus-release').toBe(fmtUSD(toCents(M.income)));
        // The holdback nets through the shared retainage control at release;
        // the tie below (not an exact cell) proves where every dollar sits.
        const ar = findRow(rows, 'Accounts Receivable');
        const ret = findRow(rows, 'Retainage Receivable');
        expect(parseUSD(ar[ar.length - 1]!) + parseUSD(ret[ret.length - 1]!)).toBe(finalAgingTotal);
        const totals = findRow(rows, 'Totals');
        expect(totals[2]).toBe(totals[3]);
        expect(totals[totals.length - 1]).toBe(fmtUSD(0n));
      }
      // The P&L is movement over the window, so this attempt's month
      // isolates it: every row below is this attempt's own account. The
      // equipment charge is the exception: its route posts on the run date
      // with no date override, so on a retry its legs sit in the previous
      // attempt's month. The trial balance above (as-of) still carries both
      // legs; this window only does when the charge's own document date
      // falls inside it. Net income is unaffected either way — the charge
      // nets to zero (2,400 recovery less 2,400 cost).
      await page.goto(`/reports/pnl?${PERIOD}`);
      {
        const rows = await reportRows(page);
        expect(findRow(rows, ownedName.SOVINC!)).toContain(fmtUSD(toCents(M.income)));
        expect(findRow(rows, ownedName.MAT!)).toContain(fmtUSD(toCents(M.materials)));
        const chargeInWindow = chargeDate >= MO.from && chargeDate <= MO.to;
        // A fresh run always posts the charge inside its own month: if that
        // ever stops holding, fail loudly here rather than silently skip.
        if (test.info().retry === 0) {
          expect(chargeInWindow, `charge posts in-window (charge ${chargeDate}, window ${MO.from}..${MO.to})`).toBe(true);
        }
        if (chargeInWindow) {
          expect(findRow(rows, ownedName.REC!)).toContain(fmtUSD(toCents(M.recovery)));
          expect(findRow(rows, ownedName.EQUIP!)).toContain(fmtUSD(toCents(M.equipment)));
        }
        // Overhead nets to zero, so it never touches net income.
        expect(findRow(rows, 'Net income')).toContain(fmtUSD(toCents(M.net)));
      }
      await page.goto(`/reports/balance-sheet?${PERIOD}`);
      {
        const rows = await reportRows(page);
        const assets = findRow(rows, 'Total Assets');
        const liabEq = findRow(rows, 'Total Liabilities and Equity');
        expect(assets[assets.length - 1]).toBe(liabEq[liabEq.length - 1]);
        expect(findRow(rows, ownedName.WIP!)).toContain(fmtUSD(toCents(M.labour)));
      }

      // -- 9. The cockpit ties to the ledger on the type's declared basis:
      // contract price from the contract field, cost from posted GL.
      await openDrawer(page, `/projects?project=${projectId}`);
      {
        const drawer = page.locator('[role="dialog"]').first();
        await expect(drawer.getByText(`${t} Civic Library Build`).first()).toBeVisible();
        await drawer.getByRole('tab', { name: 'Financials' }).click();
        // Label-scoped: each measure's value must sit in its own labeled row,
        // not merely somewhere in the drawer (contract and invoiced are both
        // 100,000.00 here, so bare text matching would prove nothing).
        for (const [label, amount] of [
          ['Total job price', M.contract],
          ['Invoiced to date', M.income],
          ['Actual cost', M.actualCost],
        ] as const) {
          const row = drawer.locator('div').filter({ hasText: label }).filter({ hasText: fmtUSD(toCents(amount)) }).last();
          await expect(row, `${label} shows ${amount}`).toBeVisible();
        }
      }
      await openDrawer(page, `/projects?project=${projectId}`);
      {
        const drawer = page.locator('[role="dialog"]').first();
        await drawer.getByRole('tab', { name: 'Billing' }).click();
        await expect(drawer.getByText(inv2Number).first()).toBeVisible();
        const row = drawer.locator('div').filter({ hasText: 'Retainage held' }).filter({ hasText: fmtUSD(0n) }).last();
        await expect(row, 'billing tab shows nothing held after release').toBeVisible();
      }
      await openDrawer(page, `/projects?project=${projectId}`);
      {
        const drawer = page.locator('[role="dialog"]').first();
        await drawer.getByRole('tab', { name: 'Transactions' }).click();
        // Every source document tagged to the job, with its own number:
        // the vendor bill, the equipment charge, the overhead journal, and
        // all three customer invoices. (Approved labour posts as a
        // document-less GL entry, so it surfaces on Hours & Time, below.)
        const text = await drawer.innerText();
        for (const needle of ['BILL-', 'CHG-', 'JE-', inv1Number, inv2Number, relNumber]) {
          expect(text, `transactions show ${needle}`).toContain(needle);
        }
      }
      await openDrawer(page, `/projects?project=${projectId}`);
      {
        const drawer = page.locator('[role="dialog"]').first();
        await drawer.getByRole('tab', { name: 'Hours & Time' }).click();
        for (const [label, amount] of [
          ['Total hours', '40'],
          ['Labor cost', fmtUSD(toCents(M.labour))],
        ] as const) {
          const row = drawer.locator('div').filter({ hasText: label }).filter({ hasText: amount }).last();
          await expect(row, `${label} shows ${amount}`).toBeVisible();
        }
      }

      // -- 10. Source-line WIP prebilling refuses the AIA procedure (guard proof).
      {
        const prebill = await api(page, 'POST', '/api/wip-billing', { projectId, periodEnd: MO.to });
        expect(prebill.status, 'AIA prebilling refused').toBe(422);
        expect(JSON.stringify(prebill.body)).toContain('applications for payment instead of source-line prebilling');
      }
      void chargeId;
    } finally {
      await apage.close();
      await approver.context.close();
      await context.close();
    }
  });
});
