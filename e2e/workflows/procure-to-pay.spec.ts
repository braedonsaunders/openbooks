import { expect, request, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { authedContext, dismissSetupWizard } from "../auth";

/**
 * Procure-to-pay end-to-end workflows through the real UI and real APIs.
 *
 * No mocked routes, no SQL seeding: prerequisites are created through the
 * product's own HTTP APIs (the same calls its drawers make) and the lifecycle
 * is driven through real page navigations, real approval clicks, real bank
 * matching clicks, and real report/audit reads. Every amount is asserted
 * exactly — computed in-test with bigint minor-unit math mirroring
 * engine/src/money/money.ts (4dp units) — against file bytes, journal legs, report
 * cells, and open balances. A suite that could pass while measuring nothing
 * is worse than no suite.
 *
 * Tenant contract: every workflow suite runs on its OWN pristine tenant
 * (the CI browser job snapshots one bootstrapped tenant per suite file — one
 * tenant cannot host both the close suite's USD base and quote-to-cash's CAD
 * base, and execute-now postings would otherwise leak across suites' number
 * sequences). The setup wizard establishes the general_business/US/USD
 * foundation, features are enabled additively, and every created row is
 * TAG-namespaced. Every document this suite posts carries the explicit root
 * subsidiary: with multiSubsidiary on, subsidiary-scoped document reads (AP
 * aging) exclude unscoped NULL-subsidiary rows — an order-converted bill
 * inherits the order's NULL, so without explicit scoping this suite's bills
 * vanish from the report. All money moves in the current UTC month (see the
 * DAY anchor below), so month-filtered reports isolate this suite's postings
 * exactly. The goods-receipt path refuses a stocked line with no warehouse
 * whenever the warehouse choice is ambiguous, so the suite names its own
 * warehouse explicitly on the PO line. Reconciliation sign-off is
 * date-monotonic on the suite's settlement account, so local re-runs
 * against a warm DB must re-bootstrap first.
 *
 * Flow (core test): vendor with approved bank account (second-user approval)
 * → purchase order → goods receipt → vendor bill (3-way match: bills only
 * received stock) → bill approval by a second user (pending_approval →
 * approved) → posting → pay run (planner) → NACHA file (94-char records,
 * entry hash, control totals, sha256) → posting → automatic remittance
 * (profile control asserted; queue covered by engine tests) → bank statement
 * import + UI match + UI sign-off → AP aging 0, trial-balance debits =
 * credits (plus this suite's own accounts' exact cells — the report is an
 * as-of balance carrying siblings' accounts too), balance-sheet equation
 * holds, audit trail entries per step with two distinct actors.
 *
 * Scenarios: early-payment discount (total-as-cash contract), vendor credit
 * netted with an expense-report reimbursement inside one pay run, and a
 * subcontractor blocked by missing compliance evidence then released.
 *
 * The approver login is provisioned the same way as the admin login (CI
 * browser job seeds both); both sessions go through the real /api/login.
 */

const RUN = process.env.E2E_RUN ?? "";
const TAG = (RUN || `e${Math.random().toString(36).slice(2, 8)}`).replace(/[^a-z0-9]/gi, "").slice(0, 10) || "e2e";
const APPROVER_EMAIL = process.env.E2E_APPROVER_EMAIL ?? "approver@openbooks.test";
const APPROVER_PASSWORD = process.env.E2E_APPROVER_PASSWORD ?? "approver-test-password-123";
// Date anchor: the suite floats on the current UTC month. Execute-now engines
// (pay-run posting stamps business-today by product design — payments execute
// now and cannot be backdated) must land inside the suite's own windows, so a
// fixed-month pin rots: it passes only while the wall clock cooperates. DAY is
// the real today (never future); CUTOFF reaches one day past it so a UTC
// midnight rollover between seeding and posting still matches. Business-today
// is UTC-based here: the suite never sets an org time zone, so the engine
// falls back to UTC, matching this clock. Each workflow suite runs on its own
// pristine tenant (one bootstrapped tenant cannot host both the close suite's
// USD base and quote-to-cash's CAD base), so no cross-suite month isolation
// is needed — month-filtered reports isolate this suite's postings exactly.
const __now = new Date();
const __year = __now.getUTCFullYear();
const __month = __now.getUTCMonth() + 1;
const __lastDay = new Date(Date.UTC(__year, __month, 0)).getUTCDate();
const __pad2 = (n: number): string => String(n).padStart(2, "0");
const __ym = `${__year}-${__pad2(__month)}`;
const DAY = `${__ym}-${__pad2(__now.getUTCDate())}`;
const CUTOFF = `${__ym}-${__pad2(Math.min(__lastDay, __now.getUTCDate() + 1))}`;
const MONTH_FROM = `${__ym}-01`;
const MONTH_TO = `${__ym}-${__pad2(__lastDay)}`;
// The compliance certificate must still be valid at verification time whatever
// month the suite lands in: same month next year, day clamped to month length.
const __certLast = new Date(Date.UTC(__year + 1, __month, 0)).getUTCDate();
const CERT_EXPIRES = `${__year + 1}-${__pad2(__month)}-${__pad2(Math.min(__certLast, __now.getUTCDate()))}`;
// Fixed ids so account creation is idempotent across retries/restarts.
const RNB_ID = "22222222-2222-4222-8222-222222222222";
const INV_ASSET_ID = "33333333-3333-4333-8333-333333333333";
const SETTLE_ID = "44444444-4444-4433-8443-444444444444";
// Fictitious but check-digit-valid ABA routing (nacha 3-7-1 mod-10).
const ABA_ROUTING = "123456780";

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
type Json = Record<string, unknown>;
interface ApiResult { status: number; body: Json }

/** Real product API call from inside the page (authenticated session). */
async function api(page: Page, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResult> {
  // Transport-level retry lives INSIDE the browser call: a cold dev server
  // (or a worker respawn under load) can reset a connection while compiling
  // a route. Retried ONLY for GET: replaying a mutation after a lost response
  // could double-apply a non-idempotent write (extra bank accounts, gates).
  // HTTP statuses are never retried — every assertion stays strict.
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
async function apiText(page: Page, path: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (path) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const res = await fetch(path);
        return { status: res.status, text: await res.text() };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw lastError;
  }, path);
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
    for (const nest of ["doc", "order", "flow", "party", "item"]) {
      const value = (payload[nest] as Json | undefined)?.[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  throw new Error(`no revision token in ${JSON.stringify(payload).slice(0, 300)}`);
}
function docOf(body: Json): Json {
  return (body.doc ?? body.order ?? body) as Json;
}

/** Open a drawer by URL and wait for it. */
async function openDrawer(page: Page, drawerUrl: string): Promise<Locator> {
  await page.goto(drawerUrl);
  await dismissSetupWizard(page);
  const drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Audit trail text for a document, through the drawer's Audit Trail tab. */
async function auditActions(page: Page, drawerUrl: string): Promise<string> {
  const drawer = await openDrawer(page, drawerUrl);
  await drawer.getByRole("tab", { name: "Audit Trail", exact: true }).click();
  await expect(drawer.getByText(/events/)).toBeVisible({ timeout: 15000 });
  return drawer.innerText();
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

/** NACHA ACH credit file, parsed and cross-checked (94-char records). */
function parseNacha(text: string, expectedCents: bigint, expectedCount: number) {
  const lines = text.split("\n").filter((l) => l.length > 0);
  expect(lines.length % 10, "NACHA file blocked to 10 records").toBe(0);
  for (const line of lines) expect(line.length, "every NACHA record is 94 chars").toBe(94);
  const fileHeader = lines.filter((l) => l[0] === "1");
  const batchHeaders = lines.filter((l) => l[0] === "5");
  const entries = lines.filter((l) => l[0] === "6");
  const batchControls = lines.filter((l) => l[0] === "8");
  const fileControls = lines.filter((l) => l[0] === "9" && l !== "9".repeat(94));
  const fillers = lines.filter((l) => l === "9".repeat(94));
  expect(fileHeader.length, "one file header").toBe(1);
  expect(batchHeaders.length, "one batch").toBe(1);
  expect(entries.length, "entry count").toBe(expectedCount);
  expect(batchControls.length, "one batch control").toBe(1);
  expect(fileControls.length, "one file control").toBe(1);
  expect(lines.length, "header + batch + entries + controls + fillers").toBe(4 + expectedCount + fillers.length);
  // Entry hash: sum of the first-8 routing digits mod 10^10, echoed in both controls.
  let hash = 0n;
  let total = 0n;
  for (const e of entries) {
    expect(e.slice(1, 3), "checking-credit transaction code").toBe("22");
    hash += BigInt(e.slice(3, 11));
    total += BigInt(e.slice(29, 39));
  }
  const hashMod = (hash % 10_000_000_000n).toString().padStart(10, "0");
  expect(total.toString(), "entry amounts sum to the expected cents").toBe(expectedCents.toString());
  const batch = batchControls[0]!;
  // Batch control layout (matches the product formatter in engine/src/payments/payments.ts):
  // '8' + service-class(3) + entry-count(6) + hash(10) + debit(12) + credit(12).
  expect(batch.slice(4, 10), "batch entry count").toBe(String(expectedCount).padStart(6, "0"));
  expect(batch.slice(10, 20), "batch entry hash").toBe(hashMod);
  expect(batch.slice(32, 44), "batch credit total").toBe(expectedCents.toString().padStart(12, "0"));
  const control = fileControls[0]!;
  expect(control.slice(1, 7), "file batch count").toBe("000001");
  expect(control.slice(13, 21), "file entry count").toBe(String(expectedCount).padStart(8, "0"));
  expect(control.slice(21, 31), "file entry hash").toBe(hashMod);
  expect(control.slice(43, 55), "file credit total").toBe(expectedCents.toString().padStart(12, "0"));
  return { lines, entries, hashMod, total };
}

test.describe("procure-to-pay workflows", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  const shared: { profileId: string; terms210: string; rootSub: string; stockLocationId: string } = { profileId: "", terms210: "", rootSub: "", stockLocationId: "" };
  const acct: Record<string, string> = {};
  let itemId = "";

  test.beforeAll(async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error("e2e baseURL is required");
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto("/login");
      await dismissSetupWizard(page);

      // 1. Shared foundation: the same general_business/US/USD base the close
      //    suite establishes. A same-industry re-run changes nothing, so this
      //    is order-independent; only a *different* industry/currency/calendar
      //    would lock (blocked once journals exist).
      const wizard = await api(page, "PUT", "/api/admin/setup/wizard", {
        name: "OpenBooks",
        country: "US",
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

      // 2. Additive features this suite needs (merge-safe at any time).
      //    multiSubsidiary is required before any subsidiaryId may be set
      //    (the order PATCH refuses it otherwise), and matches the shared
      //    tenant the close suite leaves behind. multiCurrency is required
      //    for the reconcilable settlement bank's currency restriction
      //    (and matches what quote-to-cash needs for its own banks later).
      const features = await api(page, "PUT", "/api/admin/setup/features", {
        features: { subcontractorCompliance: true, subcontracts: true, multiSubsidiary: true, multiCurrency: true },
      });
      req(features, "PUT /api/admin/setup/features");

      // 2b. Root subsidiary, resolved the way the close suite resolves it: a
      //     fresh journal draft defaults to root. The probe draft must not
      //     survive (an unposted draft is a close-readiness exception).
      {
        const probe = await api(page, "POST", "/api/journals/draft", {});
        const probeId = str(req(probe, "POST journals/draft probe").id, "probe draft id");
        const fetched = await api(page, "GET", `/api/journals/${probeId}`);
        shared.rootSub = str((req(fetched, "GET probe draft").doc as Json).subsidiary_id, "root subsidiary id");
        req(await api(page, "DELETE", `/api/journals/${probeId}`), "DELETE probe draft");
      }

      // 3. Resolve seeded accounts through the header search (the UI's own API).
      async function accountId(number: string): Promise<string> {
        const res = await api(page, "GET", `/api/search?q=${number}`);
        const body = req(res, `GET /api/search?q=${number}`);
        const groups = body.groups as Array<{ hits?: Array<{ id?: string; title?: string; subtitle?: string }> }>;
        const hit = (groups ?? []).flatMap((g) => g.hits ?? [])
          .find((h) => `${h.title ?? ""} ${h.subtitle ?? ""}`.includes(number));
        expect(hit?.id, `account ${number} resolvable via search`).toBeTruthy();
        return hit!.id!;
      }
      for (const number of ["2000", "5000", "6000"]) acct[number] = await accountId(number);
      // Received-not-billed clearing, inventory asset, and this suite's own
      // settlement bank have no industry seed; fixed ids make creation
      // idempotent across retries/restarts. The settlement account is
      // dedicated (not the shared 1000 Operating Bank): bank reconciliation
      // proves a zero difference against the account's full balance, which
      // sibling suites also post to — only a suite-owned account can tie
      // exactly in the shared tenant.
      for (const [id, number, name, type, extra] of [
        [RNB_ID, "2150", "Goods Received Not Billed", "liability_current_other", {}],
        [INV_ASSET_ID, "1210", "Materials Inventory", "asset_current_other", {}],
        // Reconcilable bank accounts must carry a settlement currency
        // (storage constraint); USD matches the suite's org currency.
        [SETTLE_ID, "1099", "P2P Settlement Account", "asset_bank", { reconcilable: true, currencyRestriction: "USD" }],
      ] as const) {
        const created = await api(page, "POST", "/api/accounts", { name, number, type, ...extra }, { "Idempotency-Key": id });
        if (created.status !== 201 && created.status !== 200) {
          // Already exists from an earlier run: resolve it by number.
          const existing = await accountId(number);
          acct[number] = existing;
        } else {
          acct[number] = str((created.body.account as Json).id, `${number} id`);
        }
      }

      // 4. Stock location chain. Product rule: receiving a stocked PO line
      //    with no warehouse is refused whenever the choice is ambiguous
      //    (zero or 2+ active warehouses — ORDER_LINE_WAREHOUSE_REQUIRED),
      //    so the suite names its warehouse explicitly on every stocked PO
      //    line instead of relying on the single-warehouse silent fallback.
      const loc = await api(page, "POST", "/api/admin/setup/locations", { name: `P2P Warehouse ${TAG}` });
      const locationId = str(req(loc, "POST setup/locations").id, "location id");
      const sloc = await api(page, "POST", "/api/admin/setup/stock-locations", {
        locationId,
        code: `P2PW-${TAG}`.toUpperCase(),
        kind: "warehouse",
        isActive: true,
      });
      shared.stockLocationId = str(req(sloc, "POST setup/stock-locations").id, "stock location id");

      // 5. Stock item with a FIFO costing profile (asset/cogs/RNB).
      const draft = await api(page, "POST", "/api/items/draft", {});
      itemId = str(req(draft, "POST /api/items/draft").id, "item id");
      req(await api(page, "PATCH", `/api/items/${itemId}`, {
        kind: "inventory",
        name: `P2P Widget ${TAG}`,
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

      // 6. Approval policies: vendor bills gate on submit; vendor bank details
      //    gate on create. Both route to the approver role (a different human
      //    than the submitting admin).
      function approvalGraph(trigger: "on_submit" | "on_create") {
        return {
          schemaVersion: 1,
          nodes: [
            { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger } } },
            {
              id: "gate",
              position: { x: 220, y: 0 },
              data: {
                kind: "gate",
                gate: { title: "P2P approval", assignees: [{ type: "role", role: "approver" }], mode: "any" },
              },
            },
          ],
          edges: [{ id: "e1", source: "trigger", target: "gate", sourceHandle: "next" }],
        };
      }
      for (const [subjectKind, trigger] of [["vendor_bill", "on_submit"], ["party_bank_account", "on_create"]] as const) {
        const created = await api(page, "POST", "/api/admin/flows", {
          name: `P2P ${subjectKind} approval ${TAG}`,
          subjectKind,
        });
        const flowId = str(req(created, "POST /api/admin/flows").id, "flow id");
        const read = await api(page, "GET", `/api/admin/flows/${flowId}`);
        req(await api(page, "PATCH", `/api/admin/flows/${flowId}`, {
          graph: approvalGraph(trigger),
          enabled: true,
          expectedUpdatedAt: revOf(req(read, "GET /api/admin/flows/[id]")),
        }), `PATCH flow ${subjectKind}`);
      }

      // 7. Payment terms 2/10 net-30 (discount scenario). Explicit isActive:
      //    setup rows default inactive, and inactive terms never resolve.
      const d210 = await api(page, "POST", "/api/admin/setup/payment-terms", {
        name: `P2P 2-10 Net 30 ${TAG}`,
        netDays: 30,
        discountDays: 10,
        discountPercent: 2.5,
        isActive: true,
      });
      shared.terms210 = str(req(d210, "POST payment-terms 2/10").id, "terms id");

      // 8. ACH bank profile on the NACHA-CREDIT rail: no run/file approvals
      //    (the bill approval is the control), automatic remittance, discount
      //    account set. Currency falls back to the format's USD, so no
      //    multi-currency switch is needed.
      const formats = await api(page, "GET", "/api/admin/payment-operations/formats");
      const rows = req(formats, "GET payment-operations/formats").rows as Array<{ id: string; code: string }>;
      const nacha = rows.find((r) => r.code === "NACHA-CREDIT");
      expect(nacha?.id, "built-in NACHA-CREDIT format seeded").toBeTruthy();
      const profile = await api(page, "POST", "/api/admin/payment-operations/profiles", {
        name: `P2P ACH ${TAG}`,
        bankAccountId: acct["1099"],
        paymentFormatId: nacha!.id,
        requireRunApproval: false,
        requireFileApproval: false,
        autoRemittance: true,
        settings: { discountAccountId: acct["5000"] },
        originatorSecrets: {
          odfiRouting: ABA_ROUTING,
          immediateDestination: ` ${ABA_ROUTING}`,
          immediateOrigin: "1234567890",
          destinationName: "E2E BANK",
          originName: "P2P E2E CO",
          companyName: "P2P E2E CO",
          companyId: "1234567890",
        },
      });
      shared.profileId = str(req(profile, "POST payment-operations/profiles").id, "profile id");
    } finally {
      await context.close();
    }
  });

  // --- scenario helpers -------------------------------------------------------
  async function createVendor(page: Page, displayName: string, extra?: Json): Promise<string> {
    const draft = await api(page, "POST", "/api/parties/draft", { role: "vendor" });
    const id = str(req(draft, "POST /api/parties/draft").id, "vendor id");
    const got = await api(page, "GET", `/api/parties/${id}`);
    req(await api(page, "PATCH", `/api/parties/${id}`, {
      displayName,
      isActive: true,
      expectedUpdatedAt: revOf(req(got, "GET /api/parties/[id]")),
      changeReason: "P2P E2E: activate test vendor",
      ...extra,
    }), "PATCH /api/parties/[id]");
    return id;
  }

  async function addBankAccount(page: Page, partyId: string, accountNumber: string): Promise<string> {
    const created = await api(page, "POST", `/api/parties/${partyId}/bank-accounts`, {
      bankName: "First Bank of E2E",
      country: "US",
      // No currency field: an explicit currency is multi-currency
      // configuration and 404s when that switch is off; omitted, the USD
      // org base applies.
      routing: { routingNumber: ABA_ROUTING },
      accountNumber,
    });
    expect(created.status, `POST bank-accounts: ${JSON.stringify(created.body)}`).toBe(201);
    return str(created.body.id, "bank account id");
  }

  /**
   * Approver browser context: API login (same /api/login the form posts to),
   * then real page navigations + real Approve clicks. The clicks — not the
   * login ceremony, which smoke.spec.ts already covers through the form — are
   * this suite's second-identity proof.
   */
  async function approverContext(browser: Browser, baseURL?: string): Promise<BrowserContext> {
    if (!baseURL) throw new Error("e2e baseURL is required for API login");
    const origin = new URL(baseURL).origin;
    const ignoreHTTPSErrors = process.env.E2E_IGNORE_HTTPS_ERRORS === "1";
    const apiCtx = await request.newContext({ baseURL, ignoreHTTPSErrors });
    try {
      const res = await apiCtx.post("/api/login", {
        data: { email: APPROVER_EMAIL, password: APPROVER_PASSWORD },
        headers: { Origin: origin },
      });
      if (!res.ok) throw new Error(`approver login failed: ${res.status()} ${await res.text()}`);
      return await browser.newContext({ baseURL, storageState: await apiCtx.storageState(), ignoreHTTPSErrors });
    } finally {
      await apiCtx.dispose();
    }
  }

  /**
   * The approver resolves the gate for one subject through the real UI.
   * Loops: click the oldest Approve button, then re-read the approver's own
   * worklist (the UI's endpoint) until no pending gate names this subject. On
   * a fresh tenant that is exactly one click; on a warm tenant it also clears
   * older test gates first. decideGate refuses non-assignees and the
   * submitter server-side, so resolution proves a second identity approved.
   */
  async function approveSubjectViaUi(browser: Browser, baseURL: string | undefined, subjectId: string) {
    const ctx = await approverContext(browser, baseURL);
    const approverPage = await ctx.newPage();
    try {
      await approverPage.goto("/approvals");
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const isPending = await approverPage.evaluate(async (subjectId) => {
          const res = await fetch("/api/flows/gates");
          if (!res.ok) return true;
          const body = (await res.json()) as { gates?: Array<{ subjectId?: string; subject_id?: string }> };
          return (body.gates ?? []).some((g) => (g.subjectId ?? g.subject_id) === subjectId);
        }, subjectId);
        if (!isPending) return;
        const buttons = approverPage.getByRole("button", { name: "Approve", exact: true });
        await expect(buttons.first()).toBeVisible({ timeout: 30_000 });
        // The row disables while a decision is in flight; wait it out instead
        // of double-clicking into a 409 (a slow decide may already be
        // resolving this gate — the loop re-checks before clicking).
        await expect(buttons.first()).toBeEnabled({ timeout: 90_000 });
        const stillPending = await approverPage.evaluate(async (subjectId) => {
          const res = await fetch("/api/flows/gates");
          if (!res.ok) return true;
          const body = (await res.json()) as { gates?: Array<{ subjectId?: string; subject_id?: string }> };
          return (body.gates ?? []).some((g) => (g.subjectId ?? g.subject_id) === subjectId);
        }, subjectId);
        if (!stillPending) return;
        await buttons.first().click();
      }
      throw new Error(`gate for ${subjectId} still pending after UI approvals`);
    } finally {
      await ctx.close();
    }
  }

  /** Post a service-amount vendor bill through submit → UI approval → post. */
  async function postServiceBill(
    page: Page, browser: Browser, baseURL: string | undefined,
    vendorId: string, amount: string, accountId: string,
  ): Promise<string> {
    const draft = await api(page, "POST", "/api/documents/draft", { kind: "vendor_bill" });
    const billId = str(req(draft, "POST documents/draft bill").id, "bill id");
    const got = await api(page, "GET", `/api/documents/${billId}`);
    req(await api(page, "PATCH", `/api/documents/${billId}`, {
      partyId: vendorId,
      subsidiaryId: shared.rootSub,
      documentDate: DAY,
      lines: [{ accountId, description: `P2P services ${TAG}`, amount }],
      expectedUpdatedAt: revOf(req(got, "GET bill draft")),
    }), "PATCH bill lines");
    req(await api(page, "POST", "/api/documents/actions", { action: "submit", documentId: billId }), "POST bill submit");
    await approveSubjectViaUi(browser, baseURL, billId);
    req(await api(page, "POST", "/api/documents/actions", { action: "post", documentId: billId }), "POST bill post");
    return billId;
  }

  /** Create a pay run over posted bills, submit, generate the file, post it. */
  async function postRunToPaid(
    page: Page, billDocumentIds: string[], scheduledFor?: string,
  ): Promise<{ runId: string; fileText: string; filename: string }> {
    const runCreate = await api(page, "POST", "/api/payments/runs", {
      paymentBankProfileId: shared.profileId,
      billDocumentIds,
      ...(scheduledFor ? { scheduledFor } : {}),
    });
    const runId = str(req(runCreate, "POST /api/payments/runs").id, "run id");
    req(await api(page, "POST", `/api/payments/runs/${runId}/submit`, {}), "POST run submit");
    const fileInfo = req(await api(page, "POST", `/api/payments/runs/${runId}/file`, {}), "POST run file");
    const fileRes = await apiText(page, `/api/payments/runs/${runId}/file`);
    expect(fileRes.status, "GET run file bytes").toBe(200);
    const runPost = await api(page, "POST", `/api/payments/runs/${runId}/post`, {});
    expect(req(runPost, "POST run post").ok, "run posted cleanly").toBe(true);
    return { runId, fileText: fileRes.text, filename: String(fileInfo.filename) };
  }

  async function apOpenSum(page: Page, partyId: string): Promise<bigint> {
    const open = await api(page, "GET", `/api/payments/open-items?partyId=${partyId}&side=ap`);
    const items = req(open, "GET open-items").items as Array<{ open?: string; transactionOpen?: string }>;
    return items.reduce((n, i) => n + toUnits(String(i.transactionOpen ?? i.open ?? "0")), 0n);
  }

  const MONTH = `period=custom&from=${MONTH_FROM}&to=${MONTH_TO}`;

  test("core flow: approve, order, receive, bill, pay, NACHA, reconcile, tie out", async ({ browser, baseURL }) => {
    const unitPrice = "25.0000";
    const qty = "100";
    const billTotal = fromUnits(toUnits(unitPrice) * BigInt(qty)); // 2500.0000
    const billCents = (toUnits(billTotal) / 100n).toString(); // NACHA cents

    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto("/purchase-orders");
      await dismissSetupWizard(page);
      await expect(page.locator("main")).toContainText(/\S/);

      // Vendor + bank account (pending until the approver releases it).
      const vendorName = `Acme Industrial ${TAG}`;
      const vendorId = await createVendor(page, vendorName);
      const bankAccountId = await addBankAccount(page, vendorId, "1002003");

      // Approver releases the bank details with a real UI click (proves
      // pending -> approved by a second identity, not self-approval).
      await approveSubjectViaUi(browser, baseURL, bankAccountId);
      const party = await api(page, "GET", `/api/parties/${vendorId}`);
      const bankAccounts = req(party, "GET party after approval").bankAccounts as Array<{
        id: string; approval_status?: string; approved_by?: string; submitted_by?: string;
      }>;
      const approved = bankAccounts.find((b) => b.id === bankAccountId);
      expect(approved?.approval_status, "bank details approved by second user").toBe("approved");
      // Separation of duties, straight from the row: the submitter cannot be
      // the approver (decideGate refuses both non-assignees and submitters).
      expect(approved?.approved_by, "approver recorded").toBeTruthy();
      expect(approved?.approved_by, "approver differs from submitter").not.toBe(approved?.submitted_by);

      // Vendor workspace renders the new vendor.
      await page.goto("/parties");
      await expect(page.locator("main")).toContainText(vendorName);

      // Purchase order: 100 widgets @ $25 on the stock item.
      const poDraft = await api(page, "POST", "/api/purchase-orders/draft", {});
      const poId = str(req(poDraft, "POST /api/purchase-orders/draft").id, "PO id");
      const poGet = await api(page, "GET", `/api/purchase-orders/${poId}`);
      const poEdit = await api(page, "PATCH", `/api/purchase-orders/${poId}`, {
        partyId: vendorId,
        subsidiaryId: shared.rootSub,
        documentDate: DAY,
        lines: [{
          itemId,
          accountId: acct["1210"],
          description: "Industrial widgets",
          quantity: qty,
          unit: "ea",
          unitPrice,
          // Explicit warehouse: the receipt refuses a warehouseless stocked
          // line whenever the org's warehouse choice is ambiguous.
          stockLocationId: shared.stockLocationId,
        }],
        expectedUpdatedAt: revOf(req(poGet, "GET PO")),
      });
      const poEdited = req(poEdit, "PATCH PO lines");
      const poNumber = str(docOf(poEdited).documentNumber ?? docOf(poEdited).document_number, "PO number");
      req(await api(page, "PATCH", `/api/purchase-orders/${poId}`, {
        status: "approved",
        expectedUpdatedAt: revOf(poEdited),
      }), "PATCH PO issue");
      await page.goto("/purchase-orders");
      await expect(page.locator("main")).toContainText(poNumber);

      // Goods receipt pulls the full remainder; the bill then bills received stock.
      const poFresh = await api(page, "GET", `/api/purchase-orders/${poId}`);
      const rcpt = await api(page, "POST", `/api/purchase-orders/${poId}/convert`, {
        targetKind: "purchase_receipt",
        expectedUpdatedAt: revOf(req(poFresh, "GET PO fresh")),
      });
      const rcptId = str(req(rcpt, "POST PO convert receipt").id, "receipt id");

      const poFresh2 = await api(page, "GET", `/api/purchase-orders/${poId}`);
      const billConv = await api(page, "POST", `/api/purchase-orders/${poId}/convert`, {
        targetKind: "vendor_bill",
        expectedUpdatedAt: revOf(req(poFresh2, "GET PO fresh2")),
      });
      const billId = str(req(billConv, "POST PO convert bill").id, "bill id");
      const billGet = await api(page, "GET", `/api/documents/${billId}`);
      const bill = docOf(req(billGet, "GET bill"));
      expect(String(bill.total), "3-way bill totals the received stock value").toBe(billTotal);
      // The bill line pins its 3-way linkage to the order line and document.
      const billLines = req(billGet, "GET bill lines").lines as Array<{
        custom?: { purchaseOrderLineId?: string; convertedFrom?: { documentId?: string } };
      }>;
      expect(billLines.length, "bill carries its lines").toBe(1);
      expect(billLines[0]!.custom?.purchaseOrderLineId, "bill line links the PO line").toBeTruthy();
      expect(billLines[0]!.custom?.convertedFrom?.documentId, "bill line links the PO").toBe(poId);
      // Conversion inherits the order header: the bill must carry the same
      // root subsidiary, or subsidiary-scoped document reads drop it once a
      // sibling suite adds a second legal entity (proven by failure).
      expect(
        String(bill.subsidiaryId ?? bill.subsidiary_id),
        "converted bill inherits the order's root subsidiary",
      ).toBe(shared.rootSub);
      await page.goto("/ap/bills");
      await expect(page.locator("main")).toContainText(String(bill.documentNumber ?? ""));

      // Submit -> pending_approval (the vendor_bill flow gates it).
      req(await api(page, "POST", "/api/documents/actions", { action: "submit", documentId: billId }), "POST bill submit");
      const billPending = await api(page, "GET", `/api/documents/${billId}`);
      expect(String(docOf(req(billPending, "GET bill pending")).status), "bill gated to pending_approval").toBe("pending_approval");

      // Second user approves through the real approvals UI.
      await approveSubjectViaUi(browser, baseURL, billId);
      const billApproved = await api(page, "GET", `/api/documents/${billId}`);
      expect(String(docOf(req(billApproved, "GET bill approved")).status), "bill approved by second user").toBe("approved");

      // Post: DR received-not-billed / CR AP 2500. Exact legs via the entry API.
      req(await api(page, "POST", "/api/documents/actions", { action: "post", documentId: billId }), "POST bill post");
      const billPosted = await api(page, "GET", `/api/documents/${billId}`);
      const billEntry = await api(page, "GET", `/api/reports/entry/${str(docOf(req(billPosted, "GET bill posted")).posted_entry_id, "bill entry id")}`);
      const billLegs = (req(billEntry, "GET bill entry").lines ?? []) as Array<{ account_number?: string; amount?: string }>;
      const billLeg = (number: string) => billLegs.find((l) => l.account_number === number)?.amount;
      expect(billLeg("2150"), "receipt clears through RNB").toBe("2500.0000");
      expect(billLeg("2000"), "AP credited $2,500").toBe("-2500.0000");

      // AP aging carries the open $2,500 before payment (month-filtered).
      await page.goto(`/reports/aging?${MONTH}&side=ap`);
      {
        const rows = await reportRows(page);
        const agingRow = findRow(rows, vendorName);
        expect(agingRow[agingRow.length - 1]).toBe(fmtUSD(250000n));
      }

      // Pay run (planner): create from the posted bill, submit, generate file.
      const runCreate = await api(page, "POST", "/api/payments/runs", {
        paymentBankProfileId: shared.profileId,
        billDocumentIds: [billId],
      });
      const runId = str(req(runCreate, "POST /api/payments/runs").id, "run id");
      await page.goto("/payments");
      await expect(page.locator("main")).toContainText(/\S/);
      req(await api(page, "POST", `/api/payments/runs/${runId}/submit`, {}), "POST run submit");
      const fileGen = await api(page, "POST", `/api/payments/runs/${runId}/file`, {});
      const fileInfo = req(fileGen, "POST run file");
      expect(String(fileInfo.filename), "NACHA filename").toMatch(/^NACHA-RUN-.*\.ach$/);
      expect(String(fileInfo.status), "file auto-approved by profile").toBe("approved");

      // File bytes: 94-char records, hash and control totals == $2,500.
      const fileRes = await apiText(page, `/api/payments/runs/${runId}/file`);
      expect(fileRes.status, "GET run file bytes").toBe(200);
      const parsed = parseNacha(fileRes.text, BigInt(billCents), 1);
      expect(parsed.entries[0], "payee entry carries the vendor").toContain(vendorName.slice(0, 22).trim());
      const sha = createHash("sha256").update(fileRes.text, "utf8").digest("hex");
      expect(sha.length, "sha256 recorded over the exact downloaded bytes").toBe(64);

      // Post the run: DR AP / CR bank 2500; bill open balance -> 0.
      const runPost = await api(page, "POST", `/api/payments/runs/${runId}/post`, {});
      expect(req(runPost, "POST run post").ok, "run posted cleanly").toBe(true);
      expect(fromUnits(await apOpenSum(page, vendorId)), "AP aging 0 after payment").toBe("0.0000");
      // The paid vendor's row leaves the AP-aging UI (other vendors'
      // open rows legitimately remain in the shared tenant).
      await page.goto(`/reports/aging?${MONTH}&side=ap`);
      {
        const rows = await reportRows(page);
        expect(rows.some((r) => r.some((c) => c.includes(vendorName))), "paid vendor absent from AP aging").toBe(false);
      }

      // Automatic remittance: the profile arms it (the queue has no vendor-run
      // read surface; delivery is covered by payment-remittance-queue tests).
      const profiles = await api(page, "GET", "/api/admin/payment-operations/profiles");
      const profileRows = req(profiles, "GET payment-operations/profiles").rows as Array<{ id: string; auto_remittance?: boolean }>;
      expect(profileRows.find((p) => p.id === shared.profileId)?.auto_remittance, "profile queues automatic remittance").toBe(true);

      // Bank reconciliation in the UI: statement in, match the outflow to the
      // payment journal, sign off with confirmation.
      const rec = await api(page, "POST", "/api/banking/reconciliations", {
        accountId: acct["1099"], throughDate: CUTOFF, statementBalance: "-2500.00",
      });
      const recId = str(req(rec, "POST reconciliations").id, "reconciliation id");
      const imp = await api(page, "POST", "/api/banking/import", {
        accountId: acct["1099"],
        source: "csv",
        text: `date,amount,description\n${DAY},-2500.00,P2P NACHA ${TAG}\n`,
        mapping: { date: 0, amount: 1, description: 2 },
        mode: "import",
      });
      expect(req(imp, "POST banking/import").imported, "one statement line imported").toBe(1);
      const payNumber = await (async () => {
        const detail = await api(page, "GET", `/api/payments/runs/${runId}`);
        const instructions = req(detail, "GET run detail").instructions as Array<{ document_number?: string }>;
        return str(instructions[0]?.document_number, "payment number");
      })();
      await page.goto(`/banking/match?account=${acct["1099"]}`);
      await dismissSetupWizard(page);
      await page.locator("tr", { hasText: `P2P NACHA ${TAG}` }).first().locator('input[type="radio"]').check();
      await page.locator("tr", { hasText: payNumber }).first().locator('input[type="checkbox"]').check();
      {
        const matched = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/matches`) && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Match selected", exact: true }).click();
        const res = await matched;
        expect(res.status(), await res.text()).toBe(200);
      }
      {
        const signed = page.waitForResponse(
          (r) => r.url().endsWith(`/api/banking/reconciliations/${recId}/sign-off`) && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Sign off", exact: true }).click();
        await page.locator('[role="dialog"]', { hasText: "Confirm" }).last().getByRole("button", { name: "Confirm", exact: true }).click();
        const res = await signed;
        expect(res.status(), await res.text()).toBe(200);
      }
      await page.goto("/banking/reconciliations");
      await expect(page.locator("main")).toContainText(/\S/);

      // Trial balance as of month-end. This report carries balances, not
      // period movement, so sibling suites' accounts legitimately appear
      // here (close's August bills, payroll's January runs). What this
      // suite owns, asserted exactly: the tie itself (debits == credits)
      // and its own suite-created accounts' cells. The 3-way-match clearing
      // (RNB/AP net zero) is proven per-party by the entry-leg reads above
      // plus the AP-aging checks — never by global absence, which no suite
      // can promise in a shared tenant. Columns: Account # | Account |
      // Debits | Credits | Balance.
      await page.goto(`/reports/trial-balance?${MONTH}`);
      {
        const rows = await reportRows(page);
        const totals = findRow(rows, "Totals");
        expect(totals[2], "trial balance debits equal credits").toBe(totals[3]);
        expect(totals[totals.length - 1]).toBe(fmtUSD(0n));
        const invRow = findRow(rows, "Materials Inventory");
        expect(invRow[2]).toBe(fmtUSD(250000n));
        const bankRow = findRow(rows, "P2P Settlement Account");
        expect(bankRow[3]).toBe(fmtUSD(250000n));
      }
      // Balance sheet ties: assets equal liabilities + equity, exactly.
      await page.goto(`/reports/balance-sheet?${MONTH}`);
      {
        const rows = await reportRows(page);
        const assets = findRow(rows, "Total Assets");
        const liabEquity = findRow(rows, "Total Liabilities and Equity");
        expect(assets[assets.length - 1]).toBe(liabEquity[liabEquity.length - 1]);
      }

      // Audit trail through the UI drawer + the record endpoint per step.
      {
        const billAudit = await auditActions(page, `/ap/bills?doc=${billId}`);
        expect(billAudit).toContain("Created");
        expect(billAudit).toContain("Posted");
        expect(billAudit).toContain("E2E Admin");
      }
      for (const id of [poId, rcptId, billId]) {
        const audit = await api(page, "GET", `/api/audit/record?table=documents&id=${id}`);
        const rows = (req(audit, "GET audit/record").rows ?? []) as Array<{ action?: string }>;
        expect(rows.length, `audit entries for ${id}`).toBeGreaterThan(0);
      }
      expect(fromUnits(toUnits(billTotal)), "bill total exact").toBe("2500.0000");
    } finally {
      await context.close();
    }
  });

  test("early-payment discount settles $1,000 for $975 cash (total-as-cash)", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto("/");
      await dismissSetupWizard(page);

      const vendorName = `Discount Supply ${TAG}`;
      const vendorId = await createVendor(page, vendorName, {
        // Role writes apply only with explicit enabled:true (the flyout
        // always sends it; without it the role payload is a silent no-op).
        roles: { vendor: { enabled: true, paymentTermsId: shared.terms210 } },
      });
      const bankAccountId = await addBankAccount(page, vendorId, "2003004");
      await approveSubjectViaUi(browser, baseURL, bankAccountId);

      const billId = await postServiceBill(page, browser, baseURL, vendorId, "1000.0000", str(acct["6000"], "6000 account"));
      // scheduledFor pins the payment date inside the discount window whatever
      // the real today is (deadline = document date + 10 days).
      const { fileText, filename, runId } = await postRunToPaid(page, [billId], DAY);
      expect(filename, "NACHA filename").toMatch(/^NACHA-RUN-.*\.ach$/);
      // 2.5% of $1,000 = $25: cash moves $975.
      parseNacha(fileText, 97500n, 1);

      // Total-as-cash contract: the payment header pins the $975 cash frame…
      const detail = await api(page, "GET", `/api/payments/runs/${runId}`);
      const instructions = req(detail, "GET run detail").instructions as Array<{ payment_document_id?: string }>;
      expect(instructions.length, "one instruction").toBe(1);
      const paymentGet = await api(page, "GET", `/api/payments/${String(instructions[0]!.payment_document_id)}`);
      const payment = docOf(req(paymentGet, "GET payment doc"));
      expect(String(payment.total), "payment header pins cash $975").toBe("975.0000");
      // …while its legs relieve the gross $1,000 AP and book the $25 discount.
      const entry = await api(page, "GET", `/api/reports/entry/${str(payment.posted_entry_id, "payment entry id")}`);
      const legs = (req(entry, "GET payment entry").lines ?? []) as Array<{ account_number?: string; amount?: string }>;
      const leg = (number: string) => legs.find((l) => l.account_number === number)?.amount;
      expect(leg("2000"), "AP leg relieves gross $1,000").toBe("1000.0000");
      expect(leg("1099"), "bank leg moves $975 cash").toBe("-975.0000");
      expect(leg("5000"), "discount leg books $25").toBe("-25.0000");
      expect(fromUnits(await apOpenSum(page, vendorId)), "AP aging 0 after discounted payment").toBe("0.0000");
      await page.goto(`/reports/aging?${MONTH}&side=ap`);
      await expect(page.locator("main")).toContainText(/\S/);
    } finally {
      await context.close();
    }
  });

  test("vendor credit netted with an expense reimbursement inside one pay run", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto("/");
      await dismissSetupWizard(page);

      // Vendor with an $800 bill and a $200 posted credit memo (ungated kind:
      // submit auto-approves, then post).
      const vendorId = await createVendor(page, `Credit Vendor ${TAG}`);
      const vendorBank = await addBankAccount(page, vendorId, "3004005");
      await approveSubjectViaUi(browser, baseURL, vendorBank);
      const billId = await postServiceBill(page, browser, baseURL, vendorId, "800.0000", str(acct["6000"], "6000 account"));
      const creditDraft = await api(page, "POST", "/api/documents/draft", { kind: "vendor_credit" });
      const creditId = str(req(creditDraft, "POST documents/draft credit").id, "credit id");
      const creditGet = await api(page, "GET", `/api/documents/${creditId}`);
      req(await api(page, "PATCH", `/api/documents/${creditId}`, {
        partyId: vendorId,
        subsidiaryId: shared.rootSub,
        documentDate: DAY,
        lines: [{ accountId: acct["6000"], description: `P2P return ${TAG}`, amount: "200.0000" }],
        expectedUpdatedAt: revOf(req(creditGet, "GET credit draft")),
      }), "PATCH credit lines");
      req(await api(page, "POST", "/api/documents/actions", { action: "submit", documentId: creditId }), "POST credit submit");
      req(await api(page, "POST", "/api/documents/actions", { action: "post", documentId: creditId }), "POST credit post");

      // Employee with an approved bank account and a $150 expense report.
      const empDraft = await api(page, "POST", "/api/parties/draft", { role: "employee" });
      const employeeId = str(req(empDraft, "POST parties/draft employee").id, "employee id");
      const empGet = await api(page, "GET", `/api/parties/${employeeId}`);
      req(await api(page, "PATCH", `/api/parties/${employeeId}`, {
        displayName: `P2P Field Tech ${TAG}`,
        isActive: true,
        expectedUpdatedAt: revOf(req(empGet, "GET employee")),
        changeReason: "P2P E2E: activate test employee",
      }), "PATCH employee");
      const empBank = await addBankAccount(page, employeeId, "4005006");
      await approveSubjectViaUi(browser, baseURL, empBank);
      const expDraft = await api(page, "POST", "/api/expenses/draft", {});
      const expenseId = str(req(expDraft, "POST expenses/draft").id, "expense id");
      const expGet = await api(page, "GET", `/api/expenses/${expenseId}`);
      // No subsidiaryId: the expense PATCH has no such field by product
      // design. The reimbursement still resolves — the pay-run planner scopes
      // by the caller's allowance and books root-scoped lines — so the
      // explicit scoping above covers every document kind that accepts one.
      req(await api(page, "PATCH", `/api/expenses/${expenseId}`, {
        partyId: employeeId,
        documentDate: DAY,
        memo: `P2P site visit ${TAG}`,
        // out_of_pocket: the employee fronted the money and the pay run
        // reimburses them. company_paid would require a corporate card and
        // pay the issuer (owed nothing to the employee); personal is a
        // receivable from the employee. Only out_of_pocket belongs in a
        // reimbursement run — the drawer defaults new lines the same way.
        lines: [{ accountId: acct["6000"], description: "Mileage and meals", amount: "150.0000", settlementType: "out_of_pocket" }],
        expectedUpdatedAt: revOf(req(expGet, "GET expense draft")),
      }), "PATCH expense lines");
      req(await api(page, "POST", "/api/expenses/actions", { action: "submit", documentId: expenseId }), "POST expense submit");
      req(await api(page, "POST", "/api/expenses/actions", { action: "post", documentId: expenseId }), "POST expense post");
      await page.goto("/expenses");
      await expect(page.locator("main")).toContainText(/\S/);

      // One pay run: the $200 credit nets the $800 bill ($600 cash) and the
      // $150 expense reimburses alongside — $750 moves in the file.
      const { fileText, runId } = await postRunToPaid(page, [billId, expenseId]);
      parseNacha(fileText, 75000n, 2);
      const detail = await api(page, "GET", `/api/payments/runs/${runId}`);
      const instructions = req(detail, "GET run detail").instructions as Array<{ payee?: string; amount?: string }>;
      const byPayee = new Map(instructions.map((i) => [i.payee, i.amount]));
      expect(byPayee.get(`Credit Vendor ${TAG}`), "vendor instruction net of credit").toBe("600.0000");
      expect(byPayee.get(`P2P Field Tech ${TAG}`), "employee reimbursed in full").toBe("150.0000");
      expect(fromUnits(await apOpenSum(page, vendorId)), "vendor AP 0 (bill + credit consumed)").toBe("0.0000");
      expect(fromUnits(await apOpenSum(page, employeeId)), "employee advance 0").toBe("0.0000");
      await page.goto("/payments");
      await expect(page.locator("main")).toContainText(/\S/);
    } finally {
      await context.close();
    }
  });

  test("subcontractor blocked by missing compliance evidence, then released", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto("/");
      await dismissSetupWizard(page);

      // Policy: subcontractors must carry current general-liability evidence;
      // a lapse blocks payment (not posting). Setup rows default inactive, so
      // activation is explicit.
      const cls = await api(page, "POST", "/api/admin/setup/compliance-classes", {
        code: `SUB-${TAG}`, name: `P2P Subcontractors ${TAG}`, isActive: true,
      });
      const classId = str(req(cls, "POST compliance-classes").id, "class id");
      const reqt = await api(page, "POST", "/api/admin/setup/compliance-requirements", {
        code: `GLIAB-${TAG}`,
        name: "General liability certificate",
        category: "insurance",
        classId,
        enforcement: "block_payment",
        isActive: true,
      });
      const requirementId = str(req(reqt, "POST compliance-requirements").id, "requirement id");

      const vendorId = await createVendor(page, `Subcontractor ${TAG}`);
      const vendorBank = await addBankAccount(page, vendorId, "5006007");
      await approveSubjectViaUi(browser, baseURL, vendorBank);
      req(await api(page, "PATCH", `/api/compliance/vendors/${vendorId}`, { complianceClassId: classId }), "PATCH vendor class");
      const billId = await postServiceBill(page, browser, baseURL, vendorId, "300.0000", str(acct["6000"], "6000 account"));
      await page.goto("/compliance/vendors");
      await expect(page.locator("main")).toContainText(/\S/);

      // No evidence on file: the run is refused with the control's own error.
      // (Anti-false-green: this exact refusal must fire, or the release below
      // proves nothing.)
      const blocked = await api(page, "POST", "/api/payments/runs", {
        paymentBankProfileId: shared.profileId,
        billDocumentIds: [billId],
      });
      expect(blocked.status, "blocked run HTTP status").toBe(422);
      expect(JSON.stringify(blocked.body), "compliance blocks the run").toContain("subcontractor compliance blocks payment");

      // The admin records the certificate; the approver — never the recorder —
      // verifies it. Self-verification is refused by the product control.
      const recorded = await api(page, "POST", "/api/compliance/records", {
        partyId: vendorId,
        requirementId,
        issuerName: "E2E Mutual",
        policyNumber: `GL-${TAG}`,
        effectiveFrom: DAY,
        expiresOn: CERT_EXPIRES,
      });
      const recordId = str(req(recorded, "POST compliance/records").id, "record id");
      const selfVerify = await api(page, "PATCH", `/api/compliance/records/${recordId}`, { action: "verify" });
      expect(selfVerify.status, "self-verification refused").toBe(422);
      const approverCtx = await approverContext(browser, baseURL);
      try {
        const approverPg = await approverCtx.newPage();
        // A fresh page starts at about:blank, where a relative fetch URL
        // cannot resolve — land on the app first (the admin page this test
        // seeds through is already there, which is why only this call failed).
        await approverPg.goto("/");
        await dismissSetupWizard(approverPg);
        req(await api(approverPg, "PATCH", `/api/compliance/records/${recordId}`, { action: "verify" }), "PATCH verify as approver");
      } finally {
        await approverCtx.close();
      }

      // Released: the same selection now pays in full through the file.
      const { fileText } = await postRunToPaid(page, [billId]);
      parseNacha(fileText, 30000n, 1);
      expect(fromUnits(await apOpenSum(page, vendorId)), "subcontractor AP 0 after release").toBe("0.0000");
      await page.goto("/payments");
      await expect(page.locator("main")).toContainText(/\S/);
    } finally {
      await context.close();
    }
  });
});
