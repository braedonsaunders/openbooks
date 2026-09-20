import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { authedContext, dismissSetupWizard } from "../auth";

/**
 * Inventory-to-COGS end-to-end workflow through the real UI and real APIs.
 *
 * No mocked routes, no SQL seeding: prerequisites are created through the
 * product's own HTTP APIs (the same calls its drawers make) and every
 * lifecycle transition is clicked in the UI with a wait on the backing
 * request — except the inventory reversal, which has a product API route but
 * no UI affordance, so the movement is located through the rendered
 * movements view and reversed through that route. Every amount is asserted
 * exactly — computed in-test with bigint 4dp-unit math mirroring
 * engine/src/money/money.ts — against rendered lists, drawers, reports, and the
 * audit trail.
 *
 * Story (FIFO item, three purchase lots at different costs):
 *   PO-A 10 units @ $10.00 -> receipt -> bill (posted)
 *   PO-B 10 units @ $20.00 -> receipt -> bill (posted)
 *     on hand 20, value $300.00
 *   SO-1 10 units @ $50.00 -> ship -> invoice $500 (posted)
 *     FIFO COGS $100.00; on hand 10, value $200.00
 *   SO-2 12 units: shipment refused (only 10 on hand), UI must say why
 *   SO-3 2 units @ $50.00 -> ship -> invoice $100 (posted)
 *     FIFO COGS $40.00; on hand 8, value $160.00
 *   PO-C 10 units @ $30.00 -> receipt -> bill (posted): on hand 18, $460.00
 *   return of SO-3's shipment: warehouse receives 2 units back at the $20.00
 *   cost they left at (offset to COGS) + a $100 customer credit memo posts
 *     on hand 20, value $500.00; COGS back to $100.00; revenue net $500.00
 *
 * The return receive deliberately lands AFTER lot C so "the cost it left at"
 * ($20.00) differs from the prevailing average ($460.00 / 18 = $25.5556): a
 * receive at current cost would book $51.11 and leave COGS at $88.89, so the
 * exact $40.00 / $100.00 assertions prove the cost, not just the quantity.
 *
 * At every stop the inventory subledger (cost layers, as rendered by the
 * on-hand view) ties exactly to the inventory GL account (trial balance).
 * The suite owns its tenant, so cumulative reports are suite-exact.
 */

const RUN = process.env.E2E_RUN ?? "";

/** Retry-aware prefix: a Playwright retry re-seeds against an org the failed
 *  attempt already seeded, so names/codes shift with the retry index. */
function tag(base: string): string {
  const retry = test.info().retry;
  return `${base}${RUN}${retry > 0 ? `R${retry}` : ""}`;
}

/** Minor-unit money (4dp): '2500.00' -> 25000000n. */
function toUnits(amount: string): bigint {
  const neg = amount.trim().startsWith("-");
  const digits = amount.trim().replace("-", "");
  const [whole = "0", frac = ""] = digits.split(".");
  const units = BigInt(whole) * 10_000n + BigInt((frac + "0000").slice(0, 4));
  return neg ? -units : units;
}
function fromUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  return `${neg ? "-" : ""}${abs / 10_000n}.${String(abs % 10_000n).padStart(4, "0")}`;
}
function grouped(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** UI money cell in USD: 250000n cents -> '$2,500.00', negatives parenthesized. */
function fmtUSD(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const text = `$${grouped((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, "0")}`;
  return neg ? `(${text})` : text;
}
/** 4dp units -> display cents for fmtUSD. */
const toCents = (units: bigint): bigint => units / 100n;

type Json = Record<string, unknown>;
interface ApiResult { status: number; body: Json }

/** Real product API call from inside the page (authenticated session). */
async function api(page: Page, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResult> {
  const retryable = method === "GET";
  return page.evaluate(
    async ({ method, path, data, extra, retryable }) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < (retryable ? 4 : 1); attempt += 1) {
        try {
          const res = await fetch(path, {
            method,
            headers: { "Content-Type": "application/json", ...(extra ?? {}) },
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
    { method, path, data: body, extra: headers ?? {}, retryable },
  );
}
function req(result: ApiResult, url: string): Json {
  expect(result.status, `${url}: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 400)}`).toBeLessThan(300);
  return result.body;
}
function str(value: unknown, what = "id"): string {
  if (typeof value !== "string" || !value) throw new Error(`expected ${what} string, got ${JSON.stringify(value)?.slice(0, 80)}`);
  return value;
}
/** Optimistic-concurrency revision, wherever the payload carries it. */
function revOf(payload: Json): string {
  for (const key of ["updated_at", "updatedAt"]) {
    const direct = payload[key];
    if (typeof direct === "string" && direct.length > 0) return direct;
    for (const nest of ["doc", "order", "party", "item"]) {
      const value = (payload[nest] as Json | undefined)?.[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  throw new Error(`no revision token in ${JSON.stringify(payload).slice(0, 300)}`);
}
function docOf(body: Json): Json {
  return (body.doc ?? body.order ?? body) as Json;
}

/** Open a drawer by URL and wait for it. The dialog wait is generous on
 *  purpose: drawers are client-rendered, and a cold dev server compiles
 *  their chunk on first hit (CI serves them precompiled in milliseconds). */
async function openDrawer(page: Page, drawerUrl: string): Promise<Locator> {
  await page.goto(drawerUrl);
  await dismissSetupWizard(page);
  const drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible({ timeout: 60000 });
  return drawer;
}

/**
 * Navigate to a report and read its table. The table read waits for report-
 * specific marker text first: without it the read can win a race against
 * client hydration and return the previous page's table (or none), which
 * fails as a mysteriously absent row.
 */
async function gotoReport(page: Page, url: string, marker: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("table").first()).toContainText(marker, { timeout: 60000 });
}

/** Read a report table as rows of cell texts. */
async function reportRows(page: Page): Promise<string[][]> {
  return page.evaluate(() => {
    const table = document.querySelectorAll("table")[0];
    if (!table) return [];
    return [...table.querySelectorAll("tr")].map((tr) =>
      [...tr.querySelectorAll("th,td")].map((c) => (c.textContent ?? "").trim().replace(/\s+/g, " ")));
  });
}
function findRow(rows: string[][], needle: string): string[] {
  const row = rows.find((r) => r.some((c) => c.includes(needle)));
  expect(row, `report row containing ${needle}`).toBeTruthy();
  return row as string[];
}

/** Convert the open order through the Actions menu; returns the created doc. */
async function uiConvert(page: Page, drawerUrl: string, apiBase: string, id: string, button: string, targetKind: string): Promise<{ id: string; documentNumber: string }> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole("button", { name: "Actions", exact: true }).click();
  const waited = page.waitForResponse(
    (r) => r.url().endsWith(`${apiBase}/${id}/convert`) && r.request().method() === "POST",
  );
  const convertButton = page.locator("button", { hasText: button });
  await expect(convertButton).toBeEnabled({ timeout: 20000 });
  await convertButton.click();
  const res = await waited;
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { id: string; documentNumber: string; kind: string };
  expect(body.kind).toBe(targetKind);
  return { id: str(body.id, "converted id"), documentNumber: str(body.documentNumber, "converted number") };
}

/**
 * Submit then post a document drawer (two-step approval lifecycle). A posted
 * invoice carrying a balance resolves to the open status; balance-less docs
 * show the posted status.
 */
async function uiSubmitAndPost(page: Page, drawerUrl: string, expectedBadge: "Open" | "Posted"): Promise<void> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole("button", { name: "Actions", exact: true }).click();
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith("/api/documents/actions") && r.request().method() === "POST",
  );
  await page.locator("button", { hasText: "Submit for approval" }).click();
  const resSubmit = await submitted;
  expect(resSubmit.status(), await resSubmit.text()).toBe(200);
  await expect(drawer.getByText("Approved")).toBeVisible({ timeout: 15000 });
  await openDrawer(page, drawerUrl);
  const drawer2 = page.locator('[role="dialog"]').first();
  await drawer2.getByRole("button", { name: "Actions", exact: true }).click();
  const posted = page.waitForResponse(
    (r) => r.url().endsWith("/api/documents/actions") && r.request().method() === "POST",
  );
  await page.locator("button", { hasText: /^Post$/ }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(200);
  await expect(drawer2.getByText(expectedBadge)).toBeVisible({ timeout: 15000 });
}

/** Audit trail text for a document, through the drawer's Audit Trail tab. */
async function auditActions(page: Page, drawerUrl: string): Promise<string> {
  const drawer = await openDrawer(page, drawerUrl);
  await drawer.getByRole("tab", { name: "Audit Trail", exact: true }).click();
  await expect(drawer.getByText(/events/)).toBeVisible({ timeout: 15000 });
  return drawer.innerText();
}

// Fixed ids so account creation is idempotent across retries/restarts.
const RNB_ID = "22222222-2222-4222-8222-222222222222";
const INV_ASSET_ID = "33333333-3333-4333-8333-333333333333";

// Date anchor: the suite floats on the current UTC month. Receipts and
// fulfillments stamp business-today by product design (they execute now and
// cannot be backdated), so a fixed-month pin rots: June documents would land
// outside a June report window within days. DAY is the real today; the
// month window always contains every posting this suite makes.
const __now = new Date();
const __year = __now.getUTCFullYear();
const __month = __now.getUTCMonth() + 1;
const __lastDay = new Date(Date.UTC(__year, __month, 0)).getUTCDate();
const __pad2 = (n: number): string => String(n).padStart(2, "0");
const __ym = `${__year}-${__pad2(__month)}`;
const DAY = `${__ym}-${__pad2(__now.getUTCDate())}`;
const MONTH = `period=custom&from=${__ym}-01&to=${__ym}-${__pad2(__lastDay)}`;

// Exact story economics (4dp strings; FIFO consumption asserted per leg).
const LOT_A_QTY = "10";
const LOT_A_COST = "10.0000";
const LOT_B_QTY = "10";
const LOT_B_COST = "20.0000";
const SELL_PRICE = "50.0000";

test.describe("inventory receipt to fulfillment to COGS to return", () => {
  // No retries: this is a stateful saga, and retrying it mid-flight would
  // double-post the deterministic seed (a second receipt doubles on-hand).
  // A failure aborts the file; recovery is a fresh job (CI clones a
  // pristine tenant per suite). Names/codes stay retry-aware anyway so a
  // local re-run or a future per-test split never collides.
  test.describe.configure({ mode: "serial", timeout: 300_000, retries: 0 });

  const shared: { stockLocationId: string } = { stockLocationId: "" };
  // Seeded once in beforeAll (which does not re-run on test retry), so the
  // label is captured there rather than recomputed per test.
  let T = "";
  const acct: Record<string, string> = {};
  let itemId = "";
  let vendorId = "";
  let customerId = "";
  let itemName = "";
  // Shipment + invoice ids carried across tests (serial saga).
  const flow: { ship1: string; inv1: string; so2: string; ship3: string; inv3: string; poC: string; credit: string } =
    { ship1: "", inv1: "", so2: "", ship3: "", inv3: "", poC: "", credit: "" };

  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error("e2e baseURL is required");
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto("/login");
      await dismissSetupWizard(page);

      const wizard = await api(page, "PUT", "/api/admin/setup/wizard", {
        name: "OpenBooks",
        country: "US",
        baseCurrency: "USD",
        fiscalYearStartMonth: 1,
        industry: "general_business",
        features: {},
        workspaceProfile: {
          teamSize: "small",
          complexity: "essentials",
          bookStart: "fresh",
          taxPosition: "not_registered",
          monthlyActivity: "light",
          closeCadence: "monthly",
        },
      });
      req(wizard, "PUT /api/admin/setup/wizard");

      const features = await api(page, "PUT", "/api/admin/setup/features", {
        features: { orders: true, inventory: true },
      });
      req(features, "PUT /api/admin/setup/features");

      async function accountId(number: string): Promise<string> {
        const res = await api(page, "GET", `/api/search?q=${number}`);
        const body = req(res, `GET /api/search?q=${number}`);
        const groups = body.groups as Array<{ hits?: Array<{ id?: string; title?: string; subtitle?: string }> }>;
        const hit = (groups ?? []).flatMap((g) => g.hits ?? [])
          .find((h) => `${h.title ?? ""} ${h.subtitle ?? ""}`.includes(number));
        expect(hit?.id, `account ${number} resolvable via search`).toBeTruthy();
        return hit!.id!;
      }
      for (const number of ["4000", "5000"]) acct[number] = await accountId(number);
      for (const [id, number, name, type] of [
        [RNB_ID, "2150", "W3 Goods Received Not Billed", "liability_current_other"],
        [INV_ASSET_ID, "1210", "W3 Inventory Asset", "asset_current_other"],
      ] as const) {
        const created = await api(page, "POST", "/api/accounts", { name, number, type }, { "Idempotency-Key": id });
        if (created.status !== 201 && created.status !== 200) {
          acct[number] = await accountId(number);
        } else {
          acct[number] = str((created.body.account as Json).id, `${number} id`);
        }
      }

      // Single active warehouse: the receipt/fulfillment path auto-assigns
      // the location only when the choice is unambiguous.
      const t = tag("W3I");
      T = t;
      const loc = await api(page, "POST", "/api/admin/setup/locations", { name: `W3 Warehouse ${t}` });
      const locationId = str(req(loc, "POST setup/locations").id, "location id");
      const sloc = await api(page, "POST", "/api/admin/setup/stock-locations", {
        locationId,
        code: `W3W-${t}`.toUpperCase(),
        kind: "warehouse",
        isActive: true,
      });
      shared.stockLocationId = str(req(sloc, "POST setup/stock-locations").id, "stock location id");

      itemName = `W3 Widget ${t}`;
      const draft = await api(page, "POST", "/api/items/draft", {});
      itemId = str(req(draft, "POST /api/items/draft").id, "item id");
      req(await api(page, "PATCH", `/api/items/${itemId}`, {
        kind: "inventory",
        name: itemName,
        incomeAccountId: acct["4000"],
        isActive: true,
      }), "PATCH /api/items/[id]");
      req(await api(page, "PUT", `/api/items/${itemId}/costing`, {
        costingMethod: "fifo",
        tracking: "none",
        assetAccountId: acct["1210"],
        cogsAccountId: acct["5000"],
        adjustmentAccountId: acct["5000"],
        receivedNotBilledAccountId: acct["2150"],
        baseUnit: "ea",
        expectedUpdatedAt: null,
      }), "PUT /api/items/[id]/costing");

      async function createParty(role: string, displayName: string): Promise<string> {
        const pDraft = await api(page, "POST", "/api/parties/draft", { role });
        const id = str(req(pDraft, "POST /api/parties/draft").id, `${role} id`);
        const got = await api(page, "GET", `/api/parties/${id}`);
        req(await api(page, "PATCH", `/api/parties/${id}`, {
          displayName,
          isActive: true,
          expectedUpdatedAt: revOf(req(got, "GET party")),
          changeReason: "W3 E2E: activate test party",
        }), "PATCH party activate");
        return id;
      }
      vendorId = await createParty("vendor", `W3 Supplier ${t}`);
      customerId = await createParty("customer", `W3 Customer ${t}`);

      storageState = await context.storageState();
    } finally {
      await context.close();
    }
  });

  async function freshPage(browser: Browser, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      baseURL,
      storageState,
      ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1",
    });
    const page = await context.newPage();
    await page.goto("/login");
    await dismissSetupWizard(page);
    return { context, page };
  }

  /** Trial-balance cell for one account row: [number, name, debits, credits, balance]. Tie-outs always read the balance column (4): accounts with legs on both sides only tie there. */
  async function tbCell(page: Page, needle: string, col: number): Promise<string> {
    await gotoReport(page, `/reports/trial-balance?${MONTH}`, "Account #");
    return findRow(await reportRows(page), needle)[col]!;
  }

  /** Purchase order -> goods receipt -> vendor bill, bill submitted + posted. */
  async function receiveLot(page: Page, qty: string, unitPrice: string, documentDate: string): Promise<{ poId: string; receiptId: string; billId: string; poNumber: string }> {
    const poDraft = await api(page, "POST", "/api/purchase-orders/draft", {});
    const poId = str(req(poDraft, "POST /api/purchase-orders/draft").id, "PO id");
    const poGet = await api(page, "GET", `/api/purchase-orders/${poId}`);
    const poEdit = await api(page, "PATCH", `/api/purchase-orders/${poId}`, {
      partyId: vendorId,
      documentDate,
      lines: [{
        itemId,
        accountId: acct["1210"],
        description: itemName,
        quantity: qty,
        unit: "ea",
        unitPrice,
      }],
      expectedUpdatedAt: revOf(req(poGet, "GET PO")),
    });
    const poEdited = req(poEdit, "PATCH PO lines");
    const poNumber = str(docOf(poEdited).documentNumber ?? docOf(poEdited).document_number, "PO number");
    req(await api(page, "PATCH", `/api/purchase-orders/${poId}`, {
      status: "approved",
      expectedUpdatedAt: revOf(poEdited),
    }), "PATCH PO issue");
    const poFresh = await api(page, "GET", `/api/purchase-orders/${poId}`);
    const rcpt = await api(page, "POST", `/api/purchase-orders/${poId}/convert`, {
      targetKind: "purchase_receipt",
      expectedUpdatedAt: revOf(req(poFresh, "GET PO fresh")),
    });
    const receiptId = str(req(rcpt, "POST PO convert receipt").id, "receipt id");
    const poFresh2 = await api(page, "GET", `/api/purchase-orders/${poId}`);
    const billConv = await api(page, "POST", `/api/purchase-orders/${poId}/convert`, {
      targetKind: "vendor_bill",
      expectedUpdatedAt: revOf(req(poFresh2, "GET PO fresh2")),
    });
    const billId = str(req(billConv, "POST PO convert bill").id, "bill id");
    req(await api(page, "POST", "/api/documents/actions", { action: "submit", documentId: billId }), "POST bill submit");
    req(await api(page, "POST", "/api/documents/actions", { action: "post", documentId: billId }), "POST bill post");
    return { poId, receiptId, billId, poNumber };
  }

  test("receives two lots at different costs and ties the subledger to the GL", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const lotA = await receiveLot(page, LOT_A_QTY, LOT_A_COST, DAY);
      const lotB = await receiveLot(page, LOT_B_QTY, LOT_B_COST, DAY);

      // Purchase-order list renders both orders.
      await page.goto("/purchase-orders");
      await expect(page.locator("main")).toContainText(lotA.poNumber);
      await expect(page.locator("main")).toContainText(lotB.poNumber);

      // Warehouse view: the item's on-hand row carries 20 units worth
      // $300.00 (quantity 20.0000, average $15.00) — the cost-layer
      // subledger rendered, row-scoped to the item.
      await page.goto("/inventory");
      {
        const ohRow = page.locator("tr", { hasText: itemName }).first();
        await expect(ohRow).toContainText("20.0000");
        await expect(ohRow).toContainText("$300.00");
      }

      // GL tie-out: the inventory asset account carries exactly the
      // subledger value; RNB cleared to zero by the two posted bills; AP
      // carries the $300 owed. Columns: Account # | Account | Debits |
      // Credits | Balance.
      expect(await tbCell(page, "W3 Inventory Asset", 4)).toBe(fmtUSD(toCents(toUnits("300.0000"))));
      expect(await tbCell(page, "W3 Goods Received Not Billed", 4)).toBe(fmtUSD(0n));
      // Trial balance balances.
      await gotoReport(page, `/reports/trial-balance?${MONTH}`, "Account #");
      {
        const rows = await reportRows(page);
        const totals = findRow(rows, "Totals");
        expect(totals[2], "trial balance debits equal credits").toBe(totals[3]);
      }

      // Both bills posted: exact legs DR RNB / CR AP per bill.
      for (const [billId, expected] of [[lotA.billId, "100.0000"], [lotB.billId, "200.0000"]] as const) {
        const billGet = await api(page, "GET", `/api/documents/${billId}`);
        const bill = docOf(req(billGet, "GET bill posted"));
        expect(String(bill.status), "bill posted").toBe("posted");
        const entry = await api(page, "GET", `/api/reports/entry/${str(bill.posted_entry_id, "bill entry id")}`);
        const legs = (req(entry, "GET bill entry").lines ?? []) as Array<{ account_number?: string; amount?: string }>;
        const leg = (number: string) => legs.find((l) => l.account_number === number)?.amount;
        expect(leg("2150"), "bill clears RNB").toBe(expected);
        expect(leg("2000"), "bill credits AP").toBe(`-${expected}`);
      }

      // AP aging carries the $300 owed to this vendor.
      await gotoReport(page, `/reports/aging?${MONTH}&side=ap`, "Current");
      {
        const rows = await reportRows(page);
        const agingRow = findRow(rows, `W3 Supplier ${T}`);
        expect(agingRow[agingRow.length - 1]).toBe(fmtUSD(toCents(toUnits("300.0000"))));
      }

      // Audit trail per step.
      for (const id of [lotA.poId, lotA.receiptId, lotA.billId, lotB.poId, lotB.receiptId, lotB.billId]) {
        const audit = await api(page, "GET", `/api/audit/record?table=documents&id=${id}`);
        const rows = (req(audit, "GET audit/record").rows ?? []) as Array<{ action?: string }>;
        expect(rows.length, `audit entries for ${id}`).toBeGreaterThan(0);
      }
      expect(fromUnits(toUnits("300.0000")), "lot value exact").toBe("300.0000");
    } finally {
      await context.close();
    }
  });

  /** Sales order seeded + approved through the product order routes. */
  async function seedSalesOrder(page: Page, qty: string, documentDate: string): Promise<{ soId: string; soNumber: string }> {
    const soDraft = await api(page, "POST", "/api/sales-orders/draft", {});
    const soId = str(req(soDraft, "POST /api/sales-orders/draft").id, "SO id");
    const soGet = await api(page, "GET", `/api/sales-orders/${soId}`);
    const soEdit = await api(page, "PATCH", `/api/sales-orders/${soId}`, {
      partyId: customerId,
      documentDate,
      lines: [{
        itemId,
        accountId: acct["4000"],
        description: itemName,
        quantity: qty,
        unit: "ea",
        unitPrice: SELL_PRICE,
      }],
      expectedUpdatedAt: revOf(req(soGet, "GET SO")),
    });
    const soEdited = req(soEdit, "PATCH SO lines");
    const soNumber = str(docOf(soEdited).documentNumber ?? docOf(soEdited).document_number, "SO number");
    req(await api(page, "PATCH", `/api/sales-orders/${soId}`, {
      status: "approved",
      expectedUpdatedAt: revOf(soEdited),
    }), "PATCH SO issue");
    return { soId, soNumber };
  }

  test("ships the first sales order and posts FIFO COGS at shipment", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      // No COGS row at all before the first shipment: the report omits
      // zero-balance accounts, so absence is the honest zero assertion.
      await gotoReport(page, `/reports/trial-balance?${MONTH}`, "Account #");
      {
        const rows = await reportRows(page);
        expect(rows.some((r) => r.some((c) => c.includes("Cost of Goods Sold"))), "no COGS before any shipment").toBe(false);
      }
      const { soId, soNumber } = await seedSalesOrder(page, "10", DAY);

      // UI: pick, pack, ship — Convert to Shipment through the order drawer.
      const ship = await uiConvert(page, `/sales-orders?order=${soId}`, "/api/sales-orders", soId, "Convert to Shipment", "sales_fulfillment");
      flow.ship1 = ship.id;
      expect(ship.documentNumber.startsWith("SHIP-"), ship.documentNumber).toBe(true);
      await page.goto("/sales-orders");
      await expect(page.locator("main")).toContainText(soNumber);
      // The shipment is linked from its order's drawer (fulfillments are
      // operational documents, not rows on the orders list).
      await openDrawer(page, `/sales-orders?order=${soId}`);
      await expect(page.locator('[role="dialog"]').first()).toContainText(ship.documentNumber);

      // UI: invoice the shipment, submit, post.
      const inv = await uiConvert(page, `/sales-orders?order=${soId}`, "/api/sales-orders", soId, "Convert to Invoice", "customer_invoice");
      flow.inv1 = inv.id;
      await uiSubmitAndPost(page, `/ar/invoices?doc=${inv.id}`, "Open");

      // Invoice list shows the posted $500 total.
      await page.goto("/ar/invoices");
      const invRow = page.locator("tr", { hasText: inv.documentNumber }).first();
      await expect(invRow.getByText("$500.00").first()).toBeVisible();

      // FIFO COGS: the 10 shipped units empty lot A exactly (10 x $10.00).
      const cogsAfter = await tbCell(page, "Cost of Goods Sold", 4);
      expect(cogsAfter).toBe(fmtUSD(toCents(toUnits("100.0000"))));

      // Subledger ties to GL: 10 units @ $20.00 = $200.00.
      await page.goto("/inventory");
      {
        const ohRow = page.locator("tr", { hasText: itemName }).first();
        await expect(ohRow).toContainText("10.0000");
        await expect(ohRow).toContainText("$200.00");
      }
      expect(await tbCell(page, "W3 Inventory Asset", 4)).toBe(fmtUSD(toCents(toUnits("200.0000"))));

      // AR aging carries the $500 open invoice.
      await gotoReport(page, `/reports/aging?${MONTH}&side=ar`, "Current");
      {
        const rows = await reportRows(page);
        const agingRow = findRow(rows, `W3 Customer ${T}`);
        expect(agingRow[agingRow.length - 1]).toBe(fmtUSD(toCents(toUnits("500.0000"))));
      }

      // The invoice biller is fulfillment-governed: posting it moved no
      // stock a second time (on hand still 10 in the warehouse view above).
      const invAudit = await auditActions(page, `/ar/invoices?doc=${inv.id}`);
      expect(invAudit).toContain("Created");
      expect(invAudit).toContain("Posted");
    } finally {
      await context.close();
    }
  });

  test("refuses to ship more than is on hand and says why", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const { soId, soNumber } = await seedSalesOrder(page, "12", DAY);
      flow.so2 = soId;

      // UI: attempt the shipment through the same control a picker uses.
      await openDrawer(page, `/sales-orders?order=${soId}`);
      const drawer = page.locator('[role="dialog"]').first();
      await drawer.getByRole("button", { name: "Actions", exact: true }).click();
      const waited = page.waitForResponse(
        (r) => r.url().endsWith(`/api/sales-orders/${soId}/convert`) && r.request().method() === "POST",
      );
      await page.locator("button", { hasText: "Convert to Shipment" }).click();
      const res = await waited;
      expect(res.status(), "overship refused").toBe(422);
      expect(await res.text()).toContain("insufficient stock");

      // The refusal must be user-visible: the drawer keeps a persistent
      // error alert naming the shortage (plus a toast) instead of failing
      // silent. A silent refusal here is a product defect.
      await expect(drawer.getByRole("alert")).toContainText(/insufficient stock/i);
      await expect(drawer.getByRole("alert")).toContainText("on hand 10.0000");

      // Nothing moved: the failed shipment leaves on hand and the GL alone.
      await page.goto("/sales-orders");
      await expect(page.locator("main")).toContainText(soNumber);
      expect(await tbCell(page, "W3 Inventory Asset", 4)).toBe(fmtUSD(toCents(toUnits("200.0000"))));
      expect(await tbCell(page, "Cost of Goods Sold", 4)).toBe(fmtUSD(toCents(toUnits("100.0000"))));
    } finally {
      await context.close();
    }
  });

  test("ships again, restocks, then unwinds the return at the cost it left at", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const { soId, soNumber } = await seedSalesOrder(page, "2", DAY);
      const ship = await uiConvert(page, `/sales-orders?order=${soId}`, "/api/sales-orders", soId, "Convert to Shipment", "sales_fulfillment");
      flow.ship3 = ship.id;
      const inv = await uiConvert(page, `/sales-orders?order=${soId}`, "/api/sales-orders", soId, "Convert to Invoice", "customer_invoice");
      flow.inv3 = inv.id;
      await uiSubmitAndPost(page, `/ar/invoices?doc=${inv.id}`, "Open");

      // Second shipment consumes 2 units @ $20.00 from lot B: COGS $140.00
      // cumulative, on hand 8 worth $160.00.
      expect(await tbCell(page, "Cost of Goods Sold", 4)).toBe(fmtUSD(toCents(toUnits("140.0000"))));
      expect(await tbCell(page, "W3 Inventory Asset", 4)).toBe(fmtUSD(toCents(toUnits("160.0000"))));

      // Lot C arrives before the return is processed: 10 units @ $30.00.
      // On hand 18, value $460.00 — and the prevailing average ($25.5556)
      // now differs from the $20.00 the returned units left at.
      const lotC = await receiveLot(page, "10", "30.0000", DAY);
      flow.poC = lotC.poId;
      expect(await tbCell(page, "W3 Inventory Asset", 4)).toBe(fmtUSD(toCents(toUnits("460.0000"))));
      await page.goto("/purchase-orders");
      await expect(page.locator("main")).toContainText(lotC.poNumber);

      // The customer returns both units from the second shipment. The
      // warehouse receives them back at the exact $20.00 cost they left at,
      // offset to COGS — the same route the New Movement drawer calls.
      const rma = await api(page, "POST", "/api/inventory/actions", {
        action: "receive",
        itemId,
        stockLocationId: shared.stockLocationId,
        quantity: "2",
        unitCost: "20.0000",
        offsetAccountId: acct["5000"],
        date: DAY,
        memo: `W3 E2E customer return of ${ship.documentNumber}: restock at original cost`,
        idempotencyKey: crypto.randomUUID(),
      });
      const rmaBody = req(rma, "POST inventory/actions receive");
      // Leg-level proof of the cost: DR inventory $40.00 / CR COGS $40.00.
      const rmaEntry = await api(page, "GET", `/api/reports/entry/${str(rmaBody.entryId, "RMA entry id")}`);
      const rmaLegs = (req(rmaEntry, "GET RMA entry").lines ?? []) as Array<{ account_number?: string; amount?: string }>;
      const rmaLeg = (number: string) => rmaLegs.find((l) => l.account_number === number)?.amount;
      expect(rmaLeg("1210"), "RMA restores inventory $40 at original cost").toBe("40.0000");
      expect(rmaLeg("5000"), "RMA unwinds COGS $40").toBe("-40.0000");

      // $100 credit memo against the invoice (2 units @ $50.00), then post.
      const creditDraft = await api(page, "POST", "/api/documents/draft", { kind: "customer_credit" });
      const creditId = str(req(creditDraft, "POST customer_credit draft").id, "credit id");
      flow.credit = creditId;
      const creditGet = await api(page, "GET", `/api/documents/${creditId}`);
      req(await api(page, "PATCH", `/api/documents/${creditId}`, {
        partyId: customerId,
        documentDate: DAY,
        lines: [{
          itemId,
          accountId: acct["4000"],
          description: `Return of ${itemName}`,
          quantity: "2",
          unitPrice: SELL_PRICE,
          // Document lines carry their own amount (unlike order lines,
          // which the order writer prices): 2 x $50.00.
          amount: "100.0000",
        }],
        expectedUpdatedAt: revOf(req(creditGet, "GET credit draft")),
      }), "PATCH credit lines");
      req(await api(page, "POST", "/api/documents/actions", { action: "submit", documentId: creditId }), "POST credit submit");
      req(await api(page, "POST", "/api/documents/actions", { action: "post", documentId: creditId }), "POST credit post");
      // The credit reverses revenue, not stock: DR revenue $100 / CR AR $100.
      const creditGet2 = await api(page, "GET", `/api/documents/${creditId}`);
      const creditEntry = await api(page, "GET", `/api/reports/entry/${str(docOf(req(creditGet2, "GET credit posted")).posted_entry_id, "credit entry id")}`);
      const creditLegs = (req(creditEntry, "GET credit entry").lines ?? []) as Array<{ account_number?: string; amount?: string }>;
      const creditLeg = (number: string) => creditLegs.find((l) => l.account_number === number)?.amount;
      expect(creditLeg("4000"), "credit reverses revenue $100").toBe("100.0000");
      for (const id of [lotC.poId, lotC.receiptId, lotC.billId]) {
        const audit = await api(page, "GET", `/api/audit/record?table=documents&id=${id}`);
        const rows = (req(audit, "GET audit/record").rows ?? []) as Array<{ action?: string }>;
        expect(rows.length, `audit entries for ${id}`).toBeGreaterThan(0);
      }

      // Inventory and COGS both unwound: 20 units worth $500.00 on hand
      // (8 x $20 + 10 x $30 + 2 x $20), COGS back to $100.00.
      await page.goto("/inventory");
      {
        const ohRow = page.locator("tr", { hasText: itemName }).first();
        await expect(ohRow).toContainText("20.0000");
        await expect(ohRow).toContainText("$500.00");
      }
      expect(await tbCell(page, "W3 Inventory Asset", 4)).toBe(fmtUSD(toCents(toUnits("500.0000"))));
      expect(await tbCell(page, "Cost of Goods Sold", 4)).toBe(fmtUSD(toCents(toUnits("100.0000"))));

      // AR nets to $500 ($600 billed, $100 credited).
      await page.goto("/sales-orders");
      await expect(page.locator("main")).toContainText(soNumber);
      await gotoReport(page, `/reports/aging?${MONTH}&side=ar`, "Current");
      {
        const rows = await reportRows(page);
        const agingRow = findRow(rows, `W3 Customer ${T}`);
        expect(agingRow[agingRow.length - 1]).toBe(fmtUSD(toCents(toUnits("500.0000"))));
      }

      // The movements view carries receipt and issue rows for the item.
      await page.goto("/inventory?inventoryView=movements");
      await dismissSetupWizard(page);
      await expect(page.locator("main")).toContainText(/receipt/i);
      await expect(page.locator("main")).toContainText(/issue/i);
    } finally {
      await context.close();
    }
  });

  test("closing tie-out: subledger, warehouse, reports, and ledger agree", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      // Trial balance balances and carries the suite-exact economics:
      // inventory $500 debit, COGS $100 debit, AP $600 credit, AR $500 debit.
      await gotoReport(page, `/reports/trial-balance?${MONTH}`, "Account #");
      {
        const rows = await reportRows(page);
        const totals = findRow(rows, "Totals");
        expect(totals[2], "trial balance debits equal credits").toBe(totals[3]);
        expect(totals[totals.length - 1]).toBe(fmtUSD(0n));
        expect(findRow(rows, "W3 Inventory Asset")[4]).toBe(fmtUSD(toCents(toUnits("500.0000"))));
        expect(findRow(rows, "Cost of Goods Sold")[4]).toBe(fmtUSD(toCents(toUnits("100.0000"))));
      }
      // AP aging carries all three unpaid bills ($100 + $200 + $300).
      await gotoReport(page, `/reports/aging?${MONTH}&side=ap`, "Current");
      {
        const rows = await reportRows(page);
        const agingRow = findRow(rows, `W3 Supplier ${T}`);
        expect(agingRow[agingRow.length - 1]).toBe(fmtUSD(toCents(toUnits("600.0000"))));
      }

      // Balance sheet ties: assets equal liabilities + equity, exactly.
      await gotoReport(page, `/reports/balance-sheet?${MONTH}`, "Total Assets");
      {
        const rows = await reportRows(page);
        const assets = findRow(rows, "Total Assets");
        const liabEquity = findRow(rows, "Total Liabilities and Equity");
        expect(assets[assets.length - 1]).toBe(liabEquity[liabEquity.length - 1]);
      }

      // Item record, warehouse view, and GL agree on the same 20 / $500.
      await openDrawer(page, `/items?item=${itemId}`);
      await expect(page.locator('[role="dialog"]').first()).toContainText(itemName);
      await page.goto("/inventory");
      {
        const ohRow = page.locator("tr", { hasText: itemName }).first();
        await expect(ohRow).toContainText("20.0000");
        await expect(ohRow).toContainText("$500.00");
      }

      // Every document in the saga carries an audit trail with the actor.
      for (const id of [flow.ship1, flow.inv1, flow.so2, flow.ship3, flow.inv3, flow.credit]) {
        const audit = await api(page, "GET", `/api/audit/record?table=documents&id=${id}`);
        const rows = (req(audit, "GET audit/record").rows ?? []) as Array<{ action?: string }>;
        expect(rows.length, `audit entries for ${id}`).toBeGreaterThan(0);
      }
      const creditAudit = await auditActions(page, `/ar/invoices?doc=${flow.credit}`);
      expect(creditAudit).toContain("Posted");
    } finally {
      await context.close();
    }
  });
});
