import { test } from "@playwright/test";
import { authedContext, dismissSetupWizard } from "../auth";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  AMT,
  APPROVER_EMAIL,
  APPROVER_PASSWORD,
  EXPECT,
  api,
  binderHash,
  field,
  expect,
  extractPdfText,
  ok,
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

let BINDER1_HASH = "";
let BINDER1_BODY = "";

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
      async function postDocument(kind: string, patch: Record<string, unknown>) {
        const draft = ok(await api(req, origin, "POST", "/api/documents/draft", { kind }), `${kind} draft`);
        const id = draft.id as string;
        const token = await revisionToken(req, origin, `/api/documents/${id}`, (d) => (d.doc ? field(d.doc as Record<string, unknown>, "updated_at", "document") : field(d, "updated_at", "document")));
        ok(
          await api(req, origin, "PATCH", `/api/documents/${id}`, { expectedUpdatedAt: token, ...patch }),
          `${kind} fill`,
        );
        const posted = ok(
          await api(req, origin, "POST", "/api/documents/actions", { action: "post", documentId: id }),
          `${kind} post`,
        );
        expect(posted.ok).toBe(true);
        return id;
      }
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

      async function postJournal(subsidiaryId: string, documentDate: string, memo: string, lines: { account: string; amount: string; description: string; project?: boolean }[]) {
        const draft = ok(await api(req, origin, "POST", "/api/journals/draft", { subsidiaryId }), "journal draft");
        const id = draft.id as string;
        const token = await revisionToken(req, origin, `/api/journals/${id}`, (d) => field(d.doc as Record<string, unknown>, "updated_at", "journal"));
        ok(
          await api(req, origin, "PATCH", `/api/journals/${id}`, {
            expectedUpdatedAt: token,
            documentDate,
            memo,
            lines: lines.map((l) => ({
              accountId: SEED.accounts[l.account]!,
              description: l.description,
              amount: l.amount,
              ...(l.project ? { projectId: SEED.projectId } : {}),
            })),
          }),
          `journal ${memo}`,
        );
        const posted = ok(
          await api(req, origin, "POST", "/api/journals/actions", { action: "post", documentId: id }),
          `journal post ${memo}`,
        );
        expect(posted.ok).toBe(true);
        return id;
      }
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
});
