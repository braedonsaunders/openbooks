import { test } from "@playwright/test";
import { authedContext, dismissSetupWizard } from "../auth";
import {
  AMT,
  APPROVER_EMAIL,
  APPROVER_PASSWORD,
  api,
  field,
  expect,
  draftSeedDocument,
  extractPdfText,
  ok,
  postSeedDocument,
  postSeedJournal,
  revisionToken,
  targetPeriods,
  type Seed,
} from "./support/close-to-reporting";

/**
 * E2E workflow: close to reporting.
 *
 * Against the CI-bootstrapped tenant (same browser job, same session pattern
 * as smoke.spec.ts): seed a deterministic ledger through the real product
 * HTTP routes, then drive the real UI pages — period close (readiness,
 * approval, lock), the six-report package, PDF exports, publish binder,
 * controlled reopen, adjusting entry, re-close — asserting exact amounts and
 * the actor/before/after audit trail at every state.
 *
 * Design notes (read before editing):
 * - Seeding uses `page.request` against the same API routes the UI calls
 *   (instant-into-draft + PATCH + post), never direct SQL: the ledger under
 *   test is posted by the real kernel, fences included.
 * - IDs the API never lists (primary book, period) are resolved the way an
 *   operator would: the /close period row's book select, and a posted
 *   document's `posting_period_id`.
 * - The suite needs two actors (independent close approval + independent
 *   reopen decision are product invariants). The browser job seeds
 *   `approver@openbooks.test` before specs run; both sessions log in through
 *   the real /api/login with no bypass.
 * - Advanced close is enabled in-seed via the product features API because
 *   publish/binder/delivery only exist under it; the owner-managed path
 *   cannot produce the assigned arc.
 * - The posting fence only blocks on `closed` locks, so the refusal proofs
 *   run AFTER `close`, not before — that ordering is the product's design.
 * - Amounts are exact decimal strings throughout; no floats anywhere.
 */

const PERIODS = targetPeriods();
const P = PERIODS.p;
const P1 = PERIODS.p1;

const SEED: Seed = {
  orgId: "",
  rootSubId: "",
  subBId: "",
  primaryBookId: "",
  adjustingBookId: "",
  periodId: "",
  priorPeriodId: "",
  customerAId: "",
  customerBId: "",
  vendorAId: "",
  projectId: "",
  assetId: "",
  runId: "",
  accounts: {},
};

test.describe.serial("close to reporting", () => {
  // No retries: this is a stateful saga, and retrying it mid-flight would
  // double-post the deterministic seed. A failure aborts the file; recovery
  // is a fresh job (the browser job bootstraps a pristine tenant per run).
  test.describe.configure({ retries: 0 });
  test("seeds the deterministic close dataset", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const { context, page } = await authedContext(browser, baseURL);
    try {
      const req = page.request;
      const origin = baseURL!;

      // 1. Complete first-run setup: industry chart of accounts + control
      //    accounts in one audited transaction (the real onboarding path).
      const wizard = ok(
        await api(req, origin, "PUT", "/api/admin/setup/wizard", {
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
        }),
        "wizard",
      );
      expect(wizard.ok).toBe(true);

      // 2. Features the workflow needs: a second legal entity and the
      //    advanced close controls (publish/binder/independent approval).
      ok(
        await api(req, origin, "PUT", "/api/admin/setup/features", {
          features: { multiSubsidiary: true, advancedClose: true },
        }),
        "features",
      );

      // 3. Second subsidiary (child of root) and the adjusting book.
      // The root subsidiary id is what a fresh draft defaults to.
      const rootDraft = ok(await api(req, origin, "POST", "/api/journals/draft", {}), "root draft");
      const rootFetched = ok(await api(req, origin, "GET", `/api/journals/${rootDraft.id}`), "root draft fetch");
      SEED.rootSubId = field(rootFetched.doc as Record<string, unknown>, "subsidiary_id", "root draft");
      // The probe draft must not survive: an unposted draft with no period is
      // a critical readiness exception, and this suite asserts a clean gate.
      ok(await api(req, origin, "DELETE", `/api/journals/${rootDraft.id}`), "drop probe draft");
      const subB = ok(
        await api(req, origin, "POST", "/api/admin/setup/subsidiaries", {
          name: "Harbour Subsidiary",
          baseCurrency: "USD",
          country: "US",
          parentId: SEED.rootSubId,
          isActive: true,
        }),
        "subsidiary",
      );
      SEED.subBId = subB.id as string;
      const book = ok(
        await api(req, origin, "POST", "/api/admin/setup/accounting-books", {
          code: "adjusting",
          name: "Adjusting book",
          postsGl: true,
        }),
        "adjusting book",
      );
      SEED.adjustingBookId = book.id as string;

      // 4. Resolve the template chart by number (the pickers the UI uses).
      const options = ok(await api(req, origin, "GET", "/api/forms/options?source=gl_accounts"), "accounts");
      for (const opt of (options.options ?? []) as { value: string; label: string }[]) {
        const number = opt.label.split(" ")[0]!;
        SEED.accounts[number] = opt.value;
      }
      for (const n of ["1000", "3000", "4000", "4100", "5000", "6100", "6300", "6500", "6600", "2100"]) {
        expect(SEED.accounts[n], `account ${n}`).toBeTruthy();
      }

      // 5. Parties: two customers, one vendor. A party only transacts
      // with a non-root subsidiary listed on its entity record.
      async function party(role: string, name: string, extraSubs: string[] = []) {
        const draft = ok(await api(req, origin, "POST", "/api/parties/draft", { role }), `${role} draft`);
        const id = draft.id as string;
        const current = ok(await api(req, origin, "GET", `/api/parties/${id}`), `${role} fetch`);
        const party = current.party as Record<string, string>;
        ok(
          await api(req, origin, "PATCH", `/api/parties/${id}`, {
            displayName: name,
            isActive: true,
            changeReason: "activate seeded close-to-reporting party",
            expectedUpdatedAt: party.updated_at,
            ...(extraSubs.length ? { additionalSubsidiaryIds: extraSubs } : {}),
          }),
          `${role} activate`,
        );
        return id;
      }
      SEED.customerAId = await party("customer", "Harbourlight Foods");
      SEED.customerBId = await party("customer", "Beacon Grocers", [SEED.subBId]);
      SEED.vendorAId = await party("vendor", "Northbeam Supplies");

      // 6. Project for the profitability report.
      const projectDraft = ok(await api(req, origin, "POST", "/api/projects/draft", {}), "project draft");
      SEED.projectId = projectDraft.id as string;
      ok(
        await api(req, origin, "PATCH", `/api/projects/${SEED.projectId}`, {
          name: "Harbour Kitchen Refit",
          code: "HKR-01",
          isActive: true,
        }),
        "project activate",
      );

      // 7. Posting documents across both subsidiaries (all stay open: the
      //    AR/AP aging assertions need unpaid balances at report time).
      const postDocument = (kind: string, patch: Record<string, unknown>) =>
        postSeedDocument(req, origin, kind, patch);
      const revA = SEED.accounts["4100"]!;
      const revB = SEED.accounts["4000"]!;
      const expA = SEED.accounts["6100"]!;
      await postDocument("customer_invoice", {
        partyId: SEED.customerAId,
        subsidiaryId: SEED.rootSubId,
        documentDate: `${P.from.slice(0, 8)}12`,
        dueDate: `${P.from.slice(0, 8)}28`,
        lines: [{ accountId: revA, description: "Consulting services", quantity: "1", unitPrice: AMT.invoiceA, amount: AMT.invoiceA }],
      });
      const invB = await postDocument("customer_invoice", {
        partyId: SEED.customerBId,
        subsidiaryId: SEED.subBId,
        documentDate: `${P.from.slice(0, 8)}14`,
        dueDate: `${P.from.slice(0, 8)}28`,
        lines: [{ accountId: revB, description: "Wholesale order", quantity: "1", unitPrice: AMT.invoiceB, amount: AMT.invoiceB }],
      });
      await postDocument("vendor_bill", {
        partyId: SEED.vendorAId,
        subsidiaryId: SEED.rootSubId,
        documentDate: `${P.from.slice(0, 8)}15`,
        dueDate: `${P.from.slice(0, 8)}28`,
        lines: [{ accountId: expA, description: "Rent", quantity: "1", unitPrice: AMT.billA, amount: AMT.billA }],
      });
      // The bill's posting period resolves the target period id.
      const bill = ok(await api(req, origin, "GET", `/api/documents/${invB}`), "period resolve");
      SEED.periodId = field(bill.doc as Record<string, unknown>, "posting_period_id", "invoice");

      const postJournal = (subsidiaryId: string, documentDate: string, memo: string, lines: { account: string; amount: string; description: string; project?: boolean }[]) =>
        postSeedJournal(req, origin, SEED.accounts, {
          subsidiaryId,
          documentDate,
          memo,
          lines: lines.map((l) => ({ ...l, ...(l.project ? { projectId: SEED.projectId } : {}) })),
        });
      const C = (n: string) => n;
      await postJournal(SEED.rootSubId, `${P.from.slice(0, 8)}05`, "Owner funding", [
        { account: C("1000"), amount: AMT.funding, description: "Cash in" },
        { account: C("3000"), amount: `-${AMT.funding}`, description: "Share capital" },
      ]);
      await postJournal(SEED.subBId, `${P.from.slice(0, 8)}20`, "Office supplies", [
        { account: C("6300"), amount: AMT.supplies, description: "Supplies" },
        { account: C("1000"), amount: `-${AMT.supplies}`, description: "Cash out" },
      ]);
      await postJournal(SEED.rootSubId, `${P.from.slice(0, 8)}10`, "Project revenue", [
        { account: C("1000"), amount: AMT.projectRevenue, description: "Project receipt", project: true },
        { account: C("4100"), amount: `-${AMT.projectRevenue}`, description: "Project revenue", project: true },
      ]);
      await postJournal(SEED.rootSubId, `${P.from.slice(0, 8)}11`, "Project cost", [
        { account: C("5000"), amount: AMT.projectCost, description: "Project materials", project: true },
        { account: C("1000"), amount: `-${AMT.projectCost}`, description: "Cash out", project: true },
      ]);
      const priorId = await postJournal(SEED.rootSubId, `${P1.from.slice(0, 8)}15`, "Prior month revenue", [
        { account: C("1000"), amount: AMT.priorRevenue, description: "Cash in" },
        { account: C("4100"), amount: `-${AMT.priorRevenue}`, description: "Revenue" },
      ]);
      const prior = ok(await api(req, origin, "GET", `/api/journals/${priorId}`), "prior period resolve");
      SEED.priorPeriodId = field(prior.doc as Record<string, unknown>, "posting_period_id", "prior journal");
      expect(SEED.periodId, "target period resolved").toBeTruthy();
      expect(SEED.priorPeriodId, "prior period resolved").toBeTruthy();
      expect(SEED.priorPeriodId).not.toBe(SEED.periodId);

      // 8. Equipment + depreciation: the product's depreciation run posts to
      //    every active book, which is how the adjusting book earns entries.
      const assetDraft = ok(await api(req, origin, "POST", "/api/assets/draft", {}), "asset draft");
      SEED.assetId = assetDraft.id as string;
      const assetToken = await revisionToken(req, origin, `/api/assets/${SEED.assetId}`, (d) => field(d.asset as Record<string, unknown>, "updated_at", "asset"));
      ok(
        await api(req, origin, "PATCH", `/api/assets/${SEED.assetId}`, {
          expectedUpdatedAt: assetToken,
          name: "Commissary Server",
          acquisitionCost: "120000.00",
          acquiredOn: `${P.from.slice(0, 8)}01`,
          inServiceOn: `${P.from.slice(0, 8)}01`,
          method: "straight_line",
          lifeMonths: 12,
          status: "in_service",
        }),
        "asset place in service",
      );
      const depreciation = ok(
        await api(req, origin, "POST", "/api/assets/run-depreciation", {
          asOfDate: P.to,
          assetId: SEED.assetId,
        }),
        "depreciation",
      );
      expect(depreciation.posted, JSON.stringify(depreciation)).toBe(2);

      // 9. Bank statement import + auto-match + sign-off for cash (1000), so
      //    the bank readiness gate is genuinely satisfied, not vacant.
      const csv = [
        "date,description,amount",
        `${P1.from.slice(0, 8)}15,Prior month receipt,${AMT.priorRevenue}`,
        `${P.from.slice(0, 8)}05,Owner funding,${AMT.funding}`,
        `${P.from.slice(0, 8)}10,Project receipt,${AMT.projectRevenue}`,
        `${P.from.slice(0, 8)}11,Project materials,-${AMT.projectCost}`,
        `${P.from.slice(0, 8)}20,Office supplies,-${AMT.supplies}`,
      ].join("\n");
      const imported = ok(
        await api(req, origin, "POST", "/api/banking/import", {
          source: "csv",
          mode: "import",
          text: csv,
          accountId: SEED.accounts["1000"],
          statementDate: P.to,
          openingBalance: "0.00",
          closingBalance: "32500.00",
          mapping: { date: 0, description: 1, amount: 2 },
        }),
        "bank import",
      );
      expect(imported.imported).toBe(5);
      const recon = ok(
        await api(req, origin, "POST", "/api/banking/reconciliations", {
          accountId: SEED.accounts["1000"],
          throughDate: P.to,
          statementBalance: "32500.00",
        }),
        "reconciliation",
      );
      const matched = ok(
        await api(req, origin, "POST", `/api/banking/reconciliations/${recon.id}/auto-match`, {}),
        "auto-match",
      );
      expect(field(matched.totals as Record<string, unknown>, "difference", "reconciliation")).toBe("0.0000");
      ok(await api(req, origin, "POST", `/api/banking/reconciliations/${recon.id}/sign-off`, {}), "sign-off");
    } finally {
      await context.close();
    }
  });

  test("starts the close run from the period list and shows a clear readiness", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      // The fiscal-year filter defaults to the current year; a January run
      // would target December of the prior year, so pin it explicitly.
      await page.goto(`/close?fy=${P.name.slice(0, 4)}`);
      await dismissSetupWizard(page);
      const row = page.locator("tr", { hasText: P.name }).first();
      await expect(row).toBeVisible();
      // The book picker is a custom listbox over a native select: read the
      // options (values are book ids) from any unstarted row, untouched —
      // Primary is the default selection, the book under test.
      const bookOptions = await page.locator("tr select option").evaluateAll((els) =>
        els.map((e) => ({ value: (e as HTMLOptionElement).value, label: (e.textContent ?? "").trim() })),
      );
      SEED.primaryBookId = bookOptions.find((o) => o.label.includes("Primary"))?.value ?? "";
      expect(SEED.primaryBookId, "primary book resolved").toBeTruthy();
      const resume = row.getByRole("link", { name: "Resume" });
      if (await resume.isVisible()) {
        // Dirty tenant (local re-run): follow the existing run instead of
        // starting a second one. CI tenants are pristine, so CI always
        // exercises the Start path below.
        SEED.runId = new URL((await resume.getAttribute("href")) ?? "", baseURL).searchParams.get("run") ?? "";
      } else {
        const started = page.waitForURL(/\/close\?run=[0-9a-f-]+/);
        await row.getByRole("button", { name: "Start close" }).click();
        await started;
        SEED.runId = new URL(page.url()).searchParams.get("run") ?? "";
      }
      expect(SEED.runId, "run started").toBeTruthy();

      // Readiness data: zero blocking exceptions. The score sits below 100
      // while the manual cutoff tasks are open (83 on this seed) — that gap
      // is the next test's business, not an exception. The wizard renders
      // the same refresh payload the approval gate enforces.
      const refreshed = ok(
        await api(page.request, baseURL!, "POST", `/api/close/runs/${SEED.runId}`, { action: "refresh" }),
        "refresh",
      );
      // Exactly one open exception: the material-variance WARNING the seed
      // is designed to produce (six accounts jump from zero to five figures
      // against an empty prior month). It proves readiness is evaluating,
      // not vacant — while no error/critical blocks the gate.
      expect(refreshed.openExceptions).toBe(1);
      await page.goto(`/close?run=${SEED.runId}&stage=readiness`);
      await expect(page.getByText(new RegExp(`${refreshed.readinessScore}\\s*%`)).first()).toBeVisible();
      await expect(page.getByText("In progress").first()).toBeVisible();
      await expect(page.getByText("Warning", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Critical", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Error", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("hard gates refuse approval before cutoffs are done, then release", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      // Negative proof first: the gate must bite while manual cutoffs are open.
      const refused = await api(page.request, baseURL!, "POST", `/api/close/runs/${SEED.runId}`, {
        action: "request_approval",
      });
      expect(refused.status).toBe(422);
      expect(String((refused.json as Record<string, unknown>).error)).toContain("hard-gated tasks");

      // Complete both cutoff tasks through the wizard UI: evidence, start, complete.
      // Cards are scoped as the deepest block holding both the task title
      // and its action buttons (titles are unique per run).
      await page.goto(`/close?run=${SEED.runId}&stage=execute`);
      for (const title of ["Complete receivables cutoff", "Complete payables cutoff"]) {
        const card = page
          .locator("div")
          .filter({ hasText: title })
          .filter({ has: page.getByRole("button", { name: "Add evidence" }) })
          .last();
        await card.getByPlaceholder("Add a note or evidence summary\u2026").fill(`Cutoff verified for ${P.name}`);
        const evidenced = page.waitForResponse(
          (r) => r.url().endsWith(`/api/close/runs/${SEED.runId}/evidence`) && r.request().method() === "POST",
        );
        await card.getByRole("button", { name: "Add evidence" }).click();
        expect((await evidenced).status()).toBe(200);
        const started = page.waitForResponse(
          (r) => r.url().includes(`/api/close/runs/${SEED.runId}/tasks/`) && r.request().method() === "POST",
        );
        await card.getByRole("button", { name: "Start" }).click();
        expect((await started).status()).toBe(200);
        const completed = page.waitForResponse(
          (r) => r.url().includes(`/api/close/runs/${SEED.runId}/tasks/`) && r.request().method() === "POST",
        );
        await card.getByRole("button", { name: "Complete" }).click();
        expect((await completed).status()).toBe(200);
      }

      // With the cutoffs complete the readiness gate is fully green.
      const cleared = ok(
        await api(page.request, baseURL!, "POST", `/api/close/runs/${SEED.runId}`, { action: "refresh" }),
        "refresh after cutoffs",
      );
      expect(cleared.openExceptions).toBe(1);
      expect(cleared.readinessScore).toBe(100);
      await page.goto(`/close?run=${SEED.runId}&stage=readiness`);
      await expect(page.getByText(/100\s*%/).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("requests approval in the wizard, approves independently, and locks the period", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    const actx = await browser.newContext({ baseURL });
    const apage = await actx.newPage();
    try {
      await page.goto(`/close?run=${SEED.runId}&stage=lock`);
      const requested = page.waitForResponse(
        (r) => r.url().endsWith(`/api/close/runs/${SEED.runId}`) && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Request approval" }).click();
      expect((await requested).status()).toBe(200);
      await expect(page.getByText("In review").first()).toBeVisible();

      // Second actor through the real login — no bypass, no shared session.
      const loginRes = await apage.request.post(`${baseURL}/api/login`, {
        data: { email: APPROVER_EMAIL, password: APPROVER_PASSWORD },
        headers: { Origin: new URL(baseURL!).origin },
      });
      expect(loginRes.ok(), await loginRes.text()).toBe(true);
      const gates = ok(await api(apage.request, baseURL!, "GET", "/api/flows/gates"), "gates");
      const gate = ((gates.gates ?? []) as { id: string; subjectId: string }[]).find(
        (g) => g.subjectId === SEED.runId,
      );
      expect(gate, "approval gate exists").toBeTruthy();

      // Segregation negative: the requester cannot approve their own close.
      const selfApprove = await api(page.request, baseURL!, "POST", "/api/flows/gates/decide", {
        gateId: gate!.id,
        decision: "approved",
        comment: "self-approval attempt",
      });
      expect(selfApprove.status, "self-approval refused").not.toBe(200);

      const decided = ok(
        await api(apage.request, baseURL!, "POST", "/api/flows/gates/decide", {
          gateId: gate!.id,
          decision: "approved",
          comment: `Close ${P.name} approved for lock`,
        }),
        "gate decide",
      );
      expect(decided.ok).toBe(true);

      await page.goto(`/close?run=${SEED.runId}&stage=lock`);
      await expect(page.getByText("Approved").first()).toBeVisible();
      page.on("dialog", (d) => void d.accept());
      const locked = page.waitForResponse(
        (r) => r.url().endsWith(`/api/close/runs/${SEED.runId}`) && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Lock period" }).click();
      expect((await locked).status()).toBe(200);
      await expect(page.getByText("Closed").first()).toBeVisible();
      await expect(page.getByText(/Period locked by/).first()).toBeVisible();
    } finally {
      await apage.close();
      await actx.close();
      await context.close();
    }
  });

  test("refuses postings into the closed period across modules", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      // GL: a manual journal dated inside the closed period.
      const draft = ok(
        await api(page.request, baseURL!, "POST", "/api/journals/draft", { subsidiaryId: SEED.rootSubId }),
        "refusal draft",
      );
      const id = field(draft, "id", "refusal draft");
      const token = await revisionToken(page.request, baseURL!, `/api/journals/${id}`, (d) =>
        field(d.doc as Record<string, unknown>, "updated_at", "journal"));
      ok(
        await api(page.request, baseURL!, "PATCH", `/api/journals/${id}`, {
          expectedUpdatedAt: token,
          documentDate: `${P.from.slice(0, 8)}25`,
          memo: "Attempt into closed period",
          lines: [
            { accountId: SEED.accounts["6300"], description: "Supplies", amount: "100.00" },
            { accountId: SEED.accounts["1000"], description: "Cash", amount: "-100.00" },
          ],
        }),
        "refusal fill",
      );
      const glRefused = await api(page.request, baseURL!, "POST", "/api/journals/actions", {
        action: "post",
        documentId: id,
      });
      expect(glRefused.status).toBe(422);
      expect(JSON.stringify(glRefused.json)).toMatch(/closed/i);

      // AR and AP: invoice and bill posts into the same closed scope refuse.
      const arId = await draftSeedDocument(page.request, baseURL!, "customer_invoice", {
        partyId: SEED.customerAId,
        subsidiaryId: SEED.rootSubId,
        documentDate: `${P.from.slice(0, 8)}26`,
        dueDate: `${P.from.slice(0, 8)}28`,
        lines: [
          {
            accountId: SEED.accounts["4100"],
            description: "Late billing",
            quantity: "1",
            unitPrice: "500.00",
            amount: "500.00",
          },
        ],
      });
      const arRefused = await api(page.request, baseURL!, "POST", "/api/documents/actions", {
        action: "post",
        documentId: arId,
      });
      expect(arRefused.status).toBe(422);
      expect(JSON.stringify(arRefused.json)).toMatch(/closed/i);
      const apId = await draftSeedDocument(page.request, baseURL!, "vendor_bill", {
        partyId: SEED.vendorAId,
        subsidiaryId: SEED.rootSubId,
        documentDate: `${P.from.slice(0, 8)}26`,
        dueDate: `${P.from.slice(0, 8)}28`,
        lines: [
          {
            accountId: SEED.accounts["6100"],
            description: "Late expense",
            quantity: "1",
            unitPrice: "400.00",
            amount: "400.00",
          },
        ],
      });
      const apRefused = await api(page.request, baseURL!, "POST", "/api/documents/actions", {
        action: "post",
        documentId: apId,
      });
      expect(apRefused.status).toBe(422);
      expect(JSON.stringify(apRefused.json)).toMatch(/closed/i);
    } finally {
      await context.close();
    }
  });

  const range = `period=custom&from=${P.from}&to=${P.to}`;

  test("reporting package: profit and loss ties to the seeded journals", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`/reports/pnl?${range}`);
      const main = page.locator("main");
      // Revenue: 12,000 invoice A + 8,000 invoice B + 5,000 project receipt.
      await expect(main.getByText("Service Revenue").first()).toBeVisible();
      const revenue = main.locator("tr", { hasText: "Total Revenue" });
      await expect(revenue).toContainText("$25,000.00");
      // Cost: 2,000 project materials; gross 23,000.
      await expect(main.locator("tr", { hasText: "Total Cost of Goods Sold" })).toContainText("$2,000.00");
      await expect(main.locator("tr", { hasText: "Gross profit" }).last()).toContainText("$23,000.00");
      // Expenses: 5,000 rent + 1,500 supplies + 10,000 depreciation.
      await expect(main.locator("tr", { hasText: "Total Expenses" })).toContainText("$16,500.00");
      // Net: 25,000 - 2,000 - 16,500.
      await expect(main.locator("tr", { hasText: "Net income" }).last()).toContainText("$6,500.00");
    } finally {
      await context.close();
    }
  });

  test("reporting package: balance sheet ties to the seeded journals", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`/reports/balance-sheet?${range}`);
      const main = page.locator("main");
      await expect(main.locator("tr", { hasText: "Operating Bank Account" })).toContainText("$32,500.00");
      await expect(main.locator("tr", { hasText: "Accounts Receivable" })).toContainText("$20,000.00");
      await expect(main.locator("tr", { hasText: "Accounts Payable" })).toContainText("$5,000.00");
      await expect(main.locator("tr", { hasText: "Share Capital" })).toContainText("$25,000.00");
      await expect(main.locator("tr", { hasText: "Total assets" }).last()).toContainText("$42,500.00");
    } finally {
      await context.close();
    }
  });

  test("reporting package: trial balance balances to the seeded journals", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`/reports/trial-balance?${range}`);
      const main = page.locator("main");
      await expect(main.locator("tr", { hasText: "Accounts Receivable" })).toContainText("$20,000.00");
      await expect(main.locator("tr", { hasText: "Service Revenue" })).toContainText("$23,000.00");
      await expect(main.locator("tr", { hasText: "Operating Bank Account" })).toContainText("$32,500.00");
    } finally {
      await context.close();
    }
  });

  test("reporting package: cash flow follows the seeded bank activity", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`/reports/cash-flow?${range}`);
      const main = page.locator("main");
      await expect(main).toContainText("$26,500.00");
    } finally {
      await context.close();
    }
  });

  test("reporting package: AR and AP aging show the unpaid seeded balances", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      // As-of pinned to period end: deterministic buckets however late the run is.
      await page.goto(`/reports/aging?${range}`);
      const main = page.locator("main");
      await expect(main.locator("tr", { hasText: "Harbourlight Foods" })).toContainText("$12,000.00");
      await expect(main.locator("tr", { hasText: "Beacon Grocers" })).toContainText("$8,000.00");
      await expect(main).toContainText("$20,000.00");
      await page.goto(`/reports/aging?${range}&side=ap`);
      const payables = page.locator("main");
      await expect(payables.locator("tr", { hasText: "Northbeam Supplies" })).toContainText("$5,000.00");
      await expect(payables).toContainText("$5,000.00");
    } finally {
      await context.close();
    }
  });

  test("reporting package: project profitability shows the seeded project margin", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`/reports/project-profitability?${range}`);
      const main = page.locator("main");
      const row = main.locator("tr", { hasText: "Harbour Kitchen Refit" });
      await expect(row).toContainText("$5,000.00");
      await expect(row).toContainText("$2,000.00");
      await expect(row).toContainText("$3,000.00");
    } finally {
      await context.close();
    }
  });

  test("book and subsidiary filters isolate the seeded scopes", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      // Adjusting book: only the 10,000 depreciation entry.
      await page.goto(`/reports/pnl?${range}&book=${SEED.adjustingBookId}`);
      const adjusting = page.locator("main");
      await expect(adjusting.locator("tr", { hasText: "Total Expenses" })).toContainText("$10,000.00");
      await expect(adjusting.locator("tr", { hasText: "Net income" }).last()).toContainText("($10,000.00)");
      await expect(adjusting).not.toContainText("$25,000.00");
      // Root subsidiary consolidates its children: identical to unfiltered.
      await page.goto(`/reports/pnl?${range}&sub=${SEED.rootSubId}`);
      const subA = page.locator("main");
      await expect(subA.locator("tr", { hasText: "Total Revenue" })).toContainText("$25,000.00");
      await expect(subA.locator("tr", { hasText: "Net income" }).last()).toContainText("$6,500.00");
      // Child subsidiary isolates its own activity: 8,000 revenue, 6,500 net.
      await page.goto(`/reports/pnl?${range}&sub=${SEED.subBId}`);
      const subB = page.locator("main");
      await expect(subB.locator("tr", { hasText: "Total Revenue" })).toContainText("$8,000.00");
      await expect(subB.locator("tr", { hasText: "Net income" }).last()).toContainText("$6,500.00");
      // Row-level partition: the child's aging names only its own customer.
      await page.goto(`/reports/aging?${range}&sub=${SEED.subBId}`);
      const subBAging = page.locator("main");
      await expect(subBAging.locator("tr", { hasText: "Beacon Grocers" })).toContainText("$8,000.00");
      await expect(subBAging.locator("tr", { hasText: "Harbourlight Foods" })).toHaveCount(0);
      await page.goto(`/reports/aging?${range}`);
      await expect(page.locator("main").locator("tr", { hasText: "Harbourlight Foods" })).toContainText("$12,000.00");
    } finally {
      await context.close();
    }
  });

  test("comparative columns show the prior period beside the closed one", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`/reports/pnl?${range}&compare=prior_period`);
      const main = page.locator("main");
      // Current period and the 6,000 prior-month revenue side by side.
      const revenue = main.locator("tr", { hasText: "Total Revenue" });
      await expect(revenue).toContainText("$25,000.00");
      await expect(revenue).toContainText("$6,000.00");
    } finally {
      await context.close();
    }
  });

  test("drill-down lines sum to the statement cell", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`/reports/pnl?${range}`);
      const main = page.locator("main");
      await main.locator("tr", { hasText: "Total Revenue" }).getByRole("link").click();
      await page.waitForURL(/reportDrill=/);
      // The drill drawer (mounted outside main) carries its own net total
      // equal to the statement cell, and its lines are the three seeded
      // revenue postings (12,000 + 8,000 + 5,000).
      await expect(page.getByText(/Net total\s*\$25,000\.00/)).toBeVisible();
      await expect(page.getByText("INV-00001").first()).toBeVisible();
      await expect(page.getByText("INV-00002").first()).toBeVisible();
      const body = page.locator("body");
      await expect(body).toContainText("$12,000.00");
      await expect(body).toContainText("$8,000.00");
      await expect(body).toContainText("$5,000.00");
    } finally {
      await context.close();
    }
  });

  test("PDF exports render the same numbers as the screen", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      for (const [kind, figures] of [
        ["pnl", ["25,000.00", "16,500.00", "6,500.00"]],
        ["balance-sheet", ["32,500.00", "20,000.00", "5,000.00"]],
        ["trial-balance", ["32,500.00", "20,000.00", "74,500.00"]],
      ] as [string, string[]][]) {
        const res = await page.request.get(
          `${baseURL}/api/reports/statement/${kind}/export?format=pdf&period=custom&from=${P.from}&to=${P.to}`,
          { headers: { Origin: new URL(baseURL!).origin } },
        );
        expect(res.ok(), `${kind} pdf: ${res.status()}`).toBe(true);
        const text = extractPdfText(await res.body());
        expect(text.length, `${kind} pdf text`).toBeGreaterThan(100);
        for (const figure of figures) {
          expect(text, `${kind} pdf shows ${figure}`).toContain(figure);
        }
      }
    } finally {
      await context.close();
    }
  });
});
