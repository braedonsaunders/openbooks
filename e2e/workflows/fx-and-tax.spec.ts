import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { authedContext, dismissSetupWizard } from '../auth';

/**
 * E2E workflow: foreign currency and tax filing lifecycle.
 *
 * A transaction in a currency that is not the company's — through payment at a
 * different rate (realized FX), period-end revaluation over the open balance
 * (unrealized FX) — then the tax side: transactions carrying tax codes from
 * two jurisdictions, rolled into their country return packs, prepared, filed,
 * and traced back to the transactions that produced them.
 *
 * Design notes (read before editing):
 * - Seeding uses `page.request` against the same API routes the UI calls
 *   (wizard, fx-rates, tax-codes, tax-rates, documents, payments, close,
 *   tax returns/filings, reports/run), never direct SQL: the ledger under
 *   test is posted by the real kernel, fences included.
 * - Money is asserted exactly, in-test, with bigint minor-unit math. No
 *   floats anywhere; API decimals are 4dp strings, UI cells grouped 2dp.
 * - Base currency is USD; the org domicile (US) is incidental — the returns
 *   exercised are the German (DE_USTVA) and Australian (AU_BAS_GST) packs,
 *   mapped by each tenant code's declared country, never by a branch on the
 *   org. No screen in this path may assume any country.
 * - Retry safety (CI retries: 1): every seeded name/code/number carries a
 *   per-attempt tag, document months shift with the retry index, and the FX
 *   currency rotates per retry — so a retried test seeds disjoint data.
 *   Return/filing windows always equal the CURRENT attempt's months, and
 *   expected return figures are summed live from the documents whose date
 *   falls in that window, so leftovers from a failed attempt can never leak
 *   into an exact assertion.
 * - Local re-runs need a FRESH scratch database (drop + bootstrap): month
 *   windows are fixed per retry index, so a dirty DB doubles every figure.
 *   Pass E2E_RUN=2 (etc.) for distinct account numbers/codes if you must
 *   share a database across runs.
 */

const RUN = process.env.E2E_RUN ?? '';
const YEAR = 2026;

/** Per-attempt tag: a Playwright retry re-seeds against an already-seeded org. */
function tag(base: string): string {
  const retry = test.info().retry;
  return `${base}${RUN}${retry > 0 ? `R${retry}` : ''}`;
}

/** Two digits distinguishing re-runs; retries shift it so numbers stay free. */
function runCode(): string {
  const m = /(\d+)\s*$/.exec(RUN);
  const base = m ? Number(m[1]) : 0;
  return String((base + test.info().retry * 17) % 100).padStart(2, '0');
}

const retryIndex = (): number => test.info().retry;

/** Foreign currency for this attempt — rotation keeps retried attempts disjoint. */
function fxCurrency(): string {
  return ['EUR', 'GBP', 'CHF'][retryIndex() % 3]!;
}

/** Shifted month: base month + retry index, so retried attempts post elsewhere. */
function mm(base: number): number {
  return base + retryIndex();
}

function isoDate(month: number, day: number): string {
  return `${YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthStart(month: number): string {
  return isoDate(month, 1);
}

function monthEnd(month: number): string {
  const last = new Date(Date.UTC(YEAR, month, 0)).getUTCDate();
  return isoDate(month, last);
}

/** Minor-unit money: '110.00' -> 11000n. */
function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (!m) throw new Error(`bad money literal ${amount}`);
  const sign = m[1] === '-' ? -1n : 1n;
  return sign * (BigInt(m[2] as string) * 100n + BigInt(m[3] as string));
}

/** 4dp API decimal -> cents, exact. */
function toCents4(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{4})$/.exec(amount);
  if (!m) throw new Error(`bad 4dp money literal ${amount}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const units = BigInt(m[2] as string) * 10000n + BigInt(m[3] as string);
  if (units % 100n !== 0n) throw new Error(`sub-cent 4dp amount ${amount}`);
  return (sign * units) / 100n;
}

/** 2dp or 4dp decimal -> cents, exact (entry lines print 4dp, literals 2dp). */
function toCentsAny(amount: string): bigint {
  if (/^-?\d+\.\d{2}$/.test(amount)) return toCents(amount);
  return toCents4(amount);
}

function grouped(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** UI money cell in USD: 110000n -> '$1,100.00', -100n -> '($1.00)'. */
function fmtUSD(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const text = `$${grouped((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `(${text})` : text;
}

type Json = Record<string, unknown>;

function str(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !value) throw new Error(`expected ${what} string, got ${JSON.stringify(value)?.slice(0, 80)}`);
  return value;
}

function docOf(body: Json): Json {
  return body.doc as Json;
}

/** Real product API call on the authed browser session (Origin header included). */
async function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Json }> {
  const res = await page.request.fetch(path, {
    method,
    headers: { Origin: new URL(page.url()).origin, ...(headers ?? {}) },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status(), body: (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Json };
}

async function apiOk(page: Page, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Json> {
  const res = await api(page, method, path, body, headers);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body).slice(0, 400)}`).toBeLessThan(300);
  return res.body;
}

/** First-run org setup through the product's setup-wizard API. */
async function setupOrg(page: Page): Promise<void> {
  const res = await api(page, 'PUT', '/api/admin/setup/wizard', {
    name: 'W4 FX Tax Co',
    country: 'US',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    reportingFramework: 'us_gaap',
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

async function createAccount(page: Page, name: string, type: string, number: string, extra: Json = {}): Promise<string> {
  const res = await api(page, 'POST', '/api/accounts', { name, type, number, ...extra }, { 'Idempotency-Key': crypto.randomUUID() });
  expect(res.status, `account ${name}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(201);
  return str((res.body.account as Json).id, `${name} id`);
}

async function createParty(page: Page, role: string, displayName: string): Promise<string> {
  const draft = await apiOk(page, 'POST', '/api/parties/draft', { role });
  const id = str(draft.id, 'party id');
  const current = await apiOk(page, 'GET', `/api/parties/${id}`);
  const party = current.party as Json;
  await apiOk(page, 'PATCH', `/api/parties/${id}`, {
    displayName, isActive: true, changeReason: 'e2e fx-and-tax activation',
    expectedUpdatedAt: str(party.updated_at, 'party revision'),
  });
  return id;
}

/** Post one drawer document (invoice/bill) through draft -> PATCH -> submit -> post. */
async function postDocument(page: Page, kind: string, patch: Json): Promise<{ id: string; number: string }> {
  const draft = await apiOk(page, 'POST', '/api/documents/draft', { kind });
  const id = str(draft.id, `${kind} id`);
  const current = await apiOk(page, 'GET', `/api/documents/${id}`);
  const filled = await api(page, 'PATCH', `/api/documents/${id}`, {
    expectedUpdatedAt: str(docOf(current).updated_at, `${kind} revision`), ...patch,
  });
  expect(filled.status, `${kind} fill: ${JSON.stringify(filled.body).slice(0, 400)}`).toBe(200);
  await apiOk(page, 'POST', '/api/documents/actions', { action: 'submit', documentId: id });
  const posted = await api(page, 'POST', '/api/documents/actions', { action: 'post', documentId: id });
  expect(posted.status, `${kind} post: ${JSON.stringify(posted.body).slice(0, 400)}`).toBe(200);
  expect(posted.body.ok).toBe(true);
  const doc = await apiOk(page, 'GET', `/api/documents/${id}`);
  return { id, number: str(docOf(doc).document_number, `${kind} number`) };
}

/** Open a drawer fresh (settled state) for UI interaction. */
async function openDrawer(page: Page, drawerUrl: string) {
  await page.goto(drawerUrl);
  await dismissSetupWizard(page);
  const drawer = page.locator('[role="dialog"]').first();
  // Dev compiles the route on first hit; production (CI) is instant.
  await expect(drawer).toBeVisible({ timeout: 60000 });
  return drawer;
}

/** Submit then post a document drawer (two-step approval lifecycle). */
async function uiSubmitAndPost(page: Page, drawerUrl: string, expectedBadge: 'Open' | 'Posted'): Promise<void> {
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
  await expect(drawer2.getByText(expectedBadge)).toBeVisible({ timeout: 15000 });
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

interface FxSeed {
  fxRealizedId: string;
  fxRealizedNumber: string;
  fxUnrealizedId: string;
  fxUnrealizedNumber: string;
  incomeId: string;
  incomeNumber: string;
  bankId: string;
  bankNumber: string;
  eurCustomerId: string;
  eurCustomerName: string;
  invoiceId: string;
  invoiceNumber: string;
  invoicePeriodId: string;
  invoiceEntryId: string;
  fx: string;
  m1: number;
  m2: number;
}

const fxSeedCache = new Map<string, FxSeed>();

/**
 * Seed the FX side for THIS attempt: custom accounts (so the realized and
 * unrealized postings must land on configured accounts, never hardcoded
 * ones), spot rates, and a foreign-currency customer. Keyed by attempt tag so
 * a retried test never collides with its failed attempt.
 */
async function seedFx(page: Page): Promise<FxSeed> {
  const t = tag('W4FX');
  const cached = fxSeedCache.get(t);
  if (cached) return cached;
  const rc = runCode();
  const fx = fxCurrency();
  const m1 = mm(3);
  const m2 = mm(4);
  const fxRealizedNumber = `4996${rc}`;
  const fxUnrealizedNumber = `4997${rc}`;
  const incomeNumber = `4496${rc}`;
  const bankNumber = `1496${rc}`;
  const fxRealizedId = await createAccount(page, `${t} FX Realized`, 'income_other', fxRealizedNumber);
  const fxUnrealizedId = await createAccount(page, `${t} FX Unrealized`, 'income_other', fxUnrealizedNumber);
  const incomeId = await createAccount(page, `${t} Export Revenue`, 'income', incomeNumber);
  const bankId = await createAccount(page, `${t} Operating`, 'asset_bank', bankNumber, { reconcilable: true, currencyRestriction: 'USD' });
  const ctl = await api(page, 'PUT', '/api/admin/settings', {
    controlAccounts: { fxRealizedGainLoss: fxRealizedId, fxUnrealizedGainLoss: fxUnrealizedId },
  });
  expect(ctl.status, `control accounts: ${JSON.stringify(ctl.body).slice(0, 300)}`).toBe(200);
  for (const [asOf, rate] of [
    [monthStart(m1), '1.1000'],
    [monthStart(m2), '1.2000'],
    [monthEnd(m2), '1.3000'],
  ] as const) {
    const spot = await api(page, 'POST', '/api/admin/setup/fx-rates', {
      asOf, fromCurrency: fx, toCurrency: 'USD', rateType: 'spot', rate,
    });
    expect(spot.status, `fx spot ${fx}->USD @ ${asOf}: ${JSON.stringify(spot.body).slice(0, 300)}`).toBe(200);
  }
  const eurCustomerName = `${t} Euro Customer`;
  const eurCustomerId = await createParty(page, 'customer', eurCustomerName);
  const seed: FxSeed = {
    fxRealizedId, fxRealizedNumber, fxUnrealizedId, fxUnrealizedNumber,
    incomeId, incomeNumber, bankId, bankNumber, eurCustomerId, eurCustomerName,
    invoiceId: '', invoiceNumber: '', invoicePeriodId: '', invoiceEntryId: '', fx, m1, m2,
  };
  fxSeedCache.set(t, seed);
  return seed;
}

test.describe('fx and tax lifecycle', () => {
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

  test('foreign-currency invoice paid at a different rate posts the exact realized loss to the configured account', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const seed = await seedFx(page);
      const { fx, m1 } = seed;

      // Invoice 1,000.00 in the foreign currency at the month-start spot
      // 1.1000: the ledger carries 1,100.00 in company currency.
      const invoiceTxn = toCents('1000.00');
      const invoiceBase = toCents('1100.00');
      const receiptBase = toCents('1250.00');
      const fxLoss = toCents('150.00');
      expect(invoiceBase - receiptBase).toBe(-fxLoss);

      const dd = await apiOk(page, 'POST', '/api/documents/draft', { kind: 'customer_invoice' });
      seed.invoiceId = str(dd.id, 'invoice id');
      const dg = await apiOk(page, 'GET', `/api/documents/${seed.invoiceId}`);
      const fill = await api(page, 'PATCH', `/api/documents/${seed.invoiceId}`, {
        expectedUpdatedAt: str(docOf(dg).updated_at, 'invoice revision'),
        partyId: seed.eurCustomerId, currency: fx,
        documentDate: isoDate(m1, 5), dueDate: isoDate(m1, 19),
        lines: [{ accountId: seed.incomeId, description: `${tag('W4FX')} export widgets`, quantity: '1', unitPrice: '1000.00', amount: '1000.00' }],
      });
      expect(fill.status, `invoice fill: ${JSON.stringify(fill.body).slice(0, 300)}`).toBe(200);
      expect(docOf(fill.body).total).toBe('1000.0000');
      seed.invoiceNumber = str(docOf(fill.body).document_number, 'invoice number');
      await uiSubmitAndPost(page, `/ar/invoices?doc=${seed.invoiceId}`, 'Open');

      const inv = await apiOk(page, 'GET', `/api/documents/${seed.invoiceId}`);
      const invDoc = docOf(inv);
      // The product stamps the document-date spot, not today's rate.
      expect(invDoc.fx_rate).toBe('1.1000000000');
      expect(invDoc.currency).toBe(fx);
      expect(invDoc.total).toBe('1000.0000');
      seed.invoicePeriodId = str(invDoc.posting_period_id, 'invoice period');
      seed.invoiceEntryId = str(invDoc.posted_entry_id, 'invoice entry');

      // The open item carries both denominations: 1,000.00 txn, 1,100.00 base.
      const oi = await apiOk(page, 'GET', `/api/payments/open-items?partyId=${seed.eurCustomerId}&side=ar`);
      const items = oi.items as Json[];
      expect(items.length).toBe(1);
      const line = items[0] as Json;
      expect(toCents4(str(line.transactionOpen, 'txn open'))).toBe(invoiceTxn);
      expect(toCents4(str(line.open, 'base open'))).toBe(invoiceBase);

      // Receipt of USD 1,250.00 against the foreign 1,000.00 at an explicit
      // bank-advice rate of 0.8: the USD 150.00 shortfall is a realized loss.
      const payDraft = await apiOk(page, 'POST', '/api/payments/draft', { kind: 'customer_payment' });
      const payId = str(payDraft.id, 'payment id');
      const payCurrent = await apiOk(page, 'GET', `/api/payments/${payId}`);
      const patched = await api(page, 'PATCH', `/api/payments/${payId}`, {
        partyId: seed.eurCustomerId, bankAccountId: seed.bankId, documentDate: isoDate(m1, 12),
        expectedUpdatedAt: str(docOf(payCurrent).updated_at, 'payment revision'),
        allocations: [{
          openLineId: str(line.lineId, 'open line'), sourceTransactionAmount: '1250.00', targetTransactionAmount: '1000.00',
          settlementRate: '0.8', settlementRateSource: 'manual', settlementRateReference: `${tag('W4FX')} bank advice`,
        }],
      });
      expect(patched.status, `payment fill: ${JSON.stringify(patched.body).slice(0, 400)}`).toBe(200);
      const payRefreshed = await apiOk(page, 'GET', `/api/payments/${payId}`);
      const posted = await api(page, 'POST', '/api/payments/post-with-applications', {
        documentId: payId, expectedUpdatedAt: str(docOf(payRefreshed).updated_at, 'payment post revision'),
      });
      expect(posted.status, `payment post: ${JSON.stringify(posted.body).slice(0, 400)}`).toBe(200);

      // Settlement books the realized gain/loss as its own entry (origin fx
      // settlement), not inside the payment entry. It must land on the
      // CONFIGURED account: assert by the custom account number minted for
      // this attempt, so a hardcoded destination cannot satisfy this test.
      const fxReport = await apiOk(page, 'POST', '/api/reports/run', {
        query: {
          entity: 'ledger_lines', mode: 'rows',
          columns: ['posting_date', 'entry_number', 'account_number', 'account_name', 'amount', 'base_currency', 'txn_amount', 'currency', 'origin'],
          filters: {
            combinator: 'and',
            rules: [
              { field: 'entry_status', op: 'eq', value: 'posted' },
              { field: 'account_number', op: 'eq', value: seed.fxRealizedNumber },
              { field: 'posting_date', op: 'gte', value: monthStart(m1) },
              { field: 'posting_date', op: 'lte', value: monthEnd(m1) },
            ],
          },
          limit: 20,
        },
      });
      const fxGroups = (fxReport.result as Json).groups as Json[];
      const fxRows = (fxGroups[0] as Json).rows as string[][];
      expect(fxRows.length, 'one realized FX line').toBe(1);
      const fxCols = (fxGroups[0] as Json).columns as string[];
      const cell = (name: string): string => fxRows[0]![fxCols.indexOf(name)]!;
      expect(cell('Account #')).toBe(seed.fxRealizedNumber);
      // The USD 150.00 shortfall is a loss: a debit (negative) on the
      // income-normal gain/loss account, to the penny.
      expect(toCentsAny(cell('Amount (base)'))).toBe(-fxLoss);
      expect(cell('Functional currency')).toBe('USD');
      expect(cell('Origin')).toBe('fx settlement');
      // Nothing unrealized: settlement never touches the unrealized account.
      const unReport = await apiOk(page, 'POST', '/api/reports/run', {
        query: {
          entity: 'ledger_lines', mode: 'rows',
          columns: ['posting_date', 'amount'],
          filters: {
            combinator: 'and',
            rules: [
              { field: 'entry_status', op: 'eq', value: 'posted' },
              { field: 'account_number', op: 'eq', value: seed.fxUnrealizedNumber },
              { field: 'posting_date', op: 'gte', value: monthStart(m1) },
              { field: 'posting_date', op: 'lte', value: monthEnd(m1) },
            ],
          },
          limit: 20,
        },
      });
      expect(((unReport.result as Json).groups as Json[])[0]).toMatchObject({ isEmpty: true });

      // The invoice is fully settled in both denominations.
      const settled = await apiOk(page, 'GET', `/api/documents/${seed.invoiceId}`);
      expect(str(docOf(settled).balance_due, 'balance due')).toBe('0.0000');
      const oiAfter = await apiOk(page, 'GET', `/api/payments/open-items?partyId=${seed.eurCustomerId}&side=ar`);
      expect((oiAfter.items as Json[]).length).toBe(0);

      // The user can see it: invoice list shows the settled invoice, aging is
      // empty for the customer, and the trial balance carries the USD 150.00
      // realized loss on the configured account.
      await page.goto('/ar/invoices');
      const invRow = page.locator('tr', { hasText: seed.invoiceNumber }).first();
      await expect(invRow).toBeVisible();
      const period = `period=custom&from=${monthStart(m1)}&to=${monthEnd(m1)}`;
      await page.goto(`/reports/aging?${period}&side=ar`);
      await expect(page.locator('tr', { hasText: seed.eurCustomerName })).toHaveCount(0);
      await page.goto(`/reports/trial-balance?${period}`);
      const rows = await reportRows(page);
      const fxRow = findRow(rows, `${tag('W4FX')} FX Realized`);
      expect(fxRow).toContain(fmtUSD(fxLoss));
      const totalsRow = findRow(rows, 'Totals');
      expect(totalsRow[totalsRow.length - 1]).toBe(fmtUSD(0n));
    } finally {
      await context.close();
    }
  });

  test('period-end revaluation posts the unrealized gain once and reverses it next period', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const seed = await seedFx(page);
      const { fx, m2 } = seed;

      // Defensive settle: if the realized test failed before paying, its
      // invoice is still open and this period's revaluation would measure it.
      // On the happy path this is a no-op (no open items remain).
      const leftovers = await apiOk(page, 'GET', `/api/payments/open-items?partyId=${seed.eurCustomerId}&side=ar`);
      for (const item of (leftovers.items as Json[])) {
        const txnOpen = toCents4(str((item as Json).transactionOpen, 'leftover txn open'));
        const baseOpen = toCents4(str((item as Json).open, 'leftover base open'));
        if (txnOpen === 0n) continue;
        const payDraft = await apiOk(page, 'POST', '/api/payments/draft', { kind: 'customer_payment' });
        const payId = str(payDraft.id, 'settle payment id');
        const payCurrent = await apiOk(page, 'GET', `/api/payments/${payId}`);
        // Settle in full in company currency at the carrying rate: pays the
        // exact base open so no new gain or loss can arise here.
        const baseStr = `${(baseOpen / 100n).toString()}.${(baseOpen % 100n).toString().padStart(2, '0')}`;
        const txnStr = `${(txnOpen / 100n).toString()}.${(txnOpen % 100n).toString().padStart(2, '0')}`;
        const rate = (Number(txnStr) / Number(baseStr)).toFixed(10);
        await apiOk(page, 'PATCH', `/api/payments/${payId}`, {
          partyId: seed.eurCustomerId, bankAccountId: seed.bankId, documentDate: isoDate(m2, 2),
          expectedUpdatedAt: str(docOf(payCurrent).updated_at, 'settle revision'),
          allocations: [{
            openLineId: str((item as Json).lineId, 'leftover line'),
            sourceTransactionAmount: baseStr, targetTransactionAmount: txnStr,
            settlementRate: rate, settlementRateSource: 'manual', settlementRateReference: `${tag('W4FX')} retry settle`,
          }],
        });
        const payRefreshed = await apiOk(page, 'GET', `/api/payments/${payId}`);
        await apiOk(page, 'POST', '/api/payments/post-with-applications', {
          documentId: payId, expectedUpdatedAt: str(docOf(payRefreshed).updated_at, 'settle post revision'),
        });
      }

      // Second invoice, 500.00 foreign at the 1.2000 spot: 600.00 base. It
      // stays unpaid, so period-end must restate it to the 1.3000 spot.
      const posted2 = await postDocument(page, 'customer_invoice', {
        partyId: seed.eurCustomerId, currency: fx,
        documentDate: isoDate(m2, 7), dueDate: isoDate(m2, 21),
        lines: [{ accountId: seed.incomeId, description: `${tag('W4FX')} export spares`, quantity: '1', unitPrice: '500.00', amount: '500.00' }],
      });
      const inv2 = await apiOk(page, 'GET', `/api/documents/${posted2.id}`);
      expect(docOf(inv2).fx_rate).toBe('1.2000000000');
      const periodId = str(docOf(inv2).posting_period_id, 'revaluation period');
      const carryingBase = toCents('600.00');
      const restatedBase = toCents('650.00');
      const unrealizedGain = toCents('50.00');
      expect(restatedBase - carryingBase).toBe(unrealizedGain);

      // First run posts the unrealized gain to the CONFIGURED account.
      const run1 = await apiOk(page, 'POST', '/api/close/run-revaluation', { periodId });
      const runs1 = run1.posted as Json[];
      expect(runs1.length).toBe(1);
      expect(toCents4(str((runs1[0] as Json).netDelta, 'net delta'))).toBe(unrealizedGain);
      const adjEntryId = str((runs1[0] as Json).entryId, 'adjustment entry');
      const reversalEntryId = str((runs1[0] as Json).reversalEntryId, 'reversal entry');
      const adj = await apiOk(page, 'GET', `/api/reports/entry/${adjEntryId}`);
      const adjLines = adj.lines as Json[];
      const offset = adjLines.find((l) => String((l as Json).account_id) === seed.fxUnrealizedId);
      expect(offset, 'unrealized line on the configured account').toBeTruthy();
      expect(String((offset as Json).account_number)).toBe(seed.fxUnrealizedNumber);
      // A gain on the asset is a debit to AR offset by a credit to the
      // unrealized account.
      expect(toCentsAny(String((offset as Json).amount))).toBe(-unrealizedGain);

      // Second run posts nothing: revaluation is idempotent within a period.
      const run2 = await apiOk(page, 'POST', '/api/close/run-revaluation', { periodId });
      expect((run2.posted as Json[]).length).toBe(0);
      const skipped = run2.skipped as Json[];
      expect(skipped.length).toBe(1);
      expect(String((skipped[0] as Json).reason)).toBe('no revaluation needed');

      // The mandatory next-period mirror reverses the adjustment in full, so
      // the exposure is re-measured from historical each close.
      const reversal = await apiOk(page, 'GET', `/api/reports/entry/${reversalEntryId}`);
      const revEntry = reversal.entry as Json;
      expect(String(revEntry.reverses_number ?? '')).toBeTruthy();
      const revLines = reversal.lines as Json[];
      const revOffset = revLines.find((l) => String((l as Json).account_id) === seed.fxUnrealizedId);
      expect(revOffset, 'reversal line on the configured account').toBeTruthy();
      expect(toCentsAny(String((revOffset as Json).amount))).toBe(unrealizedGain);
      const adjAr = adjLines.find((l) => String((l as Json).account_id) !== seed.fxUnrealizedId);
      const revAr = revLines.find((l) => String((l as Json).account_id) !== seed.fxUnrealizedId);
      expect(toCentsAny(String((adjAr as Json).amount)) + toCentsAny(String((revAr as Json).amount))).toBe(0n);

      // The user can see it: the trial balance carries the USD 50.00
      // unrealized gain on the configured account for the revalued month.
      const period = `period=custom&from=${monthStart(m2)}&to=${monthEnd(m2)}`;
      await page.goto(`/reports/trial-balance?${period}`);
      const rows = await reportRows(page);
      const unrealRow = findRow(rows, `${tag('W4FX')} FX Unrealized`);
      expect(unrealRow).toContain(fmtUSD(-unrealizedGain));
    } finally {
      await context.close();
    }
  });

  test('company-currency and transaction-currency figures agree and say which they are', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const seed = await seedFx(page);
      if (!seed.invoiceId) {
        // Standalone run (the realized test did not post in this process):
        // raise this attempt's own settled invoice through the API so the
        // report below still compares both denominations.
        const dd = await apiOk(page, 'POST', '/api/documents/draft', { kind: 'customer_invoice' });
        seed.invoiceId = str(dd.id, 'invoice id');
        const dg = await apiOk(page, 'GET', `/api/documents/${seed.invoiceId}`);
        const fill = await api(page, 'PATCH', `/api/documents/${seed.invoiceId}`, {
          expectedUpdatedAt: str(docOf(dg).updated_at, 'invoice revision'),
          partyId: seed.eurCustomerId, currency: seed.fx,
          documentDate: isoDate(seed.m1, 5), dueDate: isoDate(seed.m1, 19),
          lines: [{ accountId: seed.incomeId, description: `${tag('W4FX')} export widgets`, quantity: '1', unitPrice: '1000.00', amount: '1000.00' }],
        });
        expect(fill.status).toBe(200);
        seed.invoiceNumber = str(docOf(fill.body).document_number, 'invoice number');
        await apiOk(page, 'POST', '/api/documents/actions', { action: 'submit', documentId: seed.invoiceId });
        await apiOk(page, 'POST', '/api/documents/actions', { action: 'post', documentId: seed.invoiceId });
      }

      // The product's own report route over ledger lines, asking for both
      // denominations side by side: base amount with its functional currency
      // label, txn amount with its transaction currency label.
      const report = await apiOk(page, 'POST', '/api/reports/run', {
        query: {
          entity: 'ledger_lines', mode: 'rows',
          columns: ['posting_date', 'entry_number', 'account_number', 'account_name', 'amount', 'base_currency', 'txn_amount', 'currency', 'party_name'],
          filters: {
            combinator: 'and',
            rules: [
              { field: 'entry_status', op: 'eq', value: 'posted' },
              { field: 'account_number', op: 'eq', value: seed.incomeNumber },
            ],
          },
          limit: 50,
        },
      });
      const groups = (report.result as Json).groups as Json[];
      expect(groups.length).toBe(1);
      const columns = (groups[0] as Json).columns as string[];
      expect(columns).toContain('Amount (base)');
      expect(columns).toContain('Functional currency');
      expect(columns).toContain('Amount (txn)');
      expect(columns).toContain('Currency');
      const baseIdx = columns.indexOf('Amount (base)');
      const baseCurIdx = columns.indexOf('Functional currency');
      const txnIdx = columns.indexOf('Amount (txn)');
      const curIdx = columns.indexOf('Currency');
      const rows = (groups[0] as Json).rows as string[][];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        // Every row names both currencies, and base == txn x 1.10/1.20: the
        // two denominations never silently mix.
        expect(row[baseCurIdx]).toBe('USD');
        expect(row[curIdx]).toBe(seed.fx);
        const base = toCentsAny(row[baseIdx]!);
        const txn = toCentsAny(row[txnIdx]!);
        expect(row[baseIdx]).not.toBe(row[txnIdx]);
        const rate10 = txn * 110n === base * 100n;
        const rate12 = txn * 120n === base * 100n;
        expect(rate10 || rate12, `row ${row.join('|')} converts at a seeded spot`).toBe(true);
      }

      // And on screen: the invoice drawer states the transaction currency and
      // total, while the trial balance states the company-currency movement.
      const drawer = await openDrawer(page, `/ar/invoices?doc=${seed.invoiceId}`);
      await expect(drawer.getByText(seed.fx).first()).toBeVisible();
      await expect(drawer.getByText('1,000.00').first()).toBeVisible();
      const period = `period=custom&from=${monthStart(seed.m1)}&to=${monthEnd(seed.m1)}`;
      await page.goto(`/reports/trial-balance?${period}`);
      const tbRows = await reportRows(page);
      expect(findRow(tbRows, seed.incomeNumber)).toContain(fmtUSD(-toCents('1100.00')));
    } finally {
      await context.close();
    }
  });

interface TaxSeed {
  deSalesId: string;
  auSalesId: string;
  dePurchId: string;
  incomeId: string;
  expenseId: string;
  deCustomerId: string;
  auCustomerId: string;
  deVendorId: string;
  mA: number;
  mC: number;
  changeFrom: string;
  docs: { id: string; kind: string }[];
}

const taxSeedCache = new Map<string, TaxSeed>();

/**
 * Seed the tax side for THIS attempt: tenant tax codes in two jurisdictions
 * with effective-dated rates, parties, and the country return packs installed
 * (then reset when new codes arrive, since mapping happens at install time).
 */
async function seedTax(page: Page): Promise<TaxSeed> {
  const t = tag('W4T');
  const cached = taxSeedCache.get(t);
  if (cached) return cached;
  const rc = runCode();
  const mA = mm(3);
  const mC = mm(6);
  // The rate change travels with the retry so the before/after months always
  // straddle it, whatever the attempt index.
  const changeFrom = monthStart(mm(5));
  const changeDay = new Date(`${changeFrom}T00:00:00Z`);
  const rateATo = new Date(changeDay.getTime() - 86_400_000).toISOString().slice(0, 10);

  async function code(code: string, name: string, country: string, appliesTo: string): Promise<string> {
    const res = await api(page, 'POST', '/api/admin/setup/tax-codes', {
      code, name, country, appliesTo, calculationType: 'standard', isActive: true,
    });
    expect(res.status, `tax code ${code}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    return str(res.body.id, `${code} id`);
  }
  async function rate(taxCodeId: string, ratePercent: string, effectiveFrom: string, effectiveTo?: string): Promise<void> {
    const res = await api(page, 'POST', '/api/admin/setup/tax-rates', {
      taxCodeId, ratePercent, effectiveFrom, ...(effectiveTo ? { effectiveTo } : {}),
    });
    expect(res.status, `tax rate ${ratePercent}%: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  }

  const deSalesId = await code(`${t}-DE-S`, `${t} DE output VAT test schedule`, 'DE', 'sales');
  await rate(deSalesId, '10', '2026-01-01', rateATo);
  await rate(deSalesId, '12', changeFrom);
  const auSalesId = await code(`${t}-AU-S`, `${t} AU GST 10%`, 'AU', 'sales');
  await rate(auSalesId, '10', '2026-01-01');
  const dePurchId = await code(`${t}-DE-P`, `${t} DE input VAT 19%`, 'DE', 'purchases');
  await rate(dePurchId, '19', '2026-01-01');

  const incomeId = await createAccount(page, `${t} Taxable Revenue`, 'income', `4497${rc}`);
  const expenseId = await createAccount(page, `${t} Taxable Expense`, 'expense', `6196${rc}`);
  const deCustomerId = await createParty(page, 'customer', `${t} DE Customer`);
  const auCustomerId = await createParty(page, 'customer', `${t} AU Customer`);
  const deVendorId = await createParty(page, 'vendor', `${t} DE Vendor`);

  // Packs map the tenant codes present at install time, by declared country.
  // Install once; reset whenever this attempt minted new codes so they map.
  const packs = ['DE_USTVA', 'AU_BAS_GST'];
  const installed = await apiOk(page, 'POST', '/api/tax/returns', { mode: 'install', packs });
  const skipped = ((installed.skipped as string[] | undefined) ?? []).filter((c) => packs.includes(c));
  if (skipped.length > 0) {
    const reset = await api(page, 'POST', '/api/tax/returns', { mode: 'reset', packs: skipped });
    expect(reset.status, `pack reset: ${JSON.stringify(reset.body).slice(0, 300)}`).toBe(200);
  }

  const seed: TaxSeed = {
    deSalesId, auSalesId, dePurchId, incomeId, expenseId,
    deCustomerId, auCustomerId, deVendorId, mA, mC, changeFrom, docs: [],
  };
  taxSeedCache.set(t, seed);
  return seed;
}

/** Sum posted tax_totals of known docs whose document date falls in [from, to]. */
async function windowTax(page: Page, seed: TaxSeed, from: string, to: string, codeId: string): Promise<bigint> {
  let total = 0n;
  for (const doc of seed.docs) {
    const got = await apiOk(page, 'GET', `/api/documents/${doc.id}`);
    const d = docOf(got);
    const date = str(d.document_date, 'doc date');
    if (date < from || date > to) continue;
    const lines = (got.lines as Json[] | undefined) ?? [];
    if (!lines.some((l) => String((l as Json).tax_code_id) === codeId)) continue;
    total += toCents4(str(d.tax_total, 'doc tax'));
  }
  return total;
}

  test('tax follows the rate on the transaction date, not today\'s rate', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const seed = await seedTax(page);
      const t = tag('W4T');

      // Before the change: 1,000.00 at 10% -> 100.00.
      const before = await postDocument(page, 'customer_invoice', {
        partyId: seed.deCustomerId, currency: 'USD',
        documentDate: isoDate(seed.mA, 15), dueDate: isoDate(seed.mA, 29),
        lines: [{ accountId: seed.incomeId, description: `${t} services before change`, quantity: '1', unitPrice: '1000.00', amount: '1000.00', taxCodeId: seed.deSalesId }],
      });
      seed.docs.push({ id: before.id, kind: 'customer_invoice' });
      const beforeDoc = docOf(await apiOk(page, 'GET', `/api/documents/${before.id}`));
      expect(beforeDoc.tax_total).toBe('100.0000');
      expect(beforeDoc.total).toBe('1100.0000');

      // After the change: 2,000.00 at 12% -> 240.00.
      const after = await postDocument(page, 'customer_invoice', {
        partyId: seed.deCustomerId, currency: 'USD',
        documentDate: isoDate(seed.mC, 10), dueDate: isoDate(seed.mC, 24),
        lines: [{ accountId: seed.incomeId, description: `${t} services after change`, quantity: '1', unitPrice: '2000.00', amount: '2000.00', taxCodeId: seed.deSalesId }],
      });
      seed.docs.push({ id: after.id, kind: 'customer_invoice' });
      const afterDoc = docOf(await apiOk(page, 'GET', `/api/documents/${after.id}`));
      expect(afterDoc.tax_total).toBe('240.0000');
      expect(afterDoc.total).toBe('2240.0000');

      // The rate change did not rewrite history: the earlier invoice still
      // reads the 10% it posted at.
      const reread = docOf(await apiOk(page, 'GET', `/api/documents/${before.id}`));
      expect(reread.tax_total).toBe('100.0000');

      // The user can see it: the later invoice drawer shows the 12% tax.
      const drawer = await openDrawer(page, `/ar/invoices?doc=${after.id}`);
      await expect(drawer.getByText('240.00').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('two jurisdictions report their own returns, reconciled to the subledger', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const seed = await seedTax(page);
      const t = tag('W4T');
      const from = monthStart(seed.mC);
      const to = monthEnd(seed.mC);

      // This attempt's own documents in the filing window: an AU sale and a
      // DE purchase to sit beside the DE sale from the previous test.
      const au = await postDocument(page, 'customer_invoice', {
        partyId: seed.auCustomerId, currency: 'USD',
        documentDate: isoDate(seed.mC, 12), dueDate: isoDate(seed.mC, 26),
        lines: [{ accountId: seed.incomeId, description: `${t} AU services`, quantity: '1', unitPrice: '1000.00', amount: '1000.00', taxCodeId: seed.auSalesId }],
      });
      seed.docs.push({ id: au.id, kind: 'customer_invoice' });
      expect(docOf(await apiOk(page, 'GET', `/api/documents/${au.id}`)).tax_total).toBe('100.0000');
      const bill = await postDocument(page, 'vendor_bill', {
        partyId: seed.deVendorId, currency: 'USD',
        documentDate: isoDate(seed.mC, 15), dueDate: isoDate(seed.mC, 29),
        lines: [{ accountId: seed.expenseId, description: `${t} DE supplies`, quantity: '1', unitPrice: '500.00', amount: '500.00', taxCodeId: seed.dePurchId }],
      });
      seed.docs.push({ id: bill.id, kind: 'vendor_bill' });
      expect(docOf(await apiOk(page, 'GET', `/api/documents/${bill.id}`)).tax_total).toBe('95.0000');

      // Expected figures, summed live from the documents in this window: no
      // hardcoded totals, and leftovers from other attempts live in other
      // months so they can never leak in.
      const deOut = await windowTax(page, seed, from, to, seed.deSalesId);
      const deIn = await windowTax(page, seed, from, to, seed.dePurchId);
      const auOut = await windowTax(page, seed, from, to, seed.auSalesId);
      // Non-vacuous in every retry combination: this window always holds this
      // attempt's AU sale and DE purchase (the DE sale joins it whenever the
      // previous test ran in the same months).
      expect(deOut + deIn + auOut > 0n).toBe(true);

      // Each return sums only its own jurisdiction's codes, compared against
      // the live document sums — never hardcoded: the DE workpaper excludes
      // the AU tax and vice versa, whatever this window holds.
      const fmt4 = (cents: bigint): string => {
        const neg = cents < 0n;
        const abs = neg ? -cents : cents;
        return `${neg ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}00`;
      };
      const de = await apiOk(page, 'GET', `/api/tax/returns/DE_USTVA?from=${from}&to=${to}`);
      expect(de.functionalCurrency).toBe('USD');
      const deBoxes = de.boxes as Json[];
      const box = (code: string): string => str((deBoxes.find((b) => String((b as Json).lineCode) === code) as Json).value, `DE box ${code}`);
      expect(box('OB_OUTPUT')).toBe(fmt4(deOut));
      expect(box('OB_INPUT')).toBe(fmt4(deIn));
      const auRet = await apiOk(page, 'GET', `/api/tax/returns/AU_BAS_GST?from=${from}&to=${to}`);
      expect(auRet.functionalCurrency).toBe('USD');
      const auBoxes = auRet.boxes as Json[];
      const auBox = (code: string): string => str((auBoxes.find((b) => String((b as Json).lineCode) === code) as Json).value, `AU box ${code}`);
      expect(auBox('1A')).toBe(fmt4(auOut));
      expect(auBox('1B')).toBe('0.0000');

      // The return figures reconcile to the transaction-lines subledger for
      // the same window: every unit of box tax is a posted line somewhere.
      const sub = await apiOk(page, 'POST', '/api/reports/run', {
        query: {
          entity: 'transaction_lines', mode: 'rows',
          columns: ['document_number', 'document_date', 'party_name', 'amount', 'tax_amount', 'currency'],
          filters: {
            combinator: 'and',
            rules: [
              { field: 'status', op: 'eq', value: 'posted' },
              { field: 'document_date', op: 'gte', value: from },
              { field: 'document_date', op: 'lte', value: to },
            ],
          },
          limit: 100,
        },
      });
      const subGroups = (sub.result as Json).groups as Json[];
      const subCols = (subGroups[0] as Json).columns as string[];
      const taxIdx = subCols.indexOf('Tax amount');
      const numIdx = subCols.indexOf('Document #');
      expect(taxIdx).toBeGreaterThanOrEqual(0);
      let subTotal = 0n;
      const subNumbers = new Set<string>();
      for (const row of (subGroups[0] as Json).rows as string[][]) {
        // Boxes print unsigned, so compare unsigned: strip any sign style.
        const v = row[taxIdx]!;
        const unsigned = v.startsWith('(') && v.endsWith(')') ? v.slice(1, -1) : v.startsWith('-') ? v.slice(1) : v;
        if (unsigned !== '' && unsigned !== '0' && unsigned !== '0.00') subTotal += toCentsAny(unsigned);
        subNumbers.add(row[numIdx]!);
      }
      expect(subTotal).toBe(deOut + deIn + auOut);
      // The subledger names the very invoices behind the boxes.
      const invNumbers = new Set<string>();
      for (const doc of seed.docs) {
        const got = await apiOk(page, 'GET', `/api/documents/${doc.id}`);
        const date = str(docOf(got).document_date, 'doc date');
        if (date >= from && date <= to) invNumbers.add(str(docOf(got).document_number, 'doc number'));
      }
      for (const n of invNumbers) expect(subNumbers.has(n), `subledger contains ${n}`).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('the filing month closes, both returns file, and the filed figures trace to the invoice', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const seed = await seedTax(page);
      const from = monthStart(seed.mC);
      const to = monthEnd(seed.mC);

      // This test's own DE sale in the filing window, so the window is never
      // empty even on a standalone run; the live window sums below count it
      // alongside whatever the previous tests posted.
      const own = await postDocument(page, 'customer_invoice', {
        partyId: seed.deCustomerId, currency: 'USD',
        documentDate: isoDate(seed.mC, 18), dueDate: isoDate(seed.mC, 28),
        lines: [{ accountId: seed.incomeId, description: `${tag('W4T')} filing-window sale`, quantity: '1', unitPrice: '500.00', amount: '500.00', taxCodeId: seed.deSalesId }],
      });
      seed.docs.push({ id: own.id, kind: 'customer_invoice' });
      expect(docOf(await apiOk(page, 'GET', `/api/documents/${own.id}`)).tax_total).toBe('60.0000');

      // Prepare both filings for this attempt's window (allowed on the open
      // month; the one-way transition to filed comes after the close).
      const prepDe = await apiOk(page, 'POST', '/api/tax/filings', { code: 'DE_USTVA', from, to });
      const prepAu = await apiOk(page, 'POST', '/api/tax/filings', { code: 'AU_BAS_GST', from, to });
      const filingDeId = str(prepDe.id, 'DE filing id');
      const filingAuId = str(prepAu.id, 'AU filing id');

      // Start the close the way an operator does: the period list's Start
      // close button for the filing month.
      const periodName = `${YEAR}-${String(seed.mC).padStart(2, '0')}`;
      await page.goto(`/close?fy=${YEAR}`);
      await dismissSetupWizard(page);
      // A single-book org renders no per-row book picker (the picker appears
      // only with 2+ books); the operator just starts the primary-book close.
      const row = page.locator('tr', { hasText: periodName }).first();
      await expect(row).toBeVisible({ timeout: 30000 });
      const resume = row.getByRole('link', { name: 'Resume' });
      let runId: string;
      if (await resume.isVisible()) {
        runId = new URL(str(await resume.getAttribute('href'), 'resume href'), page.url()).searchParams.get('run') ?? '';
      } else {
        const started = page.waitForURL(/\/close\?run=[0-9a-f-]+/);
        await row.getByRole('button', { name: 'Start close' }).click();
        await started;
        runId = new URL(page.url()).searchParams.get('run') ?? '';
      }
      expect(runId, 'close run started').toBeTruthy();

      // The filing month has no foreign exposure (all tax documents are USD),
      // so the close's revaluation is a measured no-op; run it through the
      // wizard's own button, then the manual financial review to completion.
      // The close monitors the bank: a reconcilable account with activity and
      // no signed-off reconciliation through period end blocks attestation.
      // Import the March receipt as a statement, match it, and sign off
      // through the filing month — the product's real bank path, as the
      // close-to-reporting suite does.
      const fxSeed = await seedFx(page);
      const reconCsv = ['date,description,amount', `${isoDate(fxSeed.m1, 12)},Customer receipt,1250.00`].join('\n');
      const imported = await apiOk(page, 'POST', '/api/banking/import', {
        source: 'csv', mode: 'import', text: reconCsv, accountId: fxSeed.bankId,
        statementDate: to, openingBalance: '0.00', closingBalance: '1250.00',
        mapping: { date: 0, description: 1, amount: 2 },
      });
      expect(imported.imported).toBe(1);
      const recon = await apiOk(page, 'POST', '/api/banking/reconciliations', {
        accountId: fxSeed.bankId, throughDate: to, statementBalance: '1250.00',
      });
      const reconId = str(recon.id, 'reconciliation id');
      const matched = await apiOk(page, 'POST', `/api/banking/reconciliations/${reconId}/auto-match`, {});
      expect(str(((matched.totals as Json).difference as string) ?? '', 'recon difference')).toBe('0.0000');
      await apiOk(page, 'POST', `/api/banking/reconciliations/${reconId}/sign-off`, {});

      await page.goto(`/close?run=${runId}&stage=execute`);
      await dismissSetupWizard(page);
      // Wait for the task list itself (dev compiles slowly on first hit);
      // then revalue only if the computed task still asks for it.
      await expect(page.getByText('General ledger').first()).toBeVisible({ timeout: 60000 });
      const revalButton = page.getByRole('button', { name: 'Run FX revaluation', exact: true });
      if (await revalButton.isVisible({ timeout: 30000 }).catch(() => false)) {
        const revalued = page.waitForResponse(
          (r) => r.url().endsWith('/api/close/run-revaluation') && r.request().method() === 'POST',
        );
        await revalButton.click();
        const res = await revalued;
        expect(res.status(), await res.text()).toBe(200);
      }
      // Revalidate so the computed tasks (bank, FX) re-read the fresh
      // reconciliation and revaluation before attestation — the same route
      // the readiness stage's Revalidate button calls.
      const refreshed = await apiOk(page, 'POST', `/api/close/runs/${runId}`, { action: 'refresh' });
      expect((refreshed as Json).ok).toBe(true);
      // The manual financial review lives on the Review stage and is the only
      // task offering Start/Complete there, so page-level buttons are
      // unambiguous (Q2C pattern).
      await page.goto(`/close?run=${runId}&stage=review`);
      await dismissSetupWizard(page);
      await expect(page.getByText('Review the financial statements').first()).toBeVisible({ timeout: 30000 });
      {
        const started = page.waitForResponse(
          (r) => r.url().includes(`/api/close/runs/${runId}/tasks/`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        const res = await started;
        expect(res.status(), await res.text()).toBe(200);
      }
      {
        const completed = page.waitForResponse(
          (r) => r.url().includes(`/api/close/runs/${runId}/tasks/`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Complete', exact: true }).click();
        const res = await completed;
        expect(res.status(), await res.text()).toBe(200);
      }

      // Marking filed refuses the open period — the refusal is the proof the
      // close below is what certifies the filing.
      const openRefusal = await api(page, 'PATCH', `/api/tax/filings/${filingDeId}`, { filingReference: `${tag('W4T')}-EARLY` });
      expect(openRefusal.status).toBe(409);
      expect(JSON.stringify(openRefusal.body)).toContain('period-not-closed');

      // Owner attestation (with the mandated 10+ character statement) and
      // the period lock live on the Lock stage, both through the UI. The lock
      // confirms via window.confirm, which Playwright must accept or nothing
      // happens.
      await page.goto(`/close?run=${runId}&stage=lock`);
      await dismissSetupWizard(page);
      page.on('dialog', (dialog) => void dialog.accept());
      // Scoped to main: Next.js holds the RSC flight payload for the last
      // refresh in a hidden div outside main, and its parsed copy of this
      // same textarea transiently double-matches a page-level id selector
      // (proven in a trace: two #close-owner-attestation nodes, one under
      // main, one in div#S:0[hidden], settling to one). The operator box is
      // the one in main; asserting exactly one there keeps the gate honest —
      // a product double-render in main still fails loudly.
      const attestation = page.locator('main #close-owner-attestation');
      await expect(attestation).toHaveCount(1);
      await attestation.fill('W4 e2e: June figures reviewed, FX revalued, ready to lock.');
      {
        const attested = page.waitForResponse(
          (r) => r.url().endsWith(`/api/close/runs/${runId}`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Attest and approve close', exact: true }).click();
        const res = await attested;
        expect(res.status(), await res.text()).toBe(200);
      }
      {
        const locked = page.waitForResponse(
          (r) => r.url().endsWith(`/api/close/runs/${runId}`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Lock period', exact: true }).click();
        const res = await locked;
        expect(res.status(), await res.text()).toBe(200);
      }
      await expect(page.getByText(/Period locked by/).first()).toBeVisible({ timeout: 30000 });

      // File both returns with government references; the snapshot figures
      // are frozen at prepare time, so they still equal the live window sums.
      const filedDe = await apiOk(page, 'PATCH', `/api/tax/filings/${filingDeId}`, { filingReference: `${tag('W4T')}-DE-${periodName}` });
      expect(str(filedDe.filed_at, 'DE filed at').length).toBeGreaterThan(0);
      const filedAu = await apiOk(page, 'PATCH', `/api/tax/filings/${filingAuId}`, { filingReference: `${tag('W4T')}-AU-${periodName}` });
      expect(str(filedAu.filed_at, 'AU filed at').length).toBeGreaterThan(0);
      // Filing twice is refused: the prepared -> filed transition is one-way.
      const again = await api(page, 'PATCH', `/api/tax/filings/${filingDeId}`, { filingReference: 'DUPLICATE' });
      expect(again.status).toBe(409);

      // The user can see it: the tax history lists both filed filings with
      // their government references, and opening the DE filing shows the
      // frozen workpaper figures.
      await page.goto('/tax?tab=history');
      await dismissSetupWizard(page);
      const deRow = page.locator('tr', { hasText: `${tag('W4T')}-DE-${periodName}` }).first();
      await expect(deRow).toBeVisible({ timeout: 30000 });
      await expect(page.locator('tr', { hasText: `${tag('W4T')}-AU-${periodName}` }).first()).toBeVisible();
      await deRow.getByRole('link').first().click();
      const filingDrawer = page.locator('[role="dialog"]').first();
      await expect(filingDrawer).toBeVisible();
      const deOut = await windowTax(page, seed, from, to, seed.deSalesId);
      const deIn = await windowTax(page, seed, from, to, seed.dePurchId);
      const fmt2 = (cents: bigint): string =>
        `${(cents / 100n).toString()}.${((cents < 0n ? -cents : cents) % 100n).toString().padStart(2, '0')}`;
      await expect(filingDrawer.getByText(fmt2(deOut)).first()).toBeVisible();
      await expect(filingDrawer.getByText(fmt2(deIn)).first()).toBeVisible();
      await page.keyboard.press('Escape');

      // Drill from the filed figure to the transaction behind it: every trial
      // balance value links to its account register; the register lists each
      // tax line with a transaction link; the entry flyout opens the source
      // invoice in its native drawer. The trial balance page is already warm
      // from the earlier tests, so this adds no new route compiles.
      const deJuneNumber = await (async (): Promise<string> => {
        for (const doc of seed.docs) {
          const got = await apiOk(page, 'GET', `/api/documents/${doc.id}`);
          const d = docOf(got);
          const date = str(d.document_date, 'doc date');
          const lines = (got.lines as Json[] | undefined) ?? [];
          if (date >= from && date <= to && lines.some((l) => String((l as Json).tax_code_id) === seed.deSalesId)) {
            return str(d.document_number, 'doc number');
          }
        }
        throw new Error('no DE sales document in the filing window');
      })();
      await page.goto(`/reports/trial-balance?period=custom&from=${from}&to=${to}`);
      await dismissSetupWizard(page);
      const taxRow = page.locator('tr', { hasText: 'Sales Tax Payable' }).first();
      await expect(taxRow).toBeVisible({ timeout: 30000 });
      await taxRow.getByRole('link').first().click();
      const register = page.locator('[role="dialog"]').first();
      await expect(register.getByText(deJuneNumber).first()).toBeVisible({ timeout: 30000 });
      // Source-document lines drill straight to the record's native drawer
      // (only system entries without a document use the read-only entry
      // flyout), so the invoice itself opens over the trial balance.
      await register.getByRole('link', { name: deJuneNumber }).first().click();
      const invDrawer = page.locator('[role="dialog"]', { hasText: deJuneNumber }).last();
      await expect(invDrawer.getByText(deJuneNumber).first()).toBeVisible({ timeout: 30000 });
    } finally {
      await context.close();
    }
  });
});
