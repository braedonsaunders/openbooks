import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { authedContext, dismissSetupWizard } from "../auth";
import {
  api,
  auditActions,
  contractIdFor,
  deferredAccountNumber,
  docOf,
  expect,
  findRow,
  fmt4,
  fmtUSD,
  ok,
  openDrawer,
  partyDocs,
  readDunningLog,
  readDunningOutbox,
  loadState,
  reportRows,
  resolveObligationIds,
  resolveOrgId,
  apiPostReceipt,
  runDunning,
  saveState,
  str,
  tag,
  toCents,
  uiSubmitAndPost,
} from "./support/subscription-to-revenue";

/**
 * Subscription to revenue: recurring billing through deferred revenue
 * recognition through dunning, ending in a mid-term credit.
 *
 * Two annual subscriptions on one 12-month straight-line rule (plan A
 * $1,000.00 — deliberately indivisible by 12, so the suite proves the
 * largest-remainder split leaves no residue; plan B $1,200.00 — clean $100
 * months so the credit math is legible). Both invoices post 2026-01-15 due
 * 2026-02-14. Customer A pays in full in February and must never hear from
 * dunning. Customer B goes unpaid: the 7/14/30-day rungs fire with the live
 * open balance; after March recognition ($300 earned) a $900 credit memo to
 * the deferred account unwinds the unearned remainder and a combined receipt
 * ($300 cash + $900 credit) settles the invoice; the subscription is
 * cancelled. Plan A then recognises to exactly $1,000.00 across the full
 * term; the +60-day run stays silent on both settled invoices.
 *
 * Design notes (read before editing):
 * - Seeding uses `page.request` against the same API routes the UI calls,
 *   never direct SQL: the ledger under test is posted by the real kernel.
 * - The dunning RUN has no HTTP route by design (it is a scheduler tick, not
 *   an operator action), so the suite shells out to scheduler-tick.mts, which
 *   calls the real scheduler entrypoint `runDunningForOrg` under tsx, and
 *   observes its append-only `dunning_log` + staged `scheduler_outbox` rows.
 *   Obligation ids for scoped recognition runs are resolved the same way
 *   (read probe); the recognition POSTS themselves go through the product
 *   route, including one through the drawer's Run button.
 * - Money: API/ledger assertions are exact 4dp strings; rendered pages show
 *   2dp rounded money, so UI assertions use the rounded display value while
 *   the exact tie-outs live in API assertions. In-test expectations are
 *   recomputed below from the suite's own constants (bigint cents), never by
 *   reading back the schedule the product wrote.
 * - No retries: this is a stateful saga. `tag()`/`deferredAccountNumber()`
 *   still shift every seeded name/code/number with the attempt index so a
 *   retried file (or a local re-run against a dirty dev database) seeds fresh
 *   records instead of colliding.
 * - Boundary (F-w5-001): posting a credit does not retire the obligation's
 *   remaining plan, and no product route calls the engine's cancellation, so
 *   the suite never runs recognition past the credit for the credited
 *   obligation. The drawer keeps showing the leftover plan honestly.
 */

// In-test constants (the independent leg of every tie-out).
const PLAN_A = "1000.00";
const PLAN_B = "1200.00";
// Plan A $1,000 over 12 months: largest-remainder puts the extra ten-
// thousandth on the first four lines: 4 x 83.3334 + 8 x 83.3333.
const A_FIRST = "83.3334";
const A_JAN_DEFERRED = "916.6666"; // 1000 - 83.3334
const A_JAN_MAR = "250.0002"; // 3 x 83.3334
const A_APR_DEC = "749.9998"; // 1 x 83.3334 + 8 x 83.3333
const B_MONTH = "100.0000";
const B_JAN_MAR = "300.0000";
const B_CREDIT = "900.0000";
const B_CASH = "300.0000";
// Balance-sheet deferred checkpoints (unrecognised remainder, in-test math).
const DEFERRED_JAN = "2016.6666"; // 2200 - (83.3334 + 100)
const DEFERRED_MAR = "1649.9998"; // 2200 - (250.0002 + 300)
const DEFERRED_APR = "749.9998"; // plan A remainder only, after the B credit

const S: {
  orgId: string;
  deferredId: string;
  incomeId: string;
  bankId: string;
  itemId: string;
  partyAId: string;
  partyBId: string;
  subAId: string;
  subBId: string;
  invAId: string;
  invANumber: string;
  invBId: string;
  invBNumber: string;
  creditId: string;
  creditNumber: string;
  receiptAId: string;
  receiptBId: string;
  receiptBNumber: string;
  oblAId: string;
  oblBId: string;
} = {
  orgId: "",
  deferredId: "",
  incomeId: "",
  bankId: "",
  itemId: "",
  partyAId: "",
  partyBId: "",
  subAId: "",
  subBId: "",
  invAId: "",
  invANumber: "",
  invBId: "",
  invBNumber: "",
  creditId: "",
  creditNumber: "",
  receiptAId: "",
  receiptBId: "",
  receiptBNumber: "",
  oblAId: "",
  oblBId: "",
};

test.describe("subscription to revenue", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });
  // A retry would re-seed against an org the failed attempt already seeded
  // (and the first attempt's dunning policy would fire on the second
  // attempt's invoices). Recovery is a fresh job: CI clones a pristine
  // template database per suite file.
  test.describe.configure({ retries: 0 });

  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error("e2e baseURL is required");
    const { context, page } = await authedContext(browser, baseURL);
    try {
      const req = page.request;
      const origin = baseURL;
      ok(
        await api(req, origin, "PUT", "/api/admin/setup/wizard", {
          name: "Subscription E2E Co",
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
        }),
        "wizard",
      );
      ok(
        await api(req, origin, "PUT", "/api/admin/setup/features", {
          features: { subscriptionBilling: true, revenueRecognition: true },
        }),
        "features",
      );
      storageState = await context.storageState();
    } finally {
      await context.close();
    }
  });

  async function freshPage(browser: Browser, baseURL: string | undefined) {
    if (!baseURL) throw new Error("e2e baseURL is required");
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

  /** Reload cross-chunk state when running a subset (--grep) after the seed. */
  function resume() {
    if (!S.orgId) loadState(S);
  }

  async function seedCustomer(
    page: Page,
    baseURL: string,
    name: string,
    email: string,
  ): Promise<string> {
    const req = page.request;
    const draft = ok(await api(req, baseURL, "POST", "/api/parties/draft", { role: "customer" }), "party draft");
    const id = str(draft.id);
    const current = ok(await api(req, baseURL, "GET", `/api/parties/${id}`), "party fetch");
    ok(
      await api(req, baseURL, "PATCH", `/api/parties/${id}`, {
        displayName: name,
        email,
        isActive: true,
        changeReason: "e2e subscription-to-revenue activation",
        expectedUpdatedAt: str((current.party as Record<string, unknown>).updated_at, "party revision"),
      }),
      "party activate",
    );
    return id;
  }

  test("seeds the subscription billing dataset", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const req = page.request;
      const origin = baseURL!;
      const t = (base: string) => tag(base);

      // Stale ladders from an earlier attempt would fire on this attempt's
      // invoices, so they are removed through the product route first.
      const existing = ok(await api(req, origin, "GET", "/api/dunning"), "dunning list");
      for (const p of ((existing.policies ?? []) as { id: string; name: string }[])) {
        if (p.name.startsWith("W5")) {
          ok(await api(req, origin, "DELETE", `/api/dunning/${p.id}`), "drop stale policy");
        }
      }

      // Deferred-revenue liability account (the template chart has none).
      const { randomUUID } = await import("node:crypto");
      const acctNum = deferredAccountNumber();
      const created = ok(
        await api(
          req,
          origin,
          "POST",
          "/api/accounts",
          { name: t("W5 Deferred Revenue"), type: "liability_current_other", number: acctNum },
          { "Idempotency-Key": randomUUID() },
        ),
        "deferred account",
        201,
      );
      S.deferredId = str((created.account as Record<string, unknown>).id, "deferred id");

      const options = ok(await api(req, origin, "GET", "/api/forms/options?source=gl_accounts"), "accounts");
      const byNumber = (n: string) =>
        ((options.options ?? []) as { value: string; label: string }[]).find((o) => o.label.startsWith(n));
      S.incomeId = str(byNumber("4100")?.value, "4100");
      S.bankId = str(byNumber("1000")?.value, "1000");

      // The ASC 606 recipe: 12-month straight line over the obligation term.
      const rule = ok(
        await api(req, origin, "POST", "/api/admin/setup/recognition-rules", {
          code: t("W5-SL12"),
          name: t("W5 12-month straight line"),
          method: "straight_line_even",
          recognitionPeriods: 12,
          startDateSource: "obligation",
          endDateSource: "term",
          deferredAccountId: S.deferredId,
          recognizedAccountId: S.incomeId,
          isActive: true,
        }),
        "recognition rule",
      );
      const ruleId = str(rule.id, "rule id");

      // Service item carrying the deferred treatment.
      const itemDraft = ok(await api(req, origin, "POST", "/api/items/draft", {}), "item draft");
      S.itemId = str(itemDraft.id, "item id");
      ok(
        await api(req, origin, "PATCH", `/api/items/${S.itemId}`, {
          name: t("W5 Annual Support"),
          kind: "service",
          defaultRate: "1.00",
          incomeAccountId: S.incomeId,
          deferredAccountId: S.deferredId,
          recognitionRuleId: ruleId,
          isActive: true,
        }),
        "item activate",
      );

      S.partyAId = await seedCustomer(page, origin, t("W5 Customer A"), "w5a@example.com");
      S.partyBId = await seedCustomer(page, origin, t("W5 Customer B"), "w5b@example.com");

      async function addPlan(name: string, amount: string): Promise<string> {
        const plan = ok(
          await api(req, origin, "POST", "/api/subscriptions", {
            action: "addPlan",
            name,
            amount,
            interval: "annually",
            intervalCount: 1,
            incomeAccountId: S.incomeId,
            itemId: S.itemId,
          }),
          `plan ${name}`,
          201,
        );
        return str(plan.id, "plan id");
      }
      const planA = await addPlan(t("W5 Plan A"), PLAN_A);
      const planB = await addPlan(t("W5 Plan B"), PLAN_B);

      async function subscribe(customerId: string, planId: string): Promise<string> {
        const sub = ok(
          await api(req, origin, "POST", "/api/subscriptions", {
            action: "addSubscription",
            customerId,
            planId,
            quantity: "1",
            startOn: "2026-01-01",
            firstBillOn: "2026-01-01",
            autoPost: false,
          }),
          "subscription",
          201,
        );
        return str(sub.id, "subscription id");
      }
      S.subAId = await subscribe(S.partyAId, planA);
      S.subBId = await subscribe(S.partyBId, planB);

      // The 4-rung collections ladder both customers live under.
      const policy = ok(
        await api(req, origin, "POST", "/api/dunning", {
          name: t("W5 Standard"),
          gracePeriodDays: 0,
          minBalance: "1.00",
          stages: [
            { sequence: 1, name: "Gentle reminder", offsetDays: 7, subjectTemplate: "Invoice {{invoice}} due", bodyTemplate: "Hi {{party}}, {{invoice}} for {{amount}} was due {{dueDate}}." },
            { sequence: 2, name: "Firm reminder", offsetDays: 14, subjectTemplate: "Overdue {{invoice}}", bodyTemplate: "Hi {{party}}, {{invoice}} is {{daysOverdue}} days overdue." },
            { sequence: 3, name: "Final notice", offsetDays: 30, subjectTemplate: "Final notice {{invoice}}", bodyTemplate: "Hi {{party}}, final notice for {{invoice}}." },
            { sequence: 4, name: "Escalation", offsetDays: 60, subjectTemplate: "Escalated {{invoice}}", bodyTemplate: "Escalated {{invoice}}.", escalate: true },
          ],
        }),
        "dunning policy",
        201,
      );
      expect(str(policy.id, "policy id")).toBeTruthy();

      // First invoices off each schedule. billNow mints the draft (with the
      // rev-rec item line); the draft is backdated through the product route
      // so the term is deterministic, then posted — A through the UI drawer,
      // B through the same API routes the drawer calls.
      async function billBackdate(subId: string, docDate: string, dueDate: string) {
        const bill = ok(await api(req, origin, "POST", "/api/subscriptions", { action: "billNow", id: subId }), "billNow");
        expect(bill.posted).toBe(false);
        const id = str(bill.invoiceId, "invoice id");
        const current = ok(await api(req, origin, "GET", `/api/documents/${id}`), "invoice fetch");
        const doc = docOf(current);
        expect(str(doc.status, "draft status")).toBe("draft");
        ok(
          await api(req, origin, "PATCH", `/api/documents/${id}`, {
            expectedUpdatedAt: str(doc.updated_at, "invoice revision"),
            documentDate: docDate,
            dueDate,
          }),
          "backdate",
        );
        return { id, number: str(bill.documentNumber, "invoice number") };
      }
      const invA = await billBackdate(S.subAId, "2026-01-15", "2026-02-14");
      S.invAId = invA.id;
      S.invANumber = invA.number;
      await uiSubmitAndPost(page, `/ar/invoices?doc=${S.invAId}`, "Open");
      const invB = await billBackdate(S.subBId, "2026-01-15", "2026-02-14");
      S.invBId = invB.id;
      S.invBNumber = invB.number;
      ok(await api(req, origin, "POST", "/api/documents/actions", { action: "submit", documentId: S.invBId }), "B submit");
      ok(await api(req, origin, "POST", "/api/documents/actions", { action: "post", documentId: S.invBId }), "B post");

      // Posted totals are exact; both carry the deferred treatment because
      // the schedule's item line survived the backdate untouched.
      for (const [id, total] of [[S.invAId, "1000.0000"], [S.invBId, "1200.0000"]] as const) {
        const fetched = ok(await api(req, origin, "GET", `/api/documents/${id}`), "posted fetch");
        const doc = docOf(fetched);
        expect(str(doc.status, "status")).toBe("posted");
        expect(str(doc.total, "total")).toBe(total);
      }

      // Invoice list shows both open balances.
      await page.goto("/ar/invoices");
      for (const [number, total] of [[S.invANumber, toCents("1000.00")], [S.invBNumber, toCents("1200.00")]] as const) {
        const row = page.locator("tr", { hasText: number }).first();
        await expect(row.getByText(fmtUSD(total)).first()).toBeVisible();
      }

      // The configured ladder is visible on the collections dunning tab.
      await page.goto("/collections");
      await page.getByRole("button", { name: /dunning/i }).click();
      const policyName = t("W5 Standard");
      await expect(page.getByText(policyName).first()).toBeVisible();
      await expect(page.getByText("4 stages").first()).toBeVisible();
      await expect(page.getByText("Day 7: Gentle reminder").first()).toBeVisible();
      await expect(page.getByText("Day 60: Escalation").first()).toBeVisible();

      S.orgId = await resolveOrgId();
      expect(S.orgId).toBeTruthy();
      saveState({ ...S });
    } finally {
      await context.close();
    }
  });

  test("recognises January: schedule math ties to the ledger", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL);
    try {
      resume();
      const req = page.request;
      const origin = baseURL!;
      const run = ok(
        await api(req, origin, "POST", "/api/revenue/run-recognition", { asOfDate: "2026-01-31" }),
        "january recognition",
      );
      expect(run.posted).toBe(2);
      expect(str(run.totalAmount, "jan total")).toBe("183.3334");
      const byContract = new Map(((run.entries ?? []) as { contract: string; obligation: string; amount: string }[]).map((e) => [e.contract, e]));
      // Plan A proves the residue-free split: 1000/12 opens with 83.3334.
      expect(byContract.get(S.invANumber)?.amount).toBe(A_FIRST);
      expect(byContract.get(S.invBNumber)?.amount).toBe(B_MONTH);

      // Resolve obligation ids for the scoped runs later (read probe — the
      // product route takes the id, the UI resolves it server-side).
      const oblIds = await resolveObligationIds(S.orgId, [S.invANumber, S.invBNumber]);
      S.oblAId = oblIds.get(S.invANumber) ?? "";
      S.oblBId = oblIds.get(S.invBNumber) ?? "";
      expect(S.oblAId).toBeTruthy();
      expect(S.oblBId).toBeTruthy();

      // Idempotent re-run: nothing new is due in January.
      const rerun = ok(
        await api(req, origin, "POST", "/api/revenue/run-recognition", { asOfDate: "2026-01-31" }),
        "january re-run",
      );
      expect(rerun.posted).toBe(0);
      expect(str(rerun.totalAmount, "rerun total")).toBe("0");

      // Contract drawers tell the truth: recognised vs deferred per schedule.
      await openDrawer(page, `/revenue?contract=${await contractIdFor(S.orgId, S.invANumber)}`);
      const drawerA = page.locator('[role="dialog"]').first();
      await expect(drawerA.getByText(S.invANumber).first()).toBeVisible();
      await expect(drawerA.getByText(fmt4(A_FIRST)).first()).toBeVisible();
      await expect(drawerA.getByText(fmt4(A_JAN_DEFERRED)).first()).toBeVisible();

      // Balance sheet at January: deferred equals the unrecognised remainder
      // computed in-test (2200 - 183.3334), not read back from the schedule.
      await page.goto("/reports/balance-sheet?period=custom&from=2026-01-01&to=2026-01-31");
      await expect(page.locator("table").first()).toContainText("Total Liabilities and Equity");
      const rows = await reportRows(page);
      const janRow = findRow(rows, "Deferred Revenue");
      expect(janRow[janRow.length - 1]).toBe(fmt4(DEFERRED_JAN));
      saveState({ ...S });
    } finally {
      await context.close();
    }
  });

  test("paid customer is never dunned; first rung fires on the overdue invoice", async ({ browser, baseURL }) => {
    resume();
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const req = page.request;
      const origin = baseURL!;
      // Customer A pays in full before anything is overdue. Re-entry guard:
      // an already-settled invoice is left alone (a second receipt would
      // overpay it); stale unposted drafts from a dead chunk never applied.
      const oiA = ok(await api(req, origin, "GET", `/api/payments/open-items?partyId=${S.partyAId}&side=ar`), "open items A");
      const aOpen = ((oiA.items ?? []) as { documentNumber: string; open: string }[]).find(
        (i) => i.documentNumber === S.invANumber,
      )?.open;
      if (aOpen !== undefined && aOpen !== "0.0000") {
        const sug = ok(
          await api(req, origin, "POST", "/api/payments/suggest", {
            partyId: S.partyAId, amount: "1000.00", side: "ar", currency: "USD",
          }),
          "suggest A",
        );
        const draft = ok(await api(req, origin, "POST", "/api/payments/draft", { kind: "customer_payment" }), "receipt draft");
        S.receiptAId = str(draft.id, "receipt id");
        const current = ok(await api(req, origin, "GET", `/api/payments/${S.receiptAId}`), "receipt fetch");
        ok(
          await api(req, origin, "PATCH", `/api/payments/${S.receiptAId}`, {
            partyId: S.partyAId,
            bankAccountId: S.bankId,
            documentDate: "2026-02-10",
            expectedUpdatedAt: str(docOf(current).updated_at, "receipt revision"),
            allocations: sug.allocations,
          }),
          "receipt fill",
        );
        await apiPostReceipt(req, origin, S.receiptAId);
      }
      await openDrawer(page, `/ar/invoices?doc=${S.invAId}`);
      await expect(page.locator('[role="dialog"]').first().getByText(fmtUSD(0n)).first()).toBeVisible();

      // Seven days past due: the ladder fires exactly rung 1 on B only.
      const first = await runDunning(S.orgId, "2026-02-21");
      expect(first.scanned).toBeGreaterThan(0);
      expect(first.sent).toBe(1);
      expect(first.notices[0]?.documentId).toBe(S.invBId);
      let log = await readDunningLog(S.orgId);
      expect(log.filter((r) => r.documentNumber === S.invANumber)).toHaveLength(0);
      const bRows = log.filter((r) => r.documentNumber === S.invBNumber);
      expect(bRows).toHaveLength(1);
      expect(bRows[0]?.sequence).toBe(1);
      expect(bRows[0]?.stageName).toBe("Gentle reminder");
      expect(bRows[0]?.amountDue).toBe("1200.0000");
      expect(bRows[0]?.status).toBe("sent");
      // The staged email carries the rendered variables, not the template.
      const outbox = await readDunningOutbox(S.orgId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.to).toContain("w5b@example.com");
      expect(outbox[0]?.subject).toContain(S.invBNumber);

      // Re-running the same day double-sends nothing.
      const repeat = await runDunning(S.orgId, "2026-02-21");
      expect(repeat.sent).toBe(0);
      log = await readDunningLog(S.orgId);
      expect(log.filter((r) => r.documentNumber === S.invBNumber)).toHaveLength(1);
      saveState({ ...S });
    } finally {
      await context.close();
    }
  });

  test("the ladder advances one rung per threshold, never re-sending", async () => {
    resume();
    const second = await runDunning(S.orgId, "2026-02-28");
    expect(second.sent).toBe(1);
    expect(second.notices[0]?.documentId).toBe(S.invBId);
    const log = await readDunningLog(S.orgId);
    const bRows = log.filter((r) => r.documentNumber === S.invBNumber);
    expect(bRows).toHaveLength(2);
    expect(bRows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(bRows[1]?.stageName).toBe("Firm reminder");
    expect(bRows[1]?.amountDue).toBe("1200.0000");
    expect(log.filter((r) => r.documentNumber === S.invANumber)).toHaveLength(0);
  });

  test("February and March recognition keep deferred tied to the remainder", async ({ browser, baseURL }) => {
    resume();
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const req = page.request;
      const origin = baseURL!;
      for (const asOf of ["2026-02-28", "2026-03-31"]) {
        const run = ok(await api(req, origin, "POST", "/api/revenue/run-recognition", { asOfDate: asOf }), `recognition ${asOf}`);
        expect(run.posted).toBe(2);
        expect(str(run.totalAmount, "total")).toBe("183.3334");
      }
      // In-test math: A recognised 3 x 83.3334, B recognised 3 x 100.
      await openDrawer(page, `/revenue?contract=${await contractIdFor(S.orgId, S.invANumber)}`);
      const drawerA = page.locator('[role="dialog"]').first();
      await expect(drawerA.getByText(fmt4(A_JAN_MAR)).first()).toBeVisible();
      await expect(drawerA.getByText(fmt4(A_APR_DEC)).first()).toBeVisible();
      await openDrawer(page, `/revenue?contract=${await contractIdFor(S.orgId, S.invBNumber)}`);
      const drawerB = page.locator('[role="dialog"]').first();
      await expect(drawerB.getByText(fmt4(B_JAN_MAR)).first()).toBeVisible();
      await expect(drawerB.getByText(fmt4(B_CREDIT)).first()).toBeVisible();

      // AR aging at March: B is 45 days past due for the full 1,200.00 —
      // the genuinely overdue open balance the ladder is acting on.
      await page.goto("/reports/aging?period=custom&from=2026-03-01&to=2026-03-31&side=ar");
      await expect(page.locator("table").first()).toContainText("W5 Customer B");
      const aging = await reportRows(page);
      const bRow = findRow(aging, "W5 Customer B");
      expect(bRow[3]).toBe(fmtUSD(toCents("1200.00")));
      expect(bRow[bRow.length - 1]).toBe(fmtUSD(toCents("1200.00")));

      // Balance sheet at March: 2200 - 250.0002 - 300, computed in-test.
      await page.goto("/reports/balance-sheet?period=custom&from=2026-03-01&to=2026-03-31");
      await expect(page.locator("table").first()).toContainText("Total Liabilities and Equity");
      const rows = await reportRows(page);
      const defRow = findRow(rows, "Deferred Revenue");
      expect(defRow[defRow.length - 1]).toBe(fmt4(DEFERRED_MAR));
      saveState({ ...S });
    } finally {
      await context.close();
    }
  });

  test("the third rung fires at thirty days overdue", async () => {
    resume();
    const third = await runDunning(S.orgId, "2026-03-16");
    expect(third.sent).toBe(1);
    const log = await readDunningLog(S.orgId);
    const bRows = log.filter((r) => r.documentNumber === S.invBNumber);
    expect(bRows).toHaveLength(3);
    expect(bRows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(bRows[2]?.stageName).toBe("Final notice");
    expect(bRows[2]?.amountDue).toBe("1200.0000");
  });

  test("mid-term credit unwinds the unearned balance and spares earned revenue", async ({ browser, baseURL }) => {
    resume();
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const req = page.request;
      const origin = baseURL!;
      // Re-entry guards: reuse a posted-but-unapplied credit from a dead
      // chunk (drafting again would double-credit), and skip seeding
      // entirely when a previous chunk already settled the invoice — ids are
      // recovered through the party-docs probe for the audit assertions.
      const oiFirst = ok(await api(req, origin, "GET", `/api/payments/open-items?partyId=${S.partyBId}&side=ar`), "open items first");
      const ciFirst = ok(await api(req, origin, "GET", `/api/payments/credit-items?partyId=${S.partyBId}&side=ar`), "credit items first");
      const bOpenFirst = ((oiFirst.items ?? []) as { documentNumber: string }[]).some((i) => i.documentNumber === S.invBNumber);
      const existingCredit = ((ciFirst.items ?? []) as { documentId: string; documentNumber: string }[])[0];
      let settled = false;
      if (!bOpenFirst && !existingCredit) {
        settled = true;
        for (const d of await partyDocs(S.orgId, S.partyBId)) {
          if (d.kind === "customer_credit" && d.status === "posted") {
            S.creditId = d.id;
            S.creditNumber = d.number;
          }
          if (d.kind === "customer_payment" && d.status === "posted") {
            S.receiptBId = d.id;
            S.receiptBNumber = d.number;
          }
        }
        expect(S.creditId, "recovered credit id").toBeTruthy();
        expect(S.receiptBId, "recovered receipt id").toBeTruthy();
      } else if (existingCredit) {
        S.creditId = str(existingCredit.documentId, "reused credit id");
        S.creditNumber = str(existingCredit.documentNumber, "reused credit number");
      }
      if (!settled && !existingCredit) {
        // Credit memo for the nine unearned months, booked straight to the
        // deferred account, posted through the UI drawer.
        const draft = ok(await api(req, origin, "POST", "/api/documents/draft", { kind: "customer_credit" }), "credit draft");
        S.creditId = str(draft.id, "credit id");
        S.creditNumber = str(draft.documentNumber, "credit number");
        const current = ok(await api(req, origin, "GET", `/api/documents/${S.creditId}`), "credit fetch");
        const patched = ok(
          await api(req, origin, "PATCH", `/api/documents/${S.creditId}`, {
            expectedUpdatedAt: str(docOf(current).updated_at, "credit revision"),
            partyId: S.partyBId,
            documentDate: "2026-04-05",
            lines: [{ accountId: S.deferredId, description: "Cancel remaining term", quantity: "1", unitPrice: B_CREDIT, amount: B_CREDIT }],
          }),
          "credit fill",
        );
        expect(str(docOf(patched).total, "credit total")).toBe("900.0000");
        await uiSubmitAndPost(page, `/ar/invoices?doc=${S.creditId}`, "Posted");
      }

      // One receipt clears the invoice: $300 cash for the earned quarter plus
      // the $900 credit memo (posted through the receipt route; every balance
      // below is asserted on rendered pages).
      const oi = settled
        ? { items: [] as { documentNumber: string; lineId: string }[] }
        : ok(await api(req, origin, "GET", `/api/payments/open-items?partyId=${S.partyBId}&side=ar`), "open items");
      const invLine = (oi.items as { documentNumber: string; lineId: string }[]).find((i) => i.documentNumber === S.invBNumber);
      const ci = settled
        ? { items: [] as { lineId: string }[] }
        : ok(await api(req, origin, "GET", `/api/payments/credit-items?partyId=${S.partyBId}&side=ar`), "credit items");
      const creditLine = (ci.items as { lineId: string }[])[0];
      if (!settled) {
        expect(str(creditLine?.lineId, "credit line")).toBeTruthy();
      const payDraft = ok(await api(req, origin, "POST", "/api/payments/draft", { kind: "customer_payment" }), "pay draft");
      S.receiptBId = str(payDraft.id, "pay id");
      S.receiptBNumber = str(payDraft.documentNumber, "pay number");
      const payCurrent = ok(await api(req, origin, "GET", `/api/payments/${S.receiptBId}`), "pay fetch");
      ok(
        await api(req, origin, "PATCH", `/api/payments/${S.receiptBId}`, {
          partyId: S.partyBId,
          bankAccountId: S.bankId,
          documentDate: "2026-04-06",
          expectedUpdatedAt: str(docOf(payCurrent).updated_at, "pay revision"),
          allocations: [{
            openLineId: str(invLine?.lineId, "invoice line"),
            sourceTransactionAmount: B_CASH,
            targetTransactionAmount: B_CASH,
            settlementRate: "1",
            settlementRateSource: "same_currency",
            settlementRateReference: "same transaction currency",
          }],
          creditAllocations: [{
            fromLineId: str(creditLine?.lineId, "credit line"),
            toLineId: str(invLine?.lineId, "invoice line"),
            amount: B_CREDIT,
            sourceDocumentId: S.creditId,
          }],
        }),
        "pay fill",
      );
      await apiPostReceipt(req, origin, S.receiptBId);
      }

      // The receivable is exactly gone and the credit fully consumed.
      await page.goto("/ar/invoices");
      const paidRow = page.locator("tr", { hasText: S.invBNumber }).first();
      await expect(paidRow.getByText(fmtUSD(0n)).first()).toBeVisible();
      const ciAfter = ok(await api(req, origin, "GET", `/api/payments/credit-items?partyId=${S.partyBId}&side=ar`), "credit items after");
      expect((ciAfter.items as unknown[]).length).toBe(0);

      // Deferred now holds only plan A's remainder (in-test: 1649.9998-900).
      await page.goto("/reports/balance-sheet?period=custom&from=2026-04-01&to=2026-04-30");
      await expect(page.locator("table").first()).toContainText("Total Liabilities and Equity");
      const rows = await reportRows(page);
      const defRow = findRow(rows, "Deferred Revenue");
      expect(defRow[defRow.length - 1]).toBe(fmt4(DEFERRED_APR));

      // April P&L moves nothing: the credit hit deferred, never revenue —
      // earned revenue is not clawed back. Zero movement renders as "–".
      await page.goto("/reports/pnl?period=custom&from=2026-04-01&to=2026-04-30");
      await expect(page.locator("table").first()).toContainText("Net income");
      const pnl = await reportRows(page);
      const aprilNet = findRow(pnl, "Net income");
      expect(aprilNet[aprilNet.length - 1]).toBe("–");
      expect(pnl.some((r) => r[0]?.includes("Service Revenue"))).toBe(false);

      // The drawer still shows the leftover plan honestly (F-w5-001): 300.00
      // recognised of 1,200.00 planned — the GL is unwound, the plan is not
      // retired, and no product route retires it.
      await openDrawer(page, `/revenue?contract=${await contractIdFor(S.orgId, S.invBNumber)}`);
      const drawerB = page.locator('[role="dialog"]').first();
      await expect(drawerB.getByText(fmt4(B_JAN_MAR)).first()).toBeVisible();
      await expect(drawerB.getByText(fmt4(B_CREDIT)).first()).toBeVisible();
      saveState({ ...S });
    } finally {
      await context.close();
    }
  });

  test("cancel stops future billing; the full term sums exactly with no double-post", async ({ browser, baseURL }) => {
    resume();
    const { context, page } = await freshPage(browser, baseURL);
    try {
      const req = page.request;
      const origin = baseURL!;
      ok(
        await api(req, origin, "POST", "/api/subscriptions", { action: "updateSubscription", id: S.subBId, status: "canceled" }),
        "cancel B",
      );
      const subs = ok(await api(req, origin, "GET", "/api/subscriptions"), "subs after cancel");
      expect((subs.subscriptions as { id: string; status: string }[]).find((s) => s.id === S.subBId)?.status).toBe("canceled");

      // Billing a cancelled schedule mints nothing new: the run returns the
      // existing period invoice instead of a second document.
      const rebill = await api(req, origin, "POST", "/api/subscriptions", { action: "billNow", id: S.subBId });
      expect(rebill.status).toBe(200);
      expect(str(rebill.json?.invoiceId, "rebill invoice")).toBe(S.invBId);

      // Plan A recognises to term end: Apr–Dec posts 749.9998, so the full
      // twelve months sum to exactly 1,000.00 — no residue in the last period.
      const full = ok(
        await api(req, origin, "POST", "/api/revenue/run-recognition", { asOfDate: "2026-12-31", obligationId: S.oblAId }),
        "full-term A",
      );
      expect(full.posted).toBe(9);
      expect(str(full.totalAmount, "full total")).toBe(A_APR_DEC);
      const again = ok(
        await api(req, origin, "POST", "/api/revenue/run-recognition", { asOfDate: "2026-12-31", obligationId: S.oblAId }),
        "full-term A re-run",
      );
      expect(again.posted).toBe(0);

      // Re-running an already-recognised period for B posts nothing either.
      const bAgain = ok(
        await api(req, origin, "POST", "/api/revenue/run-recognition", { asOfDate: "2026-03-31", obligationId: S.oblBId }),
        "B march re-run",
      );
      expect(bAgain.posted).toBe(0);

      // The drawer proves the exact sum: 1,000.00 recognised, 0.00 deferred.
      await openDrawer(page, `/revenue?contract=${await contractIdFor(S.orgId, S.invANumber)}`);
      const drawerA = page.locator('[role="dialog"]').first();
      await expect(drawerA.getByText(fmtUSD(toCents(PLAN_A))).first()).toBeVisible();
      await expect(drawerA.getByText(fmtUSD(0n)).first()).toBeVisible();

      // And through the drawer's own Run button: nothing left to recognise.
      const runButton = drawerA.getByRole("button", { name: /run recognition/i });
      await runButton.click();
      await expect(page.getByText("Nothing due to recognize").first()).toBeVisible({ timeout: 20000 });
      saveState({ ...S });
    } finally {
      await context.close();
    }
  });

  test("dunning stays silent on settled balances and the year ties out", async ({ browser, baseURL }) => {
    resume();
    const { context, page } = await freshPage(browser, baseURL);
    try {
      // Sixty days past due, both invoices fully applied: the ladder has
      // nothing genuinely overdue, so it sends nothing.
      const late = await runDunning(S.orgId, "2026-04-15");
      expect(late.sent).toBe(0);
      const log = await readDunningLog(S.orgId);
      expect(log.filter((r) => r.documentNumber === S.invBNumber)).toHaveLength(3);
      expect(log.filter((r) => r.documentNumber === S.invANumber)).toHaveLength(0);

      // AR aging is clean for both customers.
      await page.goto("/reports/aging?period=custom&from=2026-04-01&to=2026-04-30&side=ar");
      await expect(page.locator("tr", { hasText: "W5 Customer A" })).toHaveCount(0);
      await expect(page.locator("tr", { hasText: "W5 Customer B" })).toHaveCount(0);

      // Trial balance over the full year: every leg exact, totals balanced.
      const year = "period=custom&from=2026-01-01&to=2026-12-31";
      await page.goto(`/reports/trial-balance?${year}`);
      await expect(page.locator("table").first()).toContainText("Totals");
      const tb = await reportRows(page);
      {
        const bankRow = findRow(tb, "Operating Bank Account");
        expect(bankRow[2]).toBe(fmtUSD(toCents("1300.00")));
        expect(bankRow[4]).toBe(fmtUSD(toCents("1300.00")));
        const arRow = findRow(tb, "Accounts Receivable");
        expect(arRow[2]).toBe(arRow[3]);
        expect(arRow[4]).toBe(fmtUSD(0n));
        const defRow = findRow(tb, "Deferred Revenue");
        expect(defRow[2]).toBe(defRow[3]);
        expect(defRow[4]).toBe(fmtUSD(0n));
        const revRow = findRow(tb, "Service Revenue");
        expect(revRow[3]).toBe(fmtUSD(toCents("1300.00")));
        expect(revRow[4]).toBe("($1,300.00)");
        const totalsRow = findRow(tb, "Totals");
        expect(totalsRow[2]).toBe(totalsRow[3]);
        expect(totalsRow[totalsRow.length - 1]).toBe(fmtUSD(0n));
      }

      // Balance sheet: 1,300.00 of cash against nothing deferred — the
      // unwound account leaves the statement entirely (zero rows omitted).
      await page.goto(`/reports/balance-sheet?${year}`);
      await expect(page.locator("table").first()).toContainText("Total Liabilities and Equity");
      const bs = await reportRows(page);
      expect(findRow(bs, "Total Assets")).toContain(fmtUSD(toCents("1300.00")));
      expect(findRow(bs, "Total Liabilities and Equity")).toContain(fmtUSD(toCents("1300.00")));
      await expect(page.locator("tr", { hasText: "Deferred Revenue" })).toHaveCount(0);

      // P&L: exactly the earned 1,000.00 + 300.00, never the credited 900.00.
      await page.goto(`/reports/pnl?${year}`);
      await expect(page.locator("table").first()).toContainText("Net income");
      const pnl = await reportRows(page);
      expect(findRow(pnl, "Net income")).toContain(fmtUSD(toCents("1300.00")));

      // Audit trails record each lifecycle on its own document.
      const invoiceAudit = await auditActions(page, `/ar/invoices?doc=${S.invAId}`);
      expect(invoiceAudit).toContain("Created");
      expect(invoiceAudit).toContain("Posted");
      const creditAudit = await auditActions(page, `/ar/invoices?doc=${S.creditId}`);
      expect(creditAudit).toContain("Created");
      expect(creditAudit).toContain("Posted");
      const receiptAudit = await auditActions(page, `/receipts?payment=${S.receiptBId}`);
      expect(receiptAudit).toContain("Created");
      expect(receiptAudit).toContain("Posted");
    } finally {
      await context.close();
    }
  });

});
