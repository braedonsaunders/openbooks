import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { authedContext, dismissSetupWizard } from '../auth';
import { withIdempotencyKey } from "./idempotency";

/**
 * Bank-to-books end-to-end workflow: bank feed through reconciliation through
 * cash application.
 *
 * Against a scratch tenant (own database, own app server — never the shared
 * cluster): seed a deterministic June-2026 story through the REAL product
 * HTTP routes (the same calls the drawers make), then drive every workflow
 * STATE on real rendered pages and assert on MONEY and on what the user can
 * see — never on bare HTTP 200.
 *
 * The story: three AR invoices go out; one receipt settles two of them in
 * full while a second receipt partially pays the third; a counter deposit
 * arrives on a slip; a CSV statement covering the month is imported; a
 * categorization rule sweeps the bank fee, auto-match pairs the receipts,
 * the deposit is matched by hand; the same line refuses a second match; a
 * matched-then-unmatched line returns cleanly; the session is signed off;
 * the reconciled balance ties to the GL; voiding a reconciled line is
 * refused in words; and the period-close bank gate — shown biting BEFORE
 * sign-off — clears after it.
 *
 * Money (all exact decimal strings, bigint minor-unit math in-test):
 *   INV-1 1,200.00 + INV-2 800.00, both due 2026-06-20, settled in full by
 *   RCPT-1 2,000.00 on 2026-06-12 (one payment, two invoices).
 *   INV-3 500.00, partially paid by RCPT-2 200.00 booked 2026-06-14 and
 *   clearing the bank 2026-06-18 (4 days apart: a medium-confidence
 *   auto-match, so the review queue is genuinely exercised), leaving
 *   exactly 300.00 open.
 *   DEP 350.00 counter deposit on 2026-06-20 (Dr bank / Cr revenue).
 *   BANK FEE 18.50 on 2026-06-25, swept by rule (Dr fees / Cr bank).
 *   Statement 2026-06-30 closes at 2,531.50 = 2000+200+350-18.50.
 *
 * Cash application and the deposit post through their real UI drawers;
 * matching, rules, sign-off, void refusal, and close readiness all happen
 * on real pages. Invoice/rule/statement/reconciliation creation is seeding
 * through the product routes (quote-to-cash seeds receipts the same way).
 *
 * Determinism: fixed June-2026 dates; tag()/runCode() keep names and
 * account numbers collision-free across local re-runs against a dirty dev
 * database (set E2E_RUN=7, like quote-to-cash) — but the close-gate tests
 * need a pristine org, so reset the scratch database between local runs.
 * CI clones openbooks_e2e_bank for this file and never retries it
 * (retries: 0, below).
 */

const RUN = process.env.E2E_RUN ?? '';

/** Per-attempt prefix: retries re-seed, so names/numbers move with the retry. */
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

/** Minor-unit money: '1200.00' -> 120000n. Accepts the engine's 4-decimal form too. */
function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})(\d{1,2})?$/.exec(amount);
  if (!m || (m[4] !== undefined && !/^0+$/.test(m[4] as string))) throw new Error(`bad money literal ${amount}`);
  const sign = m[1] === '-' ? -1n : 1n;
  return sign * (BigInt(m[2] as string) * 100n + BigInt(m[3] as string));
}

function grouped(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** UI money cell in USD: 253150n -> '$2,531.50'. */
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
    { method, path, data: body, extra: withIdempotencyKey(method, headers) },
  );
  return result as ApiResult;
}

async function apiOk(page: Page, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await api(page, method, path, body);
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

/** First-run org setup through the product's setup-wizard API (USD base). */
async function setupOrg(page: Page): Promise<void> {
  const res = await api(page, 'PUT', '/api/admin/setup/wizard', {
    name: 'B2B E2E Co',
    country: 'US',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    industry: 'general_business',
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
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}

/** Open a drawer fresh (settled state) for UI interaction. */
async function openDrawer(page: Page, drawerUrl: string) {
  await page.goto(drawerUrl);
  await dismissSetupWizard(page);
  const drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible();
  return drawer;
}

/**
 * Seed a receipt header (party, bank, date) through the product route;
 * the ALLOCATION happens below in the UI (Auto-apply). Seeding allocations
 * through the API and posting them unseen would skip the very control —
 * the operator applying cash to the right lines — this workflow exists to
 * prove, and draft allocations do not reliably survive the drawer's mount
 * in dev mode (the party effect refires and clears them).
 */
async function seedReceiptHeader(page: Page, documentDate: string): Promise<{ payId: string; number: string }> {
  const pd = await apiOk(page, 'POST', '/api/payments/draft', { kind: 'customer_payment' });
  const payId = str(pd.id, 'payment id');
  const pg = await apiOk(page, 'GET', `/api/payments/${payId}`);
  const pp = await api(page, 'PATCH', `/api/payments/${payId}`, {
    partyId: S.customerId, bankAccountId: S.bankId, documentDate,
    expectedUpdatedAt: str(docOf(pg).updated_at, 'payment revision'),
  });
  expect(pp.status, JSON.stringify(pp.body).slice(0, 300)).toBe(200);
  return { payId, number: str(docOf(pp.body).document_number, 'receipt number') };
}

/**
 * Apply cash to open invoices through the receipt drawer UI exactly as an
 * operator does: Edit, type the received amount, Auto-apply (FIFO
 * suggestion), Save, then Receive & post. Asserts the applying summary —
 * item count and total — before anything posts.
 */
async function uiApplyAndPost(page: Page, payId: string, amount: string, expectedItems: number, expectedTotal: string): Promise<void> {
  await openDrawer(page, `/receipts?payment=${payId}`);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole('button', { name: 'Edit', exact: true }).click();
  await drawer.getByPlaceholder('Amount received').fill(amount);
  {
    const suggested = page.waitForResponse(
      (r) => r.url().includes('/api/payments/suggest') && r.request().method() === 'POST',
    );
    await drawer.getByRole('button', { name: 'Auto-apply', exact: true }).click();
    const res = await suggested;
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as Json).allocations, 'suggested allocations').toHaveLength(expectedItems);
  }
  await expect(drawer.getByText(`Applying ${expectedItems} item`).first()).toBeVisible();
  await expect(drawer.getByText(`Total ${expectedTotal}`).first()).toBeVisible();
  // Save lives inside the Actions menu (TransactionDrawer shell), not
  // beside it: open the menu, save the applied lines, reopen for posting.
  await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
  {
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/payments/${payId}`) && r.request().method() === 'PATCH',
    );
    await page.locator('button', { hasText: /^Save$/ }).click();
    const saveRes = await saved;
    expect(saveRes.status(), await saveRes.text()).toBe(200);
  }
  // Posting races the post-save refresh round-trip two ways: the open menu
  // can detach mid-click, and the drawer can still carry the pre-save
  // revision (the route 409s a stale drawer). Retry the UI post: a 409 waits
  // for the refresh flight and tries again; anything already posted stops.
  await expect(drawer.getByRole('button', { name: 'Edit', exact: true })).toBeVisible({ timeout: 20000 });
  for (let attempt = 0; ; attempt++) {
    await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
    const postButton = page.locator('button', { hasText: 'Receive & post' });
    await expect(postButton).toBeEnabled({ timeout: 15000 });
    const posted = page
      .waitForResponse(
        (r) => r.url().endsWith('/api/payments/post-with-applications') && r.request().method() === 'POST',
        { timeout: 25000 },
      )
      .catch(() => null);
    await postButton.click({ timeout: 8000 }).catch(() => null);
    const res = await posted;
    if (res && res.status() === 200) break;
    const st = await api(page, 'GET', `/api/payments/${payId}`);
    if (st.status === 200 && str(docOf(st.body).status, 'payment status') === 'posted') break;
    expect(attempt, 'post retries exhausted').toBeLessThan(2);
    // A stale-revision 409 means the save's refresh flight is still in the
    // air: let it land so the drawer re-renders with the new revision. A
    // detached menu that never dispatched needs no wait — just reopen it.
    if (res && res.status() === 409) {
      await page
        .waitForResponse(
          (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/receipts',
          { timeout: 30000 },
        )
        .catch(() => null);
    }
  }
}

/** Post a seeded banking document (deposit) through its drawer UI. */
async function uiPostBankingDoc(page: Page, docId: string, postedBadge: string): Promise<void> {
  await openDrawer(page, `/banking/transactions?doc=${docId}`);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
  const posted = page.waitForResponse(
    (r) => r.url().endsWith('/api/documents/actions') && r.request().method() === 'POST',
  );
  await page.locator('button', { hasText: /^Post$/ }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(200);
  await expect(drawer.getByText(postedBadge)).toBeVisible({ timeout: 15000 });
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

/**
 * The Difference stat box on the match workspace: the only element holding
 * both the 'Difference' label and a money value (ancestors hold it too, so
 * the deepest — last in document order — is the stat box itself).
 */
function diffStat(page: Page) {
  return page.locator('div').filter({ hasText: 'Difference' }).filter({ hasText: /\$/ }).last();
}

interface StorySeed {
  incomeId: string;
  feeId: string;
  bankId: string;
  bankName: string;
  customerId: string;
  customerName: string;
  rootSubId: string;
  invIds: string[];
  invNumbers: string[];
  receiptIds: string[];
  receiptNumbers: string[];
  depositId: string;
  depositNumber: string;
  depositLineId: string;
  depositJournalLineIds: string[];
  ruleId: string;
  recId: string;
  runId: string;
  preExceptions: number;
  preScore: number;
}

const S: StorySeed = {
  incomeId: '', feeId: '', bankId: '', bankName: '', customerId: '', customerName: '',
  rootSubId: '', invIds: [], invNumbers: [], receiptIds: [], receiptNumbers: [],
  depositId: '', depositNumber: '', depositLineId: '', depositJournalLineIds: [], ruleId: '', recId: '', runId: '',
  preExceptions: 0, preScore: 0,
};

// Exact story amounts (decimal strings; bigint math asserts every tie-out).
const INV1 = '1200.00';
const INV2 = '800.00';
const INV3 = '500.00';
const PAY1 = '2000.00';
const PAY2 = '200.00';
const OPEN3 = '300.00';
const DEPOSIT = '350.00';
const FEE = '18.50';
const CLOSE = '2531.50';

test.describe('bank to books: feed to reconciliation to cash application', () => {
  // No retries: this is a stateful saga, and retrying it mid-flight would
  // re-seed against residue the failed attempt left behind. The retry-aware
  // tag()/runCode() prefixes above keep every SCOPED assertion (money,
  // aging, match, tie-out) collision-free, but the close readiness gate is
  // org-wide by product design: a stale bank account from attempt 0 keeps
  // bank-unreconciled genuinely open, so no suffix can make attempt 1's
  // gate assertions pass. A failure aborts the file; recovery is a fresh
  // job (CI clones a pristine database per suite file).
  test.describe.configure({ mode: 'serial', timeout: 240_000, retries: 0 });

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

  test('seeds the story: invoices out, rule set, statement in, session open', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const t = tag('B2B');
      const rc = runCode();
      S.customerName = `${t} Customer`;
      S.bankName = `${t} Operating`;

      const inc = await api(page, 'POST', '/api/accounts',
        { name: `${t} Service Revenue`, type: 'income', number: `4495${rc}` },
        { 'Idempotency-Key': crypto.randomUUID() });
      expect(inc.status, JSON.stringify(inc.body).slice(0, 200)).toBe(201);
      S.incomeId = str((inc.body.account as Json).id, 'incomeId');
      const fee = await api(page, 'POST', '/api/accounts',
        { name: `${t} Bank Fees`, type: 'expense', number: `6595${rc}` },
        { 'Idempotency-Key': crypto.randomUUID() });
      expect(fee.status, JSON.stringify(fee.body).slice(0, 200)).toBe(201);
      S.feeId = str((fee.body.account as Json).id, 'feeId');
      const bank = await api(page, 'POST', '/api/accounts',
        { name: S.bankName, type: 'asset_bank', number: `1595${rc}`, reconcilable: true, currencyRestriction: 'USD' },
        { 'Idempotency-Key': crypto.randomUUID() });
      expect(bank.status, JSON.stringify(bank.body).slice(0, 200)).toBe(201);
      S.bankId = str((bank.body.account as Json).id, 'bankId');

      // Root subsidiary: what a fresh journal draft defaults to.
      const probe = await apiOk(page, 'POST', '/api/journals/draft', {});
      const probeId = str(probe.id, 'probe draft');
      const probeGet = await apiOk(page, 'GET', `/api/journals/${probeId}`);
      S.rootSubId = str((probeGet.doc as Json).subsidiary_id, 'root subsidiary');
      await apiOk(page, 'DELETE', `/api/journals/${probeId}`);

      const pd = await apiOk(page, 'POST', '/api/parties/draft', { role: 'customer' });
      S.customerId = str(pd.id, 'party id');
      const pg = await apiOk(page, 'GET', `/api/parties/${S.customerId}`);
      const pa = await api(page, 'PATCH', `/api/parties/${S.customerId}`, {
        displayName: S.customerName, isActive: true, changeReason: 'e2e bank-to-books customer',
        expectedUpdatedAt: str((pg.party as Json).updated_at, 'party revision'),
      });
      expect(pa.status, JSON.stringify(pa.body).slice(0, 200)).toBe(200);

      // Three invoices, posted through the product route (seeding; the UI
      // posts below are the receipts and the deposit).
      const dates = ['2026-06-02', '2026-06-03', '2026-06-04'];
      const amounts = [INV1, INV2, INV3];
      for (let i = 0; i < 3; i++) {
        const dd = await apiOk(page, 'POST', '/api/documents/draft', { kind: 'customer_invoice' });
        const invId = str(dd.id, 'invoice id');
        const dg = await apiOk(page, 'GET', `/api/documents/${invId}`);
        const pp = await api(page, 'PATCH', `/api/documents/${invId}`, {
          expectedUpdatedAt: str(docOf(dg).updated_at, 'invoice revision'),
          partyId: S.customerId, subsidiaryId: S.rootSubId,
          documentDate: dates[i], dueDate: '2026-06-20',
          lines: [{ accountId: S.incomeId, description: `${t} services`, quantity: '1', unitPrice: amounts[i], amount: amounts[i] }],
        });
        expect(pp.status, JSON.stringify(pp.body).slice(0, 300)).toBe(200);
        S.invIds.push(invId);
        S.invNumbers.push(str(docOf(pp.body).document_number, 'invoice number'));
        const post = await api(page, 'POST', '/api/documents/actions', { action: 'post', documentId: invId });
        expect(post.status, JSON.stringify(post.body).slice(0, 300)).toBe(200);
      }
      expect(toCents(INV1) + toCents(INV2)).toBe(toCents(PAY1));

      // The fee-sweep rule: auto-categorize the monthly bank fee to the fee
      // expense account (posts the journal AND matches it on apply).
      const rule = await api(page, 'POST', '/api/banking/rules', {
        name: `${t} bank fee sweep`,
        criteria: { version: 2, match: { combinator: 'and', rules: [{ field: 'description', op: 'contains', value: 'BANK FEE' }] } },
        outcome: { action: 'categorize', version: 2, mode: 'auto', lines: [{ accountId: S.feeId, portion: { kind: 'remainder' } }] },
      });
      expect(rule.status, JSON.stringify(rule.body).slice(0, 300)).toBe(200);
      S.ruleId = str(rule.body.id, 'rule id');

      // The statement covers June: both receipts, the counter deposit, the
      // fee. The deposit has no journal yet — it stays unmatched until the
      // back office enters the slip and matches it by hand.
      const csv = [
        'date,description,amount',
        '2026-06-12,Customer receipts batch,2000.00',
        '2026-06-18,Customer receipt partial,200.00',
        '2026-06-20,Counter deposit,350.00',
        '2026-06-25,BANK FEE MONTHLY,-18.50',
      ].join('\n');
      const imp = await apiOk(page, 'POST', '/api/banking/import', {
        accountId: S.bankId, source: 'csv', text: csv,
        mapping: { date: 0, description: 1, amount: 2 }, mode: 'import',
        statementDate: '2026-06-30', openingBalance: '0.00', closingBalance: CLOSE,
      });
      expect(imp.imported).toBe(4);

      const rec = await apiOk(page, 'POST', '/api/banking/reconciliations', {
        accountId: S.bankId, throughDate: '2026-06-30', statementBalance: CLOSE,
      });
      S.recId = str(rec.id, 'reconciliation id');

      // Sanity: the statement balance is the four legs, computed in-test.
      expect(toCents(PAY1) + toCents(PAY2) + toCents(DEPOSIT) - toCents(FEE)).toBe(toCents(CLOSE));
    } finally {
      await context.close();
    }
  });

  test('close readiness bites on the unreconciled bank account before sign-off', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      // Start the June close from the period list (Resume on a dirty re-run).
      await page.goto('/close?fy=2026');
      await dismissSetupWizard(page);
      const row = page.locator('tr', { hasText: '2026-06' }).first();
      await expect(row).toBeVisible();
      const resume = row.getByRole('link', { name: 'Resume' });
      if (await resume.isVisible()) {
        S.runId = new URL((await resume.getAttribute('href')) ?? '', baseURL).searchParams.get('run') ?? '';
      } else {
        const started = page.waitForURL(/\/close\?run=[0-9a-f-]+/);
        await row.getByRole('button', { name: 'Start close' }).click();
        await started;
        S.runId = new URL(page.url()).searchParams.get('run') ?? '';
      }
      expect(S.runId, 'run started').toBeTruthy();

      const refreshed = await apiOk(page, 'POST', `/api/close/runs/${S.runId}`, { action: 'refresh' });
      S.preExceptions = Number(refreshed.openExceptions);
      S.preScore = Number(refreshed.readinessScore);
      // The gate bites: a critical bank exception drags the score under 100.
      expect(S.preScore).toBeLessThan(100);

      // The UI shows the exception with a count of exactly 1 — this org has
      // a single active bank account, so the gate is evaluating this story,
      // not vacant.
      await page.goto(`/close?run=${S.runId}&stage=readiness`);
      await dismissSetupWizard(page);
      // The card holds the title and the message; the title row alone holds
      // only the title plus the severity badge, so filter on both texts.
      const bankRow = page.locator('div').filter({ hasText: 'Cash accounts need reconciliation' }).filter({ hasText: 'reconcilable account' }).last();
      await expect(bankRow).toBeVisible({ timeout: 30000 });
      await expect(bankRow).toContainText('1 reconcilable account');
    } finally {
      await context.close();
    }
  });

  test('one receipt settles two invoices, a second receipt partly pays the third', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      // The suggestion engine first, as a pure product-route assertion:
      // 2,000.00 must split across INV-1 (1,200) + INV-2 (800) FIFO.
      const sug1 = await apiOk(page, 'POST', '/api/payments/suggest', {
        partyId: S.customerId, amount: PAY1, side: 'ar', currency: 'USD',
      });
      const allocs1 = sug1.allocations as Json[];
      expect(allocs1.length, 'one payment pays two invoices').toBe(2);
      expect(toCents(String(allocs1[0]?.sourceTransactionAmount)) + toCents(String(allocs1[1]?.sourceTransactionAmount))).toBe(toCents(PAY1));
      // ...and 200.00 takes exactly one line of the 500.00 invoice.
      const sug2 = await apiOk(page, 'POST', '/api/payments/suggest', {
        partyId: S.customerId, amount: PAY2, side: 'ar', currency: 'USD',
      });
      const allocs2 = sug2.allocations as Json[];
      expect(allocs2.length, 'partial payment takes one line').toBe(1);
      expect(String(allocs2[0]?.sourceTransactionAmount)).toBe('200.0000');

      // The postings themselves go through the operators' hands: Edit,
      // Auto-apply, Save, Receive & post — the summary is asserted first.
      const r1 = await seedReceiptHeader(page, '2026-06-12');
      S.receiptIds.push(r1.payId);
      S.receiptNumbers.push(r1.number);
      await uiApplyAndPost(page, r1.payId, PAY1, 2, fmtUSD(toCents(PAY1)));

      // Booked 06-14 against a 06-18 bank clearing: the 4-day gap is a
      // medium-confidence pair, which is what lands in the review queue.
      const r2 = await seedReceiptHeader(page, '2026-06-14');
      S.receiptIds.push(r2.payId);
      S.receiptNumbers.push(r2.number);
      await uiApplyAndPost(page, r2.payId, PAY2, 1, fmtUSD(toCents(PAY2)));

      // The invoice list tells the truth: two balances closed exactly, the
      // third shows exactly the 300.00 remainder.
      await page.goto('/ar/invoices');
      await dismissSetupWizard(page);
      const row1 = page.locator('tr', { hasText: S.invNumbers[0] as string }).first();
      await expect(row1.getByText(fmtUSD(0n)).first()).toBeVisible();
      const row2 = page.locator('tr', { hasText: S.invNumbers[1] as string }).first();
      await expect(row2.getByText(fmtUSD(0n)).first()).toBeVisible();
      const row3 = page.locator('tr', { hasText: S.invNumbers[2] as string }).first();
      await expect(row3.getByText(fmtUSD(toCents(OPEN3))).first()).toBeVisible();
      expect(toCents(INV3) - toCents(PAY2)).toBe(toCents(OPEN3));

      // AR aging as of 06-30: the remainder sits 10 days past due (1-30).
      await page.goto('/reports/aging?period=custom&from=2026-06-01&to=2026-06-30&side=ar');
      await page.waitForTimeout(2000);
      const rows = await reportRows(page);
      const agingRow = findRow(rows, S.customerName);
      // Columns: Party | Current | 1-30 | 31-60 | 61-90 | 90+ | Total.
      expect(agingRow[2]).toBe(fmtUSD(toCents(OPEN3)));
      expect(agingRow[agingRow.length - 1]).toBe(fmtUSD(toCents(OPEN3)));

      // The customer record agrees: open 300.00 with the unpaid invoice.
      await page.goto('/ar');
      await dismissSetupWizard(page);
      await page.locator('tr', { hasText: S.customerName }).first().click();
      const drawer = page.locator('[role="dialog"]').first();
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText('$300').first()).toBeVisible({ timeout: 15000 });
      await expect(drawer.getByText(S.invNumbers[2] as string).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('rules sweep the fee while auto-match pairs the receipts', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      await page.goto(`/banking/match?account=${S.bankId}`);
      await dismissSetupWizard(page);

      // The rule posts the fee journal and matches it in one run.
      {
        const ran = page.waitForResponse(
          (r) => r.url().endsWith('/api/banking/rules/apply') && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Run rules', exact: true }).click();
        const res = await ran;
        expect(res.status(), await res.text()).toBe(200);
      }
      // Auto-match pairs the two receipt lines by exact amount + date: the
      // same-day pair is high confidence, the 4-day clearing gap medium.
      // The deposit line has no journal yet, so it must survive unmatched.
      {
        const matched = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${S.recId}/auto-match`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Auto-match', exact: true }).click();
        const res = await matched;
        expect(res.status(), await res.text()).toBe(200);
        const result = (await res.json()) as Json;
        expect(result.matched).toBe(2);
        expect(result.highConfidence).toBe(1);
        expect(result.mediumConfidence).toBe(1);
      }

      // Three lines matched, one to go: difference is exactly the deposit,
      // the match queue holds exactly the deposit line, and the review
      // queue holds exactly the medium-confidence pair.
      await expect(page.getByText('Counter deposit').first()).toBeVisible();
      await expect(diffStat(page)).toContainText(fmtUSD(toCents(DEPOSIT)));
      await expect(page.locator('tr').filter({ has: page.locator('input[type="radio"]') })).toHaveCount(1);
      await expect(page.getByRole('link', { name: /Review/ }).first()).toContainText('1');
    } finally {
      await context.close();
    }
  });

  test('the counter deposit posts and hand-matches to a zero difference', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const t = tag('B2B');
      // Seeded through the product route; POSTED through the real drawer.
      const dd = await apiOk(page, 'POST', '/api/documents/draft', { kind: 'deposit' });
      const depId = str(dd.id, 'deposit id');
      const dg = await apiOk(page, 'GET', `/api/documents/${depId}`);
      const dp = await api(page, 'PATCH', `/api/documents/${depId}`, {
        expectedUpdatedAt: str(docOf(dg).updated_at, 'deposit revision'),
        documentDate: '2026-06-20', referenceNumber: `${t}-SLIP-221`,
        custom: { controlAccountId: S.bankId },
        lines: [{ accountId: S.incomeId, description: 'counter cash sales', amount: DEPOSIT }],
      });
      expect(dp.status, JSON.stringify(dp.body).slice(0, 300)).toBe(200);
      S.depositId = depId;
      S.depositNumber = str(docOf(dp.body).document_number, 'deposit number');
      expect(S.depositNumber.startsWith('DEP-'), S.depositNumber).toBe(true);
      await uiPostBankingDoc(page, depId, 'Posted');

      // Visible where the operator files it.
      await page.goto('/banking/transactions');
      await dismissSetupWizard(page);
      await expect(page.locator('tr', { hasText: S.depositNumber }).first()).toBeVisible();

      // Hand-match: the statement line by its description, the ledger line
      // by the deposit number — one pair at a time, in the UI.
      await page.goto(`/banking/match?account=${S.bankId}`);
      await dismissSetupWizard(page);
      await page.locator('tr', { hasText: 'Counter deposit' }).first().locator('input[type="radio"]').check();
      await page.locator('tr', { hasText: S.depositNumber }).first().locator('input[type="checkbox"]').check();
      {
        const matched = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${S.recId}/matches`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Match selected', exact: true }).click();
        const res = await matched;
        expect(res.status(), await res.text()).toBe(200);
        // Keep the real pair ids the UI just matched: the double-match
        // refusal below replays them verbatim.
        const sent = res.request().postDataJSON() as { statementLineId: string; journalLineIds: string[] };
        S.depositLineId = sent.statementLineId;
        S.depositJournalLineIds = sent.journalLineIds;
        expect(S.depositLineId, 'deposit line id captured').toBeTruthy();
        expect(S.depositJournalLineIds.length, 'deposit journal ids captured').toBe(1);
      }
      await expect(diffStat(page)).toContainText('$0.00');
      // The match queue is drained: no statement row left to select.
      await expect(page.locator('tr').filter({ has: page.locator('input[type="radio"]') })).toHaveCount(0);
      await expect(page.getByText('Every statement line up to the cutoff is matched.').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('the same bank line cannot be matched twice', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const totalsBefore = await apiOk(page, 'GET', `/api/banking/reconciliations/${S.recId}`);
      // Replay the exact pair the UI just matched: the product must refuse
      // — the statement line is already claimed.
      expect(S.depositLineId, 'deposit line id from the UI match').toBeTruthy();
      const refused = await api(page, 'POST', `/api/banking/reconciliations/${S.recId}/matches`, {
        statementLineId: S.depositLineId,
        journalLineIds: S.depositJournalLineIds,
      });
      expect(refused.status, 'double match refused').not.toBe(200);
      expect(JSON.stringify(refused.body)).toMatch(/match/i);
      // And the totals did not move: still a zero difference.
      const totalsAfter = await apiOk(page, 'GET', `/api/banking/reconciliations/${S.recId}`);
      expect((totalsAfter.totals as Json).difference).toBe(((totalsBefore.totals as Json)).difference);
      expect(((totalsAfter.totals as Json)).difference).toBe('0.0000');
    } finally {
      await context.close();
    }
  });

  test('a matched-then-unmatched line returns cleanly with no orphaned journal', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      // The review queue holds the medium-confidence pair (the 4-day
      // clearing gap): unmatch it there, in the UI.
      await page.goto(`/banking/match?account=${S.bankId}&tab=review`);
      await dismissSetupWizard(page);
      const receiptRow = page.locator('tr', { hasText: 'Customer receipt partial' }).first();
      await expect(receiptRow).toBeVisible();
      {
        const unmatched = page.waitForResponse(
          (r) => r.url().includes(`/api/banking/reconciliations/${S.recId}/matches`) && r.request().method() === 'DELETE',
        );
        await receiptRow.getByRole('button', { name: 'Unmatch', exact: true }).click();
        const res = await unmatched;
        expect(res.status(), await res.text()).toBe(200);
      }
      // The receipt line is back in the match queue and the difference moved
      // by exactly the receipt — the journal was NOT deleted or stranded:
      // its GL leg is sitting unmatched in the ledger column, ready to
      // re-match.
      await page.goto(`/banking/match?account=${S.bankId}`);
      await expect(page.locator('tr', { hasText: 'Customer receipt partial' }).first()).toBeVisible();
      await expect(diffStat(page)).toContainText(fmtUSD(toCents(PAY2)));
      const glRow = page.locator('tr').filter({ has: page.locator('input[type="checkbox"]') }).filter({ hasText: '200.00' }).first();
      await expect(glRow).toBeVisible();

      // Re-match the same pair by hand; the difference returns to zero.
      await page.locator('tr', { hasText: 'Customer receipt partial' }).first().locator('input[type="radio"]').check();
      await glRow.locator('input[type="checkbox"]').check();
      {
        const matched = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${S.recId}/matches`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Match selected', exact: true }).click();
        const res = await matched;
        expect(res.status(), await res.text()).toBe(200);
      }
      await expect(diffStat(page)).toContainText('$0.00');
    } finally {
      await context.close();
    }
  });

  test('sign-off stamps the session and the reconciled balance ties to the GL', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      await page.goto(`/banking/match?account=${S.bankId}`);
      await dismissSetupWizard(page);
      {
        const signed = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${S.recId}/sign-off`) && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Sign off', exact: true }).click();
        await page.locator('[role="dialog"]', { hasText: 'Confirm' }).last().getByRole('button', { name: 'Confirm', exact: true }).click();
        const res = await signed;
        expect(res.status(), await res.text()).toBe(200);
        expect(((await res.json()) as Json).journalLinesReconciled).toBe(4);
      }
      await expect(page.getByText(/Signed off — 4 journal lines reconciled/).first()).toBeVisible();

      // Durable: the session is closed — the workspace offers a fresh start,
      // not the signed-off session — and the API says signed_off.
      await page.reload();
      await expect(page.getByText('No open reconciliation').first()).toBeVisible();
      const rec = await apiOk(page, 'GET', `/api/banking/reconciliations/${S.recId}`);
      expect((rec.reconciliation as Json).status).toBe('signed_off');
      const totals = rec.totals as Json;
      expect(totals.difference).toBe('0.0000');

      // The tie-out: reconciled balance == GL balance of the cash account at
      // the statement end date. Expected is computed from the four legs.
      const expected = toCents(PAY1) + toCents(PAY2) + toCents(DEPOSIT) - toCents(FEE);
      expect(expected).toBe(toCents(CLOSE));
      expect(str(totals.clearedBalance, 'cleared')).toBe('2531.5000');
      await page.goto('/reports/trial-balance?period=custom&from=2026-06-01&to=2026-06-30');
      const rows = await reportRows(page);
      const bankRow = findRow(rows, S.bankName);
      // Columns: Account # | Account | Debits | Credits | Balance.
      expect(bankRow[bankRow.length - 1]).toBe(fmtUSD(expected));
      const totalsRow = findRow(rows, 'Totals');
      expect(totalsRow[2]).toBe(totalsRow[3]);
    } finally {
      await context.close();
    }
  });

  test('a reconciled transaction refuses voiding with a reason the user can read', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      // The deposit's bank leg is stamped reconciled: voiding must refuse —
      // and say why — rather than silently rewriting signed-off books.
      const dg = await apiOk(page, 'GET', `/api/documents/${S.depositId}`);
      const refused = await api(page, 'POST', `/api/documents/${S.depositId}/void`, {
        reason: 'e2e void probe',
        expectedUpdatedAt: str(docOf(dg).updated_at, 'deposit revision'),
      });
      expect(refused.status, 'void of reconciled deposit refused').toBe(422);
      expect(JSON.stringify(refused.body)).toMatch(/bank-reconciled/i);

      // The same refusal reaches the user in the UI as a readable error.
      await openDrawer(page, `/banking/transactions?doc=${S.depositId}`);
      const drawer = page.locator('[role="dialog"]').first();
      await drawer.getByRole('button', { name: 'Actions', exact: true }).click();
      await page.locator('button', { hasText: /^Void$/ }).click();
      const prompt = page.locator('[role="dialog"]', { hasText: 'Void this transaction?' }).last();
      await expect(prompt).toBeVisible();
      await prompt.getByPlaceholder('Describe why the transaction must be reversed').fill('e2e void probe of reconciled deposit');
      const voided = page.waitForResponse(
        (r) => r.url().endsWith(`/api/documents/${S.depositId}/void`) && r.request().method() === 'POST',
      );
      await prompt.getByRole('button', { name: 'Void', exact: true }).click();
      expect((await voided).status()).toBe(422);
      await expect(page.getByText(/bank-reconciled/i).first()).toBeVisible({ timeout: 15000 });
      // Nothing was voided: the deposit still stands posted.
      await expect(drawer.getByText('Posted').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('the bank readiness gate clears once the account is signed off', async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const cleared = await apiOk(page, 'POST', `/api/close/runs/${S.runId}`, { action: 'refresh' });
      // Exactly the bank exception drained; nothing else moved.
      expect(Number(cleared.openExceptions)).toBe(S.preExceptions - 1);
      expect(Number(cleared.readinessScore)).toBe(100);

      await page.goto(`/close?run=${S.runId}&stage=readiness`);
      await dismissSetupWizard(page);
      await expect(page.getByText(/100\s*%/).first()).toBeVisible();
      await expect(page.getByText('Cash accounts need reconciliation')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
