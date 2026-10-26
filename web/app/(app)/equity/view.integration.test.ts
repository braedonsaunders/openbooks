import assert from "node:assert/strict";
import test from "node:test";

// The loader reads the caller from the request; the scratch actor stands in for it.
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation: true,
  intl: true,
  features: true,
  authz: {
    source:
      "export async function requirePermission(){return globalThis.__equityReader} export async function getAuthz(){return globalThis.__equityReader}" +
      " export function can(authz,permission){return authz.permissions.has(permission)} export function assertCan(){}",
  },
  extra: { "server-only": "export {}" },
});
const { dropScratchOrgReporting } = await import("@openbooks/engine/testing/fixtures");
const { setupEquityWorld, seedHolder } = await import("@openbooks/engine/testing/equity-world");
const { createPlan, createRound, createShareClass, issueSecurity } =
  await import("@openbooks/engine/equity");
const { equitySpec, loadEquity } = await import("./view");

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "every equity view loads from one recorded book and composes its spec",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      const entity = { orgId: w.org.orgId, actorId: w.managerId, subsidiaryId: w.org.subsidiaryId };
      await issueSecurity({
        ...entity,
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: "2026-07-10",
        shareClassId: w.commonClassId,
        quantity: "4000000",
        pricePerShare: "0.0001",
        considerationAccountId: w.org.accounts.bank,
      });
      const seed = (
        await createShareClass({
          ...entity,
          code: "SEED",
          name: "Series Seed",
          kind: "preferred",
          effectiveOn: "2026-01-01",
          authorizedShares: "2000000",
          parValue: "0.0001",
          originalIssuePrice: "1.0000",
          conversionShareClassId: w.commonClassId,
        })
      ).id;
      const round = await createRound({
        ...entity,
        name: "Series Seed",
        shareClassId: seed,
        closedOn: "2026-07-12",
        pricePerShare: "1.0000",
        preMoneyValuation: "4000000",
      });
      const investor = await seedHolder(w.org.orgId, "Seed Investor");
      await issueSecurity({
        ...entity,
        kind: "share",
        holderPartyId: investor,
        issueDate: "2026-07-12",
        shareClassId: seed,
        roundId: round.id,
        quantity: "1000000",
        pricePerShare: "1.0000",
        considerationAmount: "1000000",
        considerationAccountId: w.org.accounts.bank,
      });
      const plan = await createPlan({
        ...entity,
        code: "EIP",
        name: "Equity Incentive Plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "1000000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: false,
      });
      await issueSecurity({
        ...entity,
        kind: "option",
        holderPartyId: investor,
        issueDate: "2026-01-02",
        shareClassId: w.commonClassId,
        planId: plan.id,
        quantity: "48000",
        pricePerShare: "0.5000",
        optionType: "iso",
        expirationDate: "2036-01-02",
        vestingStart: "2026-01-02",
        vestingMonths: 48,
        cliffMonths: 12,
        vestingFrequency: "monthly",
        acceleration: "none",
        valuation: {
          sharePrice: "0.5",
          volatilityPercent: "50",
          riskFreeRatePercent: "4",
          expectedTermYears: "6",
          dividendYieldPercent: "0",
          attribution: "straight_line",
        },
      });
      (globalThis as Record<string, unknown>).__equityReader = {
        user: { id: w.managerId, orgId: w.org.orgId, roles: [] },
        permissions: new Set(["equity.read", "equity.manage", "parties.manage"]),
        allowedSubsidiaryIds: null,
      };
      const sp = (extra: Record<string, string>) => ({
        sub: w.org.subsidiaryId,
        asOf: "2026-12-15",
        ...extra,
      });

      for (const sub of ["00000000-0000-4000-8000-000000000000", "invalid-entity"]) {
        await assert.rejects(loadEquity(sp({ sub })), (error: unknown) => {
          assert.ok(error instanceof Error && "status" in error && "code" in error);
          assert.equal(error.name, "EquityError");
          assert.equal(error.status, 404);
          assert.equal(error.code, "equity_entity_unknown");
          return true;
        });
      }

      const overview = await loadEquity(sp({}));
      assert.equal(overview.view, "overview");
      assert.equal(overview.overview?.tiles.fullyDiluted, "6,000,000");
      assert.equal(overview.newAction?.label, "new.actions.security");
      assert.ok(
        overview.overview?.attention.some((item) => item.href.includes("view=compensation")),
        "the due stock compensation run needs attention",
      );
      assert.ok(overview.hasRoundPulse);
      equitySpec(overview);

      const capTable = await loadEquity(
        sp({ view: "captable", by: "holder", instrument: "option" }),
      );
      assert.equal(capTable.capTable?.dimension, "holder");
      assert.equal(capTable.capTable?.instrument, "option");
      assert.equal(capTable.capTable?.table.totals.fullyDiluted, "6000000");

      const securities = await loadEquity(sp({ view: "securities", kind: "option" }));
      assert.deepEqual(
        securities.securities?.rows.map((row) => row.kind),
        ["option"],
      );
      assert.equal(securities.securities?.holders.length, 2);

      for (const security of ["00000000-0000-4000-8000-000000000000", "invalid-security"]) {
        const missing = await loadEquity(sp({ view: "securities", security }));
        assert.equal(missing.drawerOpen, true);
        assert.ok(missing.drawer && "refusal" in missing.drawer);
        assert.equal(missing.drawer.securityId, security);
        assert.ok(missing.drawer.refusal.message);
        assert.ok(!missing.drawer.closeHref.includes("security="));
        equitySpec(missing);
      }

      const waterfall = await loadEquity(sp({ view: "waterfall" }));
      assert.equal(
        waterfall.waterfall?.anchor?.postMoney,
        "5000000.0000",
        "the default exit is the Seed post-money",
      );
      assert.equal(waterfall.waterfall?.inputs.exitValue, "5000000.0000");
      assert.equal(
        waterfall.waterfall?.scenario?.result.exitValue,
        "5000000.0000",
        "the first paint is already computed",
      );
      // The curve keeps its 17 even samples and adds the points beside each bend of a payout.
      const curve = waterfall.waterfall?.scenario?.curve ?? [];
      assert.ok(curve.length >= 17);
      const exits = curve.map((point) => point.exitValue);
      assert.deepEqual(
        exits,
        [...exits].sort((a, b) => Number(a) - Number(b)),
        "in exit order",
      );
      assert.equal(exits[0], "0.0000");
      assert.equal(exits.at(-1), "10000000.0000", "up to twice the scenario exit");
      assert.equal(
        waterfall.newAction,
        null,
        "the waterfall records nothing, so it has no New action",
      );

      const runs = await loadEquity(sp({ view: "compensation" }));
      assert.equal(runs.runs?.run, "compensation");
      assert.ok(runs.runs?.periodId, "a period is selected for the run");
      assert.ok(runs.runs?.compensation, "the run preview is read for the period end");
      const interest = await loadEquity(
        sp({ view: "compensation", run: "interest", history: "1" }),
      );
      assert.equal(interest.runs?.run, "interest");
      assert.equal(interest.runs?.historyOpen, true);
      assert.ok(
        !interest.runs?.historyCloseHref.includes("history="),
        "closing the history drawer drops its parameter",
      );

      const rounds = await loadEquity(sp({ view: "rounds", model: "round" }));
      assert.equal(rounds.rounds?.modelOpen, true);
      assert.equal(rounds.rounds?.structure.rounds.length, 1);
      assert.equal(rounds.newAction?.label, "new.actions.round");

      const classes = await loadEquity(sp({ view: "classes" }));
      assert.deepEqual(
        classes.structure?.classRows.map((row) => row.code),
        ["CS", "SEED"],
      );
      const stakeholders = await loadEquity(sp({ view: "stakeholders", new: "stakeholder" }));
      assert.equal(stakeholders.newRecord?.kind, "stakeholder");
      assert.equal(stakeholders.newRecord?.canCreateParty, true);
      assert.ok(!stakeholders.newRecord?.closeHref.includes("new="));
      for (const data of [capTable, securities, waterfall, runs, rounds, classes, stakeholders])
        equitySpec(data);

      (globalThis as Record<string, unknown>).__equityReader = {
        user: { id: w.managerId, orgId: w.org.orgId, roles: [] },
        permissions: new Set(["equity.read"]),
        allowedSubsidiaryIds: null,
      };
      const reader = await loadEquity(sp({ view: "plans", new: "plan" }));
      assert.equal(reader.newAction, null, "a reader is offered no New action");
      assert.equal(reader.newRecord, null, "nor can a URL open the form");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
