import assert from "node:assert/strict";
import test from "node:test";
import type { Authz } from "./authz.ts";

// The report executor and its as-of resolution are server-only; they load
// dynamically after the database-bypass hooks, like the other report suites.
const { withOrgContext } = await import("@openbooks/engine/platform/db");
const { businessToday } = await import("@openbooks/engine/platform/business-date/module");
const { dropScratchOrgReporting } = await import("@openbooks/engine/testing/fixtures");
const { seedHolder, seedPositionScenario, setupEquityWorld } =
  await import("@openbooks/engine/testing/equity-world");
const { issueSecurity, loadCapTableView, recordSecurityEvent } =
  await import("@openbooks/engine/equity");
const { BUILT_IN_REPORT_DEFINITION_MAP, addDays } = await import("@openbooks/reports");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Result = { groups: { columns: string[]; rows: (string | number | null | undefined)[][] }[] };

/** Column totals of the summarized cap table, by measure label. */
function totals(result: Result, labels: string[]): Record<string, bigint> {
  const group = result.groups.find((candidate) =>
    labels.every((label) => candidate.columns.includes(label)),
  );
  assert.ok(group, `the summary carries ${labels.join(", ")}`);
  return Object.fromEntries(
    labels.map((label) => {
      const index = group.columns.indexOf(label);
      return [
        label,
        group.rows.reduce(
          (sum, row) => sum + BigInt(String(row[index] ?? "0").replace(/[,\s]/g, "") || "0"),
          0n,
        ),
      ];
    }),
  );
}

test(
  "the Reports-hub cap table with no date chosen reads as of today, not every recorded movement",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await seedPositionScenario(w);
      const today = await businessToday(w.org.orgId);
      const later = addDays(today, 1);
      // A grant dated after today: it is history the cap table reaches only from its date.
      await issueSecurity({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        kind: "rsu",
        holderPartyId: w.holderId,
        issueDate: later,
        shareClassId: w.commonClassId,
        quantity: "7000",
        vestingStart: later,
        vestingMonths: 12,
        cliffMonths: 0,
        vestingFrequency: "monthly",
        valuation: { sharePrice: "1", attribution: "straight_line" },
      });
      const { executeReport, resolveReportAsOf } = await import("./custom-reports.ts");
      const { withReportAuthz } = await import("./report-execution-context.ts");
      const reader: Authz = {
        user: {
          id: w.managerId,
          email: "equity.reader@example.test",
          name: "Equity Reader",
          roles: [],
          orgId: w.org.orgId,
          envKind: "production",
          productionOrgId: w.org.orgId,
          homeUserId: w.managerId,
          homeOrgId: w.org.orgId,
          isSuperAdmin: false,
        },
        permissions: new Set(["reports.read", "equity.read"]),
        allowedSubsidiaryIds: null,
      } as Authz;
      const definition = BUILT_IN_REPORT_DEFINITION_MAP["equity-cap-table"]!;
      const run = (query: typeof definition.query) =>
        withOrgContext(w.org.orgId, () =>
          withReportAuthz(reader, () => executeReport(w.org.orgId, query, undefined, {})),
        ) as Promise<Result>;
      const labels = ["Outstanding shares", "Awards outstanding", "Fully diluted"];
      const replay = async (asOf: string) => {
        const view = await loadCapTableView({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
          asOf,
        });
        return {
          "Outstanding shares": BigInt(view.table.totals.outstanding),
          "Awards outstanding": BigInt(view.table.totals.awardsOutstanding),
          "Fully diluted": BigInt(view.table.totals.fullyDiluted),
        };
      };

      // The run page with no as-of selection resolves the as-of control to today.
      const selection = await withOrgContext(w.org.orgId, () =>
        withReportAuthz(reader, () => resolveReportAsOf({})),
      );
      assert.equal(selection.to, today);
      const hub = await run({ ...definition.query, asOf: selection.to });
      const expectedToday = await replay(today);
      assert.deepEqual(
        totals(hub, labels),
        expectedToday,
        "the hub run equals the replayed cap table today",
      );
      // A stored plan with no as-of (a schedule, a dashboard) reads as of the business day too.
      assert.deepEqual(totals(await run(definition.query), labels), expectedToday);
      // A chosen later date reaches the later grant: the bound is the date alone.
      const expectedLater = await replay(later);
      assert.notDeepEqual(expectedLater, expectedToday, "the later grant changes the cap table");
      assert.deepEqual(
        totals(await run({ ...definition.query, asOf: later }), labels),
        expectedLater,
      );
      const custom = await withOrgContext(w.org.orgId, () =>
        withReportAuthz(reader, () =>
          resolveReportAsOf({ period: "custom", from: later, to: later }),
        ),
      );
      assert.equal(custom.to, later);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the Reports-hub cap table omits positions that are zero on the date and lists class, then shares, awards and pool, then holder",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await seedPositionScenario(w);
      // Shares issued to the wrong holder and voided: a position on the issue
      // date that is zero in every measure once the void takes effect.
      const leaverId = await seedHolder(w.org.orgId, "Voided Holder");
      const leaver = await issueSecurity({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        kind: "share",
        holderPartyId: leaverId,
        issueDate: "2026-07-10",
        shareClassId: w.commonClassId,
        quantity: "2500",
        pricePerShare: "0.0001",
        considerationAccountId: w.org.accounts.bank,
      });
      await recordSecurityEvent({
        orgId: w.org.orgId,
        actorId: w.managerId,
        securityId: leaver.id,
        kind: "void",
        effectiveOn: "2026-07-20",
        reason: "Issued to the wrong holder",
      });
      const { executeReport } = await import("./custom-reports.ts");
      const { withReportAuthz } = await import("./report-execution-context.ts");
      const reader: Authz = {
        user: {
          id: w.managerId,
          email: "equity.reader@example.test",
          name: "Equity Reader",
          roles: [],
          orgId: w.org.orgId,
          envKind: "production",
          productionOrgId: w.org.orgId,
          homeUserId: w.managerId,
          homeOrgId: w.org.orgId,
          isSuperAdmin: false,
        },
        permissions: new Set(["reports.read", "equity.read"]),
        allowedSubsidiaryIds: null,
      } as Authz;
      const definition = BUILT_IN_REPORT_DEFINITION_MAP["equity-cap-table"]!;
      const run = (asOf: string) =>
        withOrgContext(w.org.orgId, () =>
          withReportAuthz(reader, () =>
            executeReport(w.org.orgId, { ...definition.query, asOf }, undefined, {}),
          ),
        ) as Promise<Result>;
      const holders = (result: Result) => result.groups[0]!.rows.map((row) => row[2]);

      assert.ok(
        holders(await run("2026-07-15")).includes("Voided Holder"),
        "the position exists between issue and void",
      );
      const after = await run("2026-12-31");
      assert.ok(
        !holders(after).includes("Voided Holder"),
        "a position that is zero in every measure is omitted",
      );
      const rows = after.groups[0]!.rows;
      assert.ok(rows.length > 0);
      for (const row of rows)
        assert.ok(
          row.slice(3).some((cell) => String(cell ?? "0") !== "0"),
          `no all-zero line: ${JSON.stringify(row)}`,
        );
      // Class, then shares before awards before the pool, then holder.
      const rank = (cell: unknown) =>
        ["share", "award", "pool"].findIndex(
          (kind, index) =>
            cell === kind || cell === ["Shares", "Awards", "Unallocated pool"][index],
        );
      for (let i = 1; i < rows.length; i++) {
        const [prior, row] = [rows[i - 1]!, rows[i]!];
        assert.ok(rank(row[1]) >= 0, `position type reads as a known label: ${String(row[1])}`);
        const order =
          String(prior[0]) < String(row[0])
            ? -1
            : String(prior[0]) > String(row[0])
              ? 1
              : rank(prior[1]) !== rank(row[1])
                ? rank(prior[1]) - rank(row[1])
                : String(prior[2] ?? "\uffff").localeCompare(String(row[2] ?? "\uffff"));
        assert.ok(
          order <= 0,
          `ordered: ${JSON.stringify(prior.slice(0, 3))} before ${JSON.stringify(row.slice(0, 3))}`,
        );
      }
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the securities register reads each security's status and outstanding quantity on its date exactly as the register view does",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const scenario = await seedPositionScenario(w);
      const entity = { orgId: w.org.orgId, actorId: w.managerId, subsidiaryId: w.org.subsidiaryId };
      const safe = await issueSecurity({
        ...entity,
        kind: "safe",
        holderPartyId: w.holderId,
        issueDate: "2026-07-10",
        considerationAmount: "25000",
        considerationAccountId: w.org.accounts.bank,
        safeType: "post_money",
        valuationCap: "5000000",
      });
      await recordSecurityEvent({
        ...entity,
        securityId: safe.id,
        kind: "cancel",
        effectiveOn: "2026-08-20",
        reason: "Cancelled by agreement with the holder",
      });
      const { listSecurities } = await import("@openbooks/engine/equity");
      const { executeReport } = await import("./custom-reports.ts");
      const { withReportAuthz } = await import("./report-execution-context.ts");
      const reader: Authz = {
        user: {
          id: w.managerId,
          email: "equity.reader@example.test",
          name: "Equity Reader",
          roles: [],
          orgId: w.org.orgId,
          envKind: "production",
          productionOrgId: w.org.orgId,
          homeUserId: w.managerId,
          homeOrgId: w.org.orgId,
          isSuperAdmin: false,
        },
        permissions: new Set(["reports.read", "equity.read"]),
        allowedSubsidiaryIds: null,
      } as Authz;
      const definition = BUILT_IN_REPORT_DEFINITION_MAP["equity-securities-register"]!;
      const statusLabels = new Map(
        Object.entries(
          (await import("../messages/en/index.ts")).default.reports.catalog.columnValues
            .equity_securities_register.status,
        ).map(([value, label]) => [label, value]),
      );
      const seen = new Set<string>();
      for (const asOf of [...scenario.checkDates, "2026-08-21"]) {
        const result = (await withOrgContext(w.org.orgId, () =>
          withReportAuthz(reader, () =>
            executeReport(w.org.orgId, { ...definition.query, asOf }, undefined, {}),
          ),
        )) as Result;
        const group = result.groups[0];
        const view = await listSecurities({ ...entity, asOf });
        const expected = view.rows
          .filter((row) => row.issueDate <= asOf)
          .map((row) => [
            row.securityNumber,
            row.status,
            row.kind === "safe" || row.kind === "note" ? null : row.outstanding,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        if (!group) {
          assert.deepEqual(expected, [], `${asOf}: nothing is issued`);
          continue;
        }
        const at = (label: string) => group.columns.indexOf(label);
        const actual = group.rows
          .map((row) => {
            const status = String(row[at("Status")]);
            const quantity = row[at("Quantity outstanding")];
            return [
              row[at("Security")],
              statusLabels.get(status) ?? status,
              quantity == null || quantity === "" ? null : String(quantity).replace(/[,\s]/g, ""),
            ];
          })
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        assert.deepEqual(actual, expected, `the register on ${asOf}`);
        for (const row of expected) seen.add(String(row[1]));
      }
      for (const status of ["outstanding", "void", "cancelled"])
        assert.ok(seen.has(status), `the dates cover a ${status} security`);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
