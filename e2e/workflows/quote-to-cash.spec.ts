import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { authedContext, dismissSetupWizard } from '../auth';

/**
 * Quote-to-cash end-to-end workflows through the real UI and real APIs.
 *
 * No mocked routes, no SQL seeding: prerequisites are created through the
 * product's own HTTP APIs (the same calls its drawers make) and every
 * lifecycle transition is clicked in the UI with a wait on the backing
 * request. Every amount is asserted exactly — computed in-test with bigint
 * minor-unit math — against the rendered lists, drawers, reports, and audit
 * trail.
 *
 * Determinism: fixed 2026 document dates on every write, fixed per-scenario
 * tags and account numbers (E2E_RUN suffix only for local re-runs against a
 * dirty dev database; CI always runs a pristine org), one scenario per
 * calendar month so period-filtered reports isolate each scenario, and custom
 * report periods throughout. The suite completes first-run org setup through
 * the product's setup-wizard API (industry template: chart of accounts,
 * control accounts, features) exactly as a new tenant would.
 *
 * Core flow per scenario: customer → item with tax → quote → issue (UI) →
 * convert to sales order (UI) → fulfil → convert to invoice (UI) → post
 * (UI) → receipts with applications (UI post) → bank statement match and
 * reconciliation (UI) → verify invoice balance 0, AR aging, P&L/BS/TB cells
 * against the posted journal, and audit entries for each step.
 *
 * Report semantics: P&L is period movement (per-scenario months isolate
 * it); trial balance and balance sheet are cumulative as-of, so scenarios 2
 * and 3 assert cumulative tie-outs across the serial scenarios.
 */

const RUN = process.env.E2E_RUN ?? '';

function tag(base: string): string {
  return `${base}${RUN}`;
}

/** Two digits distinguishing local re-runs; always 00 in CI (pristine org). */
function runCode(): string {
  const m = /(\d+)\s*$/.exec(RUN);
  return m ? String(Number(m[1]) % 100).padStart(2, '0') : '00';
}

/** Minor-unit money: '420.00' -> 42000n. */
function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (!m) throw new Error(`bad money literal ${amount}`);
  const sign = m[1] === '-' ? -1n : 1n;
  return sign * (BigInt(m[2] as string) * 100n + BigInt(m[3] as string));
}

function grouped(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** UI money cell in CAD: 42000n -> 'CA$420.00', -100n -> '(CA$1.00)'. */
function fmtCAD(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const text = `CA$${grouped((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `(${text})` : text;
}

/** UI money cell in USD: 100000n -> '$1,000.00' (plain $ prefix). */
function fmtUSD(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const text = `$${grouped((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `(${text})` : text;
}

type Json = Record<string, unknown>;

interface ApiResult {
  status: number;
  body: Json;
}

/** Real product API call from inside the page (authenticated session). */
async function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResult> {
  const result = await page.evaluate(
    async ({ method: m, path: p, data, extra }: { method: string; path: string; data: unknown; extra: Record<string, string> }) => {
      const res = await fetch(p, {
        method: m,
        headers: { 'Content-Type': 'application/json', ...extra },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    },
    { method, path, data: body, extra: headers ?? {} },
  );
  return result as ApiResult;
}

async function apiOk(page: Page, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Json> {
  const res = await api(page, method, path, body, headers);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body).slice(0, 400)}`).toBeLessThan(300);
  return res.body;
}

function str(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !value) throw new Error(`expected ${what} string, got ${JSON.stringify(value)?.slice(0, 80)}`);
  return value;
}

function docOf(body: Json): Json {
  return body.doc as Json;
}

/** First-run org setup through the product's setup-wizard API. */
async function setupOrg(page: Page): Promise<void> {
  const res = await api(page, 'PUT', '/api/admin/setup/wizard', {
    name: 'Q2C E2E Co',
    country: 'CA',
    baseCurrency: 'CAD',
    fiscalYearStartMonth: 1,
    reportingFramework: 'ifrs',
    industry: 'general_business',
    features: { multiCurrency: true },
    workspaceProfile: {
      teamSize: 'small',
      complexity: 'essentials',
      bookStart: 'fresh',
      taxPosition: 'registered',
      monthlyActivity: 'light',
      closeCadence: 'monthly',
    },
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}

interface ScenarioSeed {
  taxCodeId: string;
  incomeId: string;
  bankId: string;
  partyId: string;
  itemId: string;
}

async function seedScenario(
  page: Page,
  t: string,
  opts: { incomeNumber: string; bankNumber: string; withTax: boolean },
): Promise<ScenarioSeed> {
  let taxCodeId = '';
  if (opts.withTax) {
    const tc = await api(page, 'POST', '/api/admin/setup/tax-codes', {
      code: `${t}-GST5`, name: `${t} GST 5%`, country: 'CA', appliesTo: 'sales', calculationType: 'standard', isActive: true,
    });
    expect(tc.status, JSON.stringify(tc.body).slice(0, 200)).toBe(200);
    taxCodeId = str(tc.body.id, 'taxCodeId');
    const tr = await api(page, 'POST', '/api/admin/setup/tax-rates', { taxCodeId, ratePercent: '5', effectiveFrom: '2026-01-01' });
    expect(tr.status, JSON.stringify(tr.body).slice(0, 200)).toBe(200);
  }
  const inc = await api(page, 'POST', '/api/accounts',
    { name: `${t} Service Revenue`, type: 'income', number: opts.incomeNumber },
    { 'Idempotency-Key': crypto.randomUUID() });
  expect(inc.status, JSON.stringify(inc.body).slice(0, 200)).toBe(201);
  const incomeId = str((inc.body.account as Json).id, 'incomeId');
  const bank = await api(page, 'POST', '/api/accounts',
    { name: `${t} Operating`, type: 'asset_bank', number: opts.bankNumber, reconcilable: true, currencyRestriction: 'CAD' },
    { 'Idempotency-Key': crypto.randomUUID() });
  expect(bank.status, JSON.stringify(bank.body).slice(0, 200)).toBe(201);
  const bankId = str((bank.body.account as Json).id, 'bankId');
  const pd = await api(page, 'POST', '/api/parties/draft', { role: 'customer' });
  expect(pd.status).toBe(200);
  const partyId = str(pd.body.id);
  const pg = await api(page, 'GET', `/api/parties/${partyId}`);
  expect(pg.status).toBe(200);
  const pa = await api(page, 'PATCH', `/api/parties/${partyId}`, {
    displayName: `${t} Customer`, isActive: true, changeReason: 'e2e customer activation',
    expectedUpdatedAt: str((pg.body.party as Json).updated_at, 'party revision'),
  });
  expect(pa.status, JSON.stringify(pa.body).slice(0, 200)).toBe(200);
  const idr = await api(page, 'POST', '/api/items/draft', {});
  expect(idr.status).toBe(200);
  const itemId = str(idr.body.id);
  const ip = await api(page, 'PATCH', `/api/items/${itemId}`, {
    name: `${t} Consulting Hour`, kind: 'service', defaultRate: '200.00',
    incomeAccountId: incomeId, ...(opts.withTax ? { taxCodeId } : {}), isActive: true,
  });
  expect(ip.status, JSON.stringify(ip.body).slice(0, 200)).toBe(200);
  return { taxCodeId, incomeId, bankId, partyId, itemId };
}

interface QuoteSeed {
  quoteId: string;
  subtotal: string;
  taxTotal: string;
  total: string;
}

async function seedQuote(
  page: Page,
  seed: ScenarioSeed,
  opts: { documentDate: string; dueDate: string; quantity: string; unitPrice: string },
): Promise<QuoteSeed> {
  const qd = await api(page, 'POST', '/api/estimates/draft', {});
  expect(qd.status).toBe(200);
  const quoteId = str(qd.body.id);
  const qg = await api(page, 'GET', `/api/estimates/${quoteId}`);
  expect(qg.status).toBe(200);
  const qp = await api(page, 'PATCH', `/api/estimates/${quoteId}`, {
    partyId: seed.partyId, documentDate: opts.documentDate, dueDate: opts.dueDate,
    lines: [{
      itemId: seed.itemId, accountId: seed.incomeId,
      quantity: opts.quantity, unitPrice: opts.unitPrice,
      ...(seed.taxCodeId ? { taxCodeId: seed.taxCodeId } : {}),
    }],
    expectedUpdatedAt: str(docOf(qg.body).updated_at, 'quote revision'),
  });
  expect(qp.status, JSON.stringify(qp.body).slice(0, 300)).toBe(200);
  const doc = docOf(qp.body);
  return {
    quoteId,
    subtotal: str(doc.subtotal, 'subtotal'),
    taxTotal: str(doc.tax_total, 'taxTotal'),
    total: str(doc.total, 'total'),
  };
}

/** Open an order drawer fresh (settled state) for UI interaction. */
async function openDrawer(page: Page, drawerUrl: string): Promise<Locator> {
  await page.goto(drawerUrl);
  await dismissSetupWizard(page);
  const drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Click Actions → button in an order drawer and wait for the PATCH behind it. */
async function uiOrderAction(page: Page, apiBase: string, id: string, button: string): Promise<Json> {
  const drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
  const waited = page.waitForResponse(
    (r) => r.url().endsWith(`${apiBase}/${id}`) && r.request().method() === 'PATCH',
  );
  const actionButton = page.locator('button', { hasText: button });
  await expect(actionButton).toBeEnabled({ timeout: 20000 });
  await actionButton.click();
  const res = await waited;
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Json;
}

/** Convert the open order through the Actions menu; returns the created doc. */
async function uiConvert(page: Page, drawerUrl: string, apiBase: string, id: string, button: string, targetKind: string): Promise<{ id: string; documentNumber: string }> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
  const waited = page.waitForResponse(
    (r) => r.url().endsWith(`${apiBase}/${id}/convert`) && r.request().method() === 'POST',
  );
  const convertButton = page.locator('button', { hasText: button });
  await expect(convertButton).toBeEnabled({ timeout: 20000 });
  await convertButton.click();
  const res = await waited;
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { id: string; documentNumber: string; kind: string };
  expect(body.kind).toBe(targetKind);
  return { id: str(body.id, 'converted id'), documentNumber: str(body.documentNumber, 'converted number') };
}

/** Submit then post a document drawer (two-step approval lifecycle). */
async function uiSubmitAndPost(page: Page, drawerUrl: string, expectedBadge: 'Open' | 'Posted'): Promise<void> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  // The Actions menu renders in a portal outside the drawer, and list rows
  // behind it carry icon-only buttons with the same accessible names: match
  // the menu item by its visible text.
  await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith('/api/documents/actions') && r.request().method() === 'POST',
  );
  await page.locator('button', { hasText: 'Submit for approval' }).click();
  const resSubmit = await submitted;
  expect(resSubmit.status(), await resSubmit.text()).toBe(200);
  await expect(drawer.getByText('Approved')).toBeVisible({ timeout: 15000 });
  // Fresh drawer state: the post-submit refresh leaves the Actions menu
  // in a perpetually-unstable overlay; re-navigation settles it.
  await openDrawer(page, drawerUrl);
  const drawer2 = page.locator('[role="dialog"]').first();
  await drawer2.getByRole('button', { name: 'Actions', exact: true }).click();
  const posted = page.waitForResponse(
    (r) => r.url().endsWith('/api/documents/actions') && r.request().method() === 'POST',
  );
  await page.locator('button', { hasText: /^Post$/ }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(200);
  // A posted invoice carrying a balance resolves to the open status;
  // balance-less docs (credit memos) show the posted status.
  await expect(drawer2.getByText(expectedBadge)).toBeVisible({ timeout: 15000 });
}

/** Seed a receipt draft with header + suggested applications; returns id + number. */
async function seedReceipt(page: Page, seed: ScenarioSeed, amount: string, documentDate: string): Promise<{ payId: string; number: string }> {
  const sug = await apiOk(page, 'POST', '/api/payments/suggest', {
    partyId: seed.partyId, amount, side: 'ar', currency: 'CAD',
  });
  const allocations = sug.allocations as Json[];
  expect(allocations.length > 0, `suggest must allocate ${amount}`).toBe(true);
  const pd = await apiOk(page, 'POST', '/api/payments/draft', { kind: 'customer_payment' });
  const payId = str(pd.id, 'payment id');
  const pg = await apiOk(page, 'GET', `/api/payments/${payId}`);
  const pp = await api(page, 'PATCH', `/api/payments/${payId}`, {
    partyId: seed.partyId, bankAccountId: seed.bankId, documentDate,
    expectedUpdatedAt: str(docOf(pg).updated_at, 'payment revision'),
    allocations,
  });
  expect(pp.status, JSON.stringify(pp.body).slice(0, 300)).toBe(200);
  return { payId, number: str(docOf(pp.body).document_number, 'receipt number') };
}

/** Post a seeded receipt through the receipt drawer UI. */
async function uiPostReceipt(page: Page, payId: string): Promise<void> {
  await openDrawer(page, `/receipts?payment=${payId}`);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
  const posted = page.waitForResponse(
    (r) => r.url().endsWith('/api/payments/post-with-applications') && r.request().method() === 'POST',
  );
  const postButton = page.locator('button', { hasText: 'Receive & post' });
  await expect(postButton).toBeEnabled({ timeout: 20000 });
  await postButton.click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(200);
}

/** Open a drawer, switch to its Audit Trail tab, and return the action list. */
async function auditActions(page: Page, drawerUrl: string): Promise<string> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole('tab', { name: 'Audit Trail', exact: true }).click();
  await expect(drawer.getByText(/events/)).toBeVisible({ timeout: 15000 });
  return drawer.innerText();
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

test.describe('quote-to-cash workflows', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  let storageState: Awaited<ReturnType<BrowserContext['storageState']>>;

  test.beforeAll(async ({ browser, baseURL }: { browser: Browser; baseURL: string | undefined }) => {
    if (!baseURL) throw new Error('e2e baseURL is required');
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto('/login');
      await dismissSetupWizard(page);
      await setupOrg(page);
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

  test('core flow: quote to cash with partial then full receipt', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const t = tag('Q2CA');
      const rc = runCode();
      const seed = await seedScenario(page, t, { incomeNumber: `4491${rc}`, bankNumber: `1491${rc}`, withTax: true });
      const quote = await seedQuote(page, seed, { documentDate: '2026-03-02', dueDate: '2026-03-16', quantity: '2', unitPrice: '200.00' });
      // Exact bigint-computed expectations: 2 x 200.00 = 400.00, GST 5% = 20.00, total 420.00.
      const subtotal = toCents('400.00');
      const tax = toCents('20.00');
      const total = toCents('420.00');
      const part = toCents('200.00');
      const rest = toCents('220.00');
      expect(quote.subtotal).toBe('400.0000');
      expect(quote.taxTotal).toBe('20.0000');
      expect(quote.total).toBe('420.0000');
      expect(subtotal + tax).toBe(total);
      expect(part + rest).toBe(total);

      // UI: issue the quote.
      await openDrawer(page, `/estimates?estimate=${quote.quoteId}`);
      await uiOrderAction(page, '/api/estimates', quote.quoteId, 'Issue');
      await expect(page.locator('[role="dialog"]').first().getByText('Approved')).toBeVisible({ timeout: 15000 });

      // UI: convert to sales order.
      const so = await uiConvert(page, `/estimates?estimate=${quote.quoteId}`, '/api/estimates', quote.quoteId, 'Convert to Sales order', 'sales_order');

      // Fulfil (no fulfil affordance in the SO UI; same convert endpoint the workspace would call).
      const soGet = await apiOk(page, 'GET', `/api/sales-orders/${so.id}`);
      const fulfil = await api(page, 'POST', `/api/sales-orders/${so.id}/convert`, {
        targetKind: 'sales_fulfillment', expectedUpdatedAt: str(docOf(soGet).updated_at, 'so revision'),
      });
      expect(fulfil.status, JSON.stringify(fulfil.body).slice(0, 300)).toBe(200);

      // UI: convert the sales order to a customer invoice, submit, post.
      const inv = await uiConvert(page, `/sales-orders?order=${so.id}`, '/api/sales-orders', so.id, 'Convert to Invoice', 'customer_invoice');
      await uiSubmitAndPost(page, `/ar/invoices?doc=${inv.id}`, 'Open');

      // Invoice list shows the posted total and full open balance.
      await page.goto('/ar/invoices');
      const invRow = page.locator('tr', { hasText: inv.documentNumber }).first();
      await expect(invRow.getByText(fmtCAD(total)).first()).toBeVisible();

      // AR aging as of 2026-03-31: the invoice is 15 days past due (due 03-16).
      await page.goto('/reports/aging?period=custom&from=2026-03-01&to=2026-03-31&side=ar');
      await page.waitForTimeout(2000);
      let rows = await reportRows(page);
      {
        const agingRow = findRow(rows, `${t} Customer`);
        // Columns: Party | Current | 1-30 | 31-60 | 61-90 | 90+ | Total.
        expect(agingRow[2]).toBe(fmtCAD(total));
        expect(agingRow[agingRow.length - 1]).toBe(fmtCAD(total));
      }

      // Receipt 1 (partial 200.00 on 03-10): seed, post through the UI.
      const receipt1 = await seedReceipt(page, seed, '200.00', '2026-03-10');
      await uiPostReceipt(page, receipt1.payId);

      // Receipt 2 (remainder 220.00 on 03-20): seed, post through the UI.
      const receipt2 = await seedReceipt(page, seed, '220.00', '2026-03-20');
      await uiPostReceipt(page, receipt2.payId);

      // Invoice open balance is exactly 0 in the list and the drawer.
      await page.goto('/ar/invoices');
      const paidRow = page.locator('tr', { hasText: inv.documentNumber }).first();
      await expect(paidRow.getByText(fmtCAD(0n)).first()).toBeVisible();
      await openDrawer(page, `/ar/invoices?doc=${inv.id}`);
      await expect(page.locator('[role="dialog"]').first().getByText(fmtCAD(0n)).first()).toBeVisible();

      // AR aging as of 03-31 carries nothing for this customer.
      await page.goto('/reports/aging?period=custom&from=2026-03-01&to=2026-03-31&side=ar');
      await expect(page.locator('tr', { hasText: `${t} Customer` })).toHaveCount(0);

      // Bank: open a reconciliation, import the statement, match + sign off in the UI.
      const rec = await apiOk(page, 'POST', '/api/banking/reconciliations', {
        accountId: seed.bankId, throughDate: '2026-03-31', statementBalance: '420.00',
      });
      const recId = str(rec.id, 'reconciliation id');
      const csv = 'date,amount,description\n2026-03-10,200.00,Receipt one\n2026-03-20,220.00,Receipt two';
      const imp = await apiOk(page, 'POST', '/api/banking/import', {
        accountId: seed.bankId, source: 'csv', text: csv,
        mapping: { date: 0, amount: 1, description: 2 }, mode: 'import',
      });
      expect(imp.imported).toBe(2);
      await page.goto(`/banking/match?account=${seed.bankId}`);
      await dismissSetupWizard(page);
      // Match each statement line against its receipt journal, one pair at a
      // time: statement row by its description, GL row by receipt number.
      for (const [label, receipt] of [['Receipt one', receipt1.number], ['Receipt two', receipt2.number]] as const) {
        // Statement lines are single-select radios; ledger lines are checkboxes.
        await page.locator('tr', { hasText: label }).first().locator('input[type="radio"]').check();
        await page.locator('tr', { hasText: receipt }).first().locator('input[type="checkbox"]').check();
        const matched = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/matches`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Match selected', exact: true }).click();
        const res = await matched;
        expect(res.status(), await res.text()).toBe(200);
      }
      {
        const signed = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/sign-off`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Sign off', exact: true }).click();
        // Sign-off asks for confirmation in a portal dialog.
        await page.locator('[role="dialog"]', { hasText: 'Confirm' }).last().getByRole('button', { name: 'Confirm', exact: true }).click();
        const res = await signed;
        expect(res.status(), await res.text()).toBe(200);
      }

      // Reports tie to the posted journal (period-filtered to March).
      const period = 'period=custom&from=2026-03-01&to=2026-03-31';
      await page.goto(`/reports/pnl?${period}`);
      rows = await reportRows(page);
      expect(findRow(rows, `${t} Service Revenue`)).toContain(fmtCAD(subtotal));
      expect(findRow(rows, 'Net income')).toContain(fmtCAD(subtotal));
      await page.goto(`/reports/trial-balance?${period}`);
      rows = await reportRows(page);
      {
        // Columns: Account # | Account | Debits | Credits | Balance.
        // Zero-balance accounts are omitted: AR nets to exactly 0, so its
        // absence plus balanced totals proves the subledger cleared.
        const bankRow = findRow(rows, `${t} Operating`);
        expect(bankRow[2]).toBe(fmtCAD(total));
        expect(bankRow[4]).toBe(fmtCAD(total));
        expect(rows.some((r) => r.some((c) => c.includes('Accounts Receivable')))).toBe(false);
        const taxRow = findRow(rows, 'Sales Tax Payable');
        expect(taxRow[3]).toBe(fmtCAD(tax));
        expect(taxRow[4]).toBe(fmtCAD(-tax));
        const revenueRow = findRow(rows, `${t} Service Revenue`);
        expect(revenueRow[3]).toBe(fmtCAD(subtotal));
        expect(revenueRow[4]).toBe(fmtCAD(-subtotal));
        const totalsRow = findRow(rows, 'Totals');
        expect(totalsRow[2]).toBe(fmtCAD(total));
        expect(totalsRow[3]).toBe(fmtCAD(total));
        expect(totalsRow[totalsRow.length - 1]).toBe(fmtCAD(0n));
      }
      await page.goto(`/reports/balance-sheet?${period}`);
      rows = await reportRows(page);
      expect(findRow(rows, 'Total Assets')).toContain(fmtCAD(total));
      expect(findRow(rows, 'Total Liabilities and Equity')).toContain(fmtCAD(total));

      // Audit trail on each document records its own lifecycle steps.
      expect(await auditActions(page, `/estimates?estimate=${quote.quoteId}`)).toContain('Created');
      {
        const invoiceAudit = await auditActions(page, `/ar/invoices?doc=${inv.id}`);
        expect(invoiceAudit).toContain('Created');
        expect(invoiceAudit).toContain('Posted');
        expect(invoiceAudit).toContain('E2E Admin');
      }
      {
        const receiptAudit = await auditActions(page, `/receipts?payment=${receipt2.payId}`);
        expect(receiptAudit).toContain('Created');
        expect(receiptAudit).toContain('Posted');
      }
      expect(tax).toBe(toCents('20.00'));
    } finally {
      await context.close();
    }
  });

  test('credit memo applied alongside a cash receipt', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const t = tag('Q2CB');
      const rc = runCode();
      const seed = await seedScenario(page, t, { incomeNumber: `4492${rc}`, bankNumber: `1492${rc}`, withTax: true });
      const quote = await seedQuote(page, seed, { documentDate: '2026-04-02', dueDate: '2026-04-16', quantity: '2', unitPrice: '200.00' });
      // 2 x 200.00 = 400.00, GST 5% = 20.00, total 420.00.
      const subtotal = toCents('400.00');
      const tax = toCents('20.00');
      const total = toCents('420.00');
      const creditTotal = toCents('210.00');
      const cash = toCents('210.00');
      expect(quote.total).toBe('420.0000');
      expect(subtotal + tax).toBe(total);
      expect(creditTotal + cash).toBe(total);

      await openDrawer(page, `/estimates?estimate=${quote.quoteId}`);
      await uiOrderAction(page, '/api/estimates', quote.quoteId, 'Issue');
      await expect(page.locator('[role="dialog"]').first().getByText('Approved')).toBeVisible({ timeout: 15000 });
      const so = await uiConvert(page, `/estimates?estimate=${quote.quoteId}`, '/api/estimates', quote.quoteId, 'Convert to Sales order', 'sales_order');
      const soGet = await apiOk(page, 'GET', `/api/sales-orders/${so.id}`);
      const fulfil = await api(page, 'POST', `/api/sales-orders/${so.id}/convert`, {
        targetKind: 'sales_fulfillment', expectedUpdatedAt: str(docOf(soGet).updated_at, 'so revision'),
      });
      expect(fulfil.status, JSON.stringify(fulfil.body).slice(0, 300)).toBe(200);
      const inv = await uiConvert(page, `/sales-orders?order=${so.id}`, '/api/sales-orders', so.id, 'Convert to Invoice', 'customer_invoice');
      await uiSubmitAndPost(page, `/ar/invoices?doc=${inv.id}`, 'Open');

      // Credit memo for half the invoice (1 x 200.00 + 5% = 210.00).
      const cd = await apiOk(page, 'POST', '/api/documents/draft', { kind: 'customer_credit' });
      const creditId = str(cd.id, 'credit id');
      const cg = await apiOk(page, 'GET', `/api/documents/${creditId}`);
      const cp = await api(page, 'PATCH', `/api/documents/${creditId}`, {
        expectedUpdatedAt: str(docOf(cg).updated_at, 'credit revision'),
        partyId: seed.partyId, documentDate: '2026-04-08',
        lines: [{ accountId: seed.incomeId, description: `${t} credit`, quantity: '1', unitPrice: '200.00', amount: '200.00', taxCodeId: seed.taxCodeId }],
      });
      expect(cp.status, JSON.stringify(cp.body).slice(0, 300)).toBe(200);
      expect(docOf(cp.body).total).toBe('210.0000');
      await uiSubmitAndPost(page, `/ar/invoices?doc=${creditId}`, 'Posted');

      // Discover open lines: invoice (debit) via open-items, credit via credit-items.
      const oi = await apiOk(page, 'GET', `/api/payments/open-items?partyId=${seed.partyId}&side=ar`);
      const invLine = (oi.items as Json[])[0] as Json;
      expect(str(invLine.documentNumber as string)).toBe(inv.documentNumber);
      const ci = await apiOk(page, 'GET', `/api/payments/credit-items?partyId=${seed.partyId}&side=ar`);
      const creditLine = (ci.items as Json[])[0] as Json;
      expect(str(creditLine.documentNumber as string).startsWith('CM-')).toBe(true);

      // One receipt: 210.00 cash plus the 210.00 credit memo.
      const pd = await apiOk(page, 'POST', '/api/payments/draft', { kind: 'customer_payment' });
      const payId = str(pd.id, 'payment id');
      const pg = await apiOk(page, 'GET', `/api/payments/${payId}`);
      const pp = await api(page, 'PATCH', `/api/payments/${payId}`, {
        partyId: seed.partyId, bankAccountId: seed.bankId, documentDate: '2026-04-15',
        expectedUpdatedAt: str(docOf(pg).updated_at, 'payment revision'),
        allocations: [{
          openLineId: str(invLine.lineId), sourceTransactionAmount: '210.00', targetTransactionAmount: '210.00',
          settlementRate: '1', settlementRateSource: 'same_currency', settlementRateReference: 'same transaction currency',
        }],
        creditAllocations: [{
          fromLineId: str(creditLine.lineId), toLineId: str(invLine.lineId),
          amount: '210.00', sourceDocumentId: creditId,
        }],
      });
      expect(pp.status, JSON.stringify(pp.body).slice(0, 300)).toBe(200);
      await uiPostReceipt(page, payId);
      const receiptNumber = str(docOf(pp.body).document_number, 'receipt number');

      // Invoice and credit both fully applied.
      await page.goto('/ar/invoices');
      const paidRow = page.locator('tr', { hasText: inv.documentNumber }).first();
      await expect(paidRow.getByText(fmtCAD(0n)).first()).toBeVisible();
      const ciAfter = await apiOk(page, 'GET', `/api/payments/credit-items?partyId=${seed.partyId}&side=ar`);
      expect((ciAfter.items as Json[]).length).toBe(0);
      await page.goto('/reports/aging?period=custom&from=2026-04-01&to=2026-04-30&side=ar');
      await expect(page.locator('tr', { hasText: `${t} Customer` })).toHaveCount(0);

      // Bank: statement 210.00, match the cash receipt, sign off.
      const rec = await apiOk(page, 'POST', '/api/banking/reconciliations', {
        accountId: seed.bankId, throughDate: '2026-04-30', statementBalance: '210.00',
      });
      const recId = str(rec.id, 'reconciliation id');
      const imp = await apiOk(page, 'POST', '/api/banking/import', {
        accountId: seed.bankId, source: 'csv', text: 'date,amount,description\n2026-04-15,210.00,Cash receipt',
        mapping: { date: 0, amount: 1, description: 2 }, mode: 'import',
      });
      expect(imp.imported).toBe(1);
      await page.goto(`/banking/match?account=${seed.bankId}`);
      await dismissSetupWizard(page);
      await page.locator('tr', { hasText: 'Cash receipt' }).first().locator('input[type="radio"]').check();
      await page.locator('tr', { hasText: receiptNumber }).first().locator('input[type="checkbox"]').check();
      {
        const matched = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/matches`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Match selected', exact: true }).click();
        const res = await matched;
        expect(res.status(), await res.text()).toBe(200);
      }
      {
        const signed = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/sign-off`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Sign off', exact: true }).click();
        await page.locator('[role="dialog"]', { hasText: 'Confirm' }).last().getByRole('button', { name: 'Confirm', exact: true }).click();
        const res = await signed;
        expect(res.status(), await res.text()).toBe(200);
      }

      // Reports tie (April, cumulative as-of 04-30 across both scenarios:
      // bank 420+210, revenue 400+400-200, tax 20+20-10, AR cleared).
      // P&L is period movement: April only.
      const netRevenue = subtotal - toCents('200.00');
      const netTax = tax - toCents('10.00');
      expect(netRevenue).toBe(toCents('200.00'));
      expect(netTax).toBe(toCents('10.00'));
      const period = 'period=custom&from=2026-04-01&to=2026-04-30';
      await page.goto(`/reports/pnl?${period}`);
      let rows = await reportRows(page);
      expect(findRow(rows, `${t} Service Revenue`)).toContain(fmtCAD(netRevenue));
      expect(findRow(rows, 'Net income')).toContain(fmtCAD(netRevenue));
      await page.goto(`/reports/trial-balance?${period}`);
      rows = await reportRows(page);
      {
        // Columns: Account # | Account | Debits | Credits | Balance.
        const bankRow = findRow(rows, `${t} Operating`);
        expect(bankRow[2]).toBe(fmtCAD(cash));
        expect(bankRow[4]).toBe(fmtCAD(cash));
        expect(rows.some((r) => r.some((c) => c.includes('Accounts Receivable')))).toBe(false);
        const taxRow = findRow(rows, 'Sales Tax Payable');
        // Gross columns are cumulative: March invoice credits 20.00, April
        // invoice credits 20.00, April credit-memo debits 10.00.
        expect(taxRow[2]).toBe(fmtCAD(toCents('10.00')));
        expect(taxRow[3]).toBe(fmtCAD(toCents('40.00')));
        expect(taxRow[4]).toBe(fmtCAD(-netTax - toCents('20.00')));
        const revenueRow = findRow(rows, `${t} Service Revenue`);
        expect(revenueRow[2]).toBe(fmtCAD(toCents('200.00')));
        expect(revenueRow[3]).toBe(fmtCAD(subtotal));
        expect(revenueRow[4]).toBe(fmtCAD(-netRevenue));
        const totalsRow = findRow(rows, 'Totals');
        // Debits 630 + 10 + 200 = 840; credits 40 + 400 + 400 = 840.
        expect(totalsRow[2]).toBe(fmtCAD(toCents('840.00')));
        expect(totalsRow[3]).toBe(fmtCAD(toCents('840.00')));
        expect(totalsRow[totalsRow.length - 1]).toBe(fmtCAD(0n));
      }
      await page.goto(`/reports/balance-sheet?${period}`);
      rows = await reportRows(page);
      {
        const cumBank = toCents('420.00') + cash;
        const cumTax = toCents('20.00') + netTax;
        expect(findRow(rows, 'Total Assets')).toContain(fmtCAD(cumBank));
        expect(findRow(rows, 'Total Liabilities and Equity')).toContain(fmtCAD(cumBank));
        expect(findRow(rows, 'Sales Tax Payable')).toContain(fmtCAD(cumTax));
        expect(findRow(rows, 'Accumulated earnings')).toContain(fmtCAD(cumBank - cumTax));
      }

      // Audit trail on the credit memo records its lifecycle.
      const creditAudit = await auditActions(page, `/ar/invoices?doc=${creditId}`);
      expect(creditAudit).toContain('Created');
      expect(creditAudit).toContain('Posted');
    } finally {
      await context.close();
    }
  });

  test('foreign-currency invoice with realized loss on receipt', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const t = tag('Q2CC');
      const rc = runCode();
      // Orders are base-currency-only, so the USD invoice is raised directly
      // as a customer invoice (same drawer, same post lifecycle).
      const fx = await apiOk(page, 'POST', '/api/admin/setup/fx-rates', {
        asOf: '2026-03-01', fromCurrency: 'USD', toCurrency: 'CAD', rateType: 'spot', rate: '1.3600',
      });
      expect(str(fx.id, 'fx rate id').length > 0).toBe(true);
      const fxAcct = await api(page, 'POST', '/api/accounts',
        { name: `${t} FX Realized`, type: 'income_other', number: `4993${rc}` },
        { 'Idempotency-Key': crypto.randomUUID() });
      expect(fxAcct.status, JSON.stringify(fxAcct.body).slice(0, 200)).toBe(201);
      const fxAcctId = str((fxAcct.body.account as Json).id, 'fx account id');
      const ctl = await api(page, 'PUT', '/api/admin/settings', { controlAccounts: { fxRealizedGainLoss: fxAcctId } });
      expect(ctl.status, JSON.stringify(ctl.body).slice(0, 300)).toBe(200);
      const seed = await seedScenario(page, t, { incomeNumber: `4493${rc}`, bankNumber: `1493${rc}`, withTax: false });

      // Exact bigint-computed expectations: invoice USD 1,000.00 @ 1.36 =
      // CAD 1,360.00 base; receipt CAD 1,250.00 @ 0.8 settles the USD 1,000;
      // realized FX loss CAD 110.00.
      const invoiceTxn = toCents('1000.00');
      const invoiceBase = toCents('1360.00');
      const receiptBase = toCents('1250.00');
      const fxLoss = toCents('110.00');
      expect(invoiceBase - receiptBase).toBe(fxLoss);

      const dd = await apiOk(page, 'POST', '/api/documents/draft', { kind: 'customer_invoice' });
      const invId = str(dd.id, 'invoice id');
      const dg = await apiOk(page, 'GET', `/api/documents/${invId}`);
      const dp = await api(page, 'PATCH', `/api/documents/${invId}`, {
        expectedUpdatedAt: str(docOf(dg).updated_at, 'invoice revision'),
        partyId: seed.partyId, currency: 'USD', documentDate: '2026-05-05', dueDate: '2026-05-19',
        lines: [{ accountId: seed.incomeId, description: `${t} export`, quantity: '1', unitPrice: '1000.00', amount: '1000.00' }],
      });
      expect(dp.status, JSON.stringify(dp.body).slice(0, 300)).toBe(200);
      expect(docOf(dp.body).total).toBe('1000.0000');
      const invNumber = str(docOf(dp.body).document_number, 'invoice number');
      await uiSubmitAndPost(page, `/ar/invoices?doc=${invId}`, 'Open');

      // Receipt in CAD against the USD invoice with an explicit bank-advice rate.
      const oi = await apiOk(page, 'GET', `/api/payments/open-items?partyId=${seed.partyId}&side=ar`);
      const invLine = (oi.items as Json[])[0] as Json;
      expect(str(invLine.documentNumber as string)).toBe(invNumber);
      const pd = await apiOk(page, 'POST', '/api/payments/draft', { kind: 'customer_payment' });
      const payId = str(pd.id, 'payment id');
      const pg = await apiOk(page, 'GET', `/api/payments/${payId}`);
      const pp = await api(page, 'PATCH', `/api/payments/${payId}`, {
        partyId: seed.partyId, bankAccountId: seed.bankId, documentDate: '2026-05-12',
        expectedUpdatedAt: str(docOf(pg).updated_at, 'payment revision'),
        allocations: [{
          openLineId: str(invLine.lineId), sourceTransactionAmount: '1250.00', targetTransactionAmount: '1000.00',
          settlementRate: '0.8', settlementRateSource: 'manual', settlementRateReference: 'E2E bank advice FX3',
        }],
      });
      expect(pp.status, JSON.stringify(pp.body).slice(0, 300)).toBe(200);
      await uiPostReceipt(page, payId);
      const receiptNumber = str(docOf(pp.body).document_number, 'receipt number');

      // Invoice fully settled in both currencies.
      await page.goto('/ar/invoices');
      const paidRow = page.locator('tr', { hasText: invNumber }).first();
      await expect(paidRow.getByText(fmtUSD(0n)).first()).toBeVisible();
      await page.goto('/reports/aging?period=custom&from=2026-05-01&to=2026-05-31&side=ar');
      await expect(page.locator('tr', { hasText: `${t} Customer` })).toHaveCount(0);

      // Bank: statement CAD 1,250.00, match the receipt, sign off.
      const rec = await apiOk(page, 'POST', '/api/banking/reconciliations', {
        accountId: seed.bankId, throughDate: '2026-05-31', statementBalance: '1250.00',
      });
      const recId = str(rec.id, 'reconciliation id');
      const imp = await apiOk(page, 'POST', '/api/banking/import', {
        accountId: seed.bankId, source: 'csv', text: 'date,amount,description\n2026-05-12,1250.00,FX receipt',
        mapping: { date: 0, amount: 1, description: 2 }, mode: 'import',
      });
      expect(imp.imported).toBe(1);
      await page.goto(`/banking/match?account=${seed.bankId}`);
      await dismissSetupWizard(page);
      await page.locator('tr', { hasText: 'FX receipt' }).first().locator('input[type="radio"]').check();
      await page.locator('tr', { hasText: receiptNumber }).first().locator('input[type="checkbox"]').check();
      {
        const matched = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/matches`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Match selected', exact: true }).click();
        const res = await matched;
        expect(res.status(), await res.text()).toBe(200);
      }
      {
        const signed = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/sign-off`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Sign off', exact: true }).click();
        await page.locator('[role="dialog"]', { hasText: 'Confirm' }).last().getByRole('button', { name: 'Confirm', exact: true }).click();
        const res = await signed;
        expect(res.status(), await res.text()).toBe(200);
      }

      // Reports tie (May movement for P&L; cumulative as-of 05-31 for TB/BS:
      // bank 420+210+1250, revenue 400+200net+1360, tax 20+10net, FX loss 110).
      const period = 'period=custom&from=2026-05-01&to=2026-05-31';
      await page.goto(`/reports/pnl?${period}`);
      let rows = await reportRows(page);
      expect(findRow(rows, `${t} Service Revenue`)).toContain(fmtCAD(invoiceBase));
      await page.goto(`/reports/trial-balance?${period}`);
      rows = await reportRows(page);
      {
        const cumBank = toCents('420.00') + toCents('210.00') + receiptBase;
        const bankRow = findRow(rows, `${t} Operating`);
        expect(bankRow[2]).toBe(fmtCAD(receiptBase));
        expect(bankRow[4]).toBe(fmtCAD(receiptBase));
        expect(rows.some((r) => r.some((c) => c.includes('Accounts Receivable')))).toBe(false);
        const fxRow = findRow(rows, `${t} FX Realized`);
        expect(fxRow[2]).toBe(fmtCAD(fxLoss));
        expect(fxRow[4]).toBe(fmtCAD(fxLoss));
        const revenueRow = findRow(rows, `${t} Service Revenue`);
        expect(revenueRow[3]).toBe(fmtCAD(invoiceBase));
        expect(revenueRow[4]).toBe(fmtCAD(-invoiceBase));
        const totalsRow = findRow(rows, 'Totals');
        // Debits 1880 + 10 + 200 + 110 = 2200; credits 40 + 400 + 400 + 1360 = 2200.
        expect(totalsRow[2]).toBe(fmtCAD(toCents('2200.00')));
        expect(totalsRow[3]).toBe(fmtCAD(toCents('2200.00')));
        expect(totalsRow[totalsRow.length - 1]).toBe(fmtCAD(0n));
        expect(cumBank).toBe(toCents('1880.00'));
      }
      await page.goto(`/reports/balance-sheet?${period}`);
      rows = await reportRows(page);
      {
        const cumBank = toCents('1880.00');
        const cumTax = toCents('30.00');
        const cumEarnings = toCents('400.00') + toCents('200.00') + invoiceBase - fxLoss;
        expect(cumEarnings).toBe(toCents('1850.00'));
        expect(findRow(rows, 'Total Assets')).toContain(fmtCAD(cumBank));
        expect(findRow(rows, 'Total Liabilities and Equity')).toContain(fmtCAD(cumBank));
        expect(findRow(rows, 'Sales Tax Payable')).toContain(fmtCAD(cumTax));
        expect(findRow(rows, 'Accumulated earnings')).toContain(fmtCAD(cumEarnings));
      }
      expect(invoiceTxn).toBe(toCents('1000.00'));
    } finally {
      await context.close();
    }
  });
});
