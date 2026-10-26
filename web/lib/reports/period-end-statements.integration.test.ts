import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Period-end journals never change a statement. Statements compute retained
 * earnings from the ledger and exclude closing and opening journals, so for
 * any date the balance sheet, the trial balance and the income statement
 * read identically before and after a year is closed by journal — including
 * the year-end date itself, where a balance-sheet closing zeroes the ledger.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const { withBypassContext, withOrgContext } =
  (await import("@openbooks/engine/platform/db")) as typeof import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, grantScratchPermissions, seedFlowActors } =
  (await import("@openbooks/engine/testing/fixtures")) as typeof import("@openbooks/engine/testing/fixtures");
const fixtures =
  (await import("@openbooks/engine/testing/period-end-fixtures")) as typeof import("@openbooks/engine/testing/period-end-fixtures");
const { generatePeriodEndJournals } =
  (await import("@openbooks/engine/close/period-end-journals")) as typeof import("@openbooks/engine/close/period-end-journals");
const { profitAndLoss, balanceSheet, trialBalance } = (await import(
  root + "web/lib/reports/statements.ts"
)) as typeof import("./statements");
const { statementMatrix, PNL_TYPES } = (await import(
  root + "web/lib/statement-matrix.ts"
)) as typeof import("../statement-matrix");

type Snapshot = Record<string, unknown>;

async function statements(orgId: string): Promise<Snapshot> {
  return withOrgContext(orgId, async () => ({
    balanceSheetMidYear: await balanceSheet("2026-06-30", orgId),
    balanceSheetYearEnd: await balanceSheet("2026-12-31", orgId),
    balanceSheetNextYear: await balanceSheet("2027-01-31", orgId),
    trialBalanceYearEnd: await trialBalance("2026-12-31", undefined, orgId),
    trialBalanceNextYear: await trialBalance("2027-01-31", undefined, orgId),
    incomeStatementYear: await profitAndLoss("2026-01-01", "2026-12-31", undefined, orgId),
    incomeStatementDecember: await profitAndLoss("2026-12-01", "2026-12-31", undefined, orgId),
    incomeStatementMidMonth: await profitAndLoss("2026-12-15", "2026-12-31", undefined, orgId),
    matrixYear: await statementMatrix({
      orgId,
      types: [...PNL_TYPES],
      mode: "flow",
      period: { from: "2026-01-01", to: "2026-12-31" },
      periodLabel: "FY2026",
    }),
  }));
}

for (const balanceSheetJournals of [false, true]) {
  test(
    `statements are identical with and without the period-end journals${balanceSheetJournals ? ", including balance-sheet closing and opening" : ""}`,
    { skip: !process.env.OPENBOOKS_DB_URL, timeout: 120_000 },
    async () => {
      const org = await withBypassContext(() => createScratchOrg());
      try {
        const { adminId, periodId } = await withBypassContext(async () => {
          const actors = await seedFlowActors(org.orgId);
          await grantScratchPermissions(org.orgId, actors.adminId, ["close.run"]);
          const year = await fixtures.seedPeriodEndYear(org);
          await fixtures.postScratchYearActivity(org, year, actors.adminId);
          await fixtures.closeScratchPeriods(
            org,
            actors.adminId,
            Array.from({ length: 11 }, (_, index) =>
              year.periods.get(`2026-${String(index + 1).padStart(2, "0")}`)!,
            ),
          );
          await fixtures.recordPeriodEndPolicy(org, year, {
            actorId: actors.adminId,
            balanceSheetJournals,
          });
          return { adminId: actors.adminId, periodId: year.periods.get("2026-12")! };
        });
        const before = await statements(org.orgId);
        const result = await withBypassContext(() =>
          generatePeriodEndJournals(org.orgId, adminId, {
            periodId,
            reason: "Statutory closing of fiscal year 2026",
          }),
        );
        assert.equal(result.generated.length, 1, "the year was closed by journal");
        const after = await statements(org.orgId);
        assert.deepEqual(after, before);
        // The closed year's income statement is still reportable.
        const income = before.incomeStatementYear as { netIncome: string };
        assert.match(String(income.netIncome), /^500\.10*$/);
      } finally {
        await withBypassContext(() => dropScratchOrg(org.orgId));
      }
    },
  );
}
