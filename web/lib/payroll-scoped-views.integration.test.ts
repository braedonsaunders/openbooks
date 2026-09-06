import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { saveOpeningBalances } from "@openbooks/engine/src/payroll-opening-balances.ts";
import { commitPayRun } from "@openbooks/engine/src/payroll-run.ts";
import { dropScratchOrgReporting } from "@openbooks/engine/src/test-fixtures.ts";
import {
  calculatedRun,
  seedAdoption,
} from "@openbooks/engine/src/payroll-filing-test-fixtures.ts";
import type { Authz } from "./authz";

/**
 * Every payroll population has ONE scope decision, and the server pages, the
 * JSON routes and the assistant tools all read it through the loaders under
 * test here. Before this module existed the pages and the tools called the
 * engine directly and rendered a restricted caller wage data its own API
 * refused with 404.
 */

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    // The assistant tool file checks the payroll feature switch; the scratch
    // org has payroll off by default and the switch is not what is under test.
    if (
      specifier === "../features" &&
      context.parentURL?.endsWith("/assistant/tools-payroll.ts")
    ) {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function isFeatureEnabled(){return true}",
      };
    }
    return nextResolve(specifier, context);
  },
});
const views = await import("./payroll-scoped-views.ts");
const { PAYROLL_TOOLS } = await import("./assistant/tools-payroll.ts");
hooks.deregister();

const tool = (name: string) => {
  const found = PAYROLL_TOOLS.find((t) => t.name === name);
  assert.ok(found, name);
  return found;
};

test(
  "payroll pages and assistant tools carry the caller's subsidiary scope like the API routes",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const hidden = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,name,base_currency,country,parent_id,is_elimination,is_active,custom)
        values(${hidden},${fx.orgId},'Other employer','CAD','CA',${fx.subsidiaryId},false,true,'{}'::jsonb)`);
      await db.execute(
        sql`update parties set subsidiary_id=${fx.subsidiaryId} where id=${fx.employeeId} and org_id=${fx.orgId}`,
      );
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      // A prior-year carry-in: the committed 2026 run locks 2026, not 2025.
      const saved = await saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2025,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "5000.00", cppYtd: "100.00" }, components: {} }],
      });
      assert.deepEqual(saved.errors, []);

      const gate = (allowed: Set<string> | null): Authz => ({
        user: { orgId: fx.orgId, id: fx.actorId } as Authz["user"],
        permissions: new Set(["payroll.read", "payroll.manage"]),
        allowedSubsidiaryIds: allowed,
      });
      const unrestricted = gate(null);
      const visible = gate(new Set([fx.subsidiaryId]));
      const restricted = gate(new Set([hidden]));

      // Year-end: the whole population is refused, never partially rendered.
      const everyone = await views.scopedYearEndFilings(unrestricted, 2026);
      assert.ok(everyone);
      const t4 = everyone.find((f) => f.country === "CA" && f.key === "t4");
      assert.ok(t4 && t4.data.rows.length === 1, "the committed run produced one slip");
      assert.deepEqual(await views.scopedYearEndFilings(visible, 2026), everyone);
      assert.equal(await views.scopedYearEndFilings(restricted, 2026), null);

      // Remittances: employer-level aggregate, refused outright when hidden.
      const groups = await views.scopedRemittanceSummary(unrestricted, {
        from: "2026-07-01",
        to: "2026-07-31",
      });
      assert.ok(groups && groups.length > 0);
      assert.deepEqual(
        await views.scopedRemittanceSummary(visible, { from: "2026-07-01", to: "2026-07-31" }),
        groups,
      );
      assert.equal(
        await views.scopedRemittanceSummary(restricted, { from: "2026-07-01", to: "2026-07-31" }),
        null,
      );

      // Opening balances and bank carry-ins: filtered to visible employees.
      const openings = await views.scopedOpeningBalances(unrestricted, 2025);
      assert.ok(openings.rows.some((r) => r.employeePartyId === fx.employeeId && r.amounts !== null));
      assert.deepEqual(openings.years, [2025]);
      const visibleOpenings = await views.scopedOpeningBalances(visible, 2025);
      assert.ok(visibleOpenings.rows.some((r) => r.employeePartyId === fx.employeeId));
      assert.deepEqual(visibleOpenings.years, [2025]);
      const hiddenOpenings = await views.scopedOpeningBalances(restricted, 2025);
      assert.equal(hiddenOpenings.rows.length, 0);
      assert.equal(hiddenOpenings.entered, 0);
      assert.deepEqual(hiddenOpenings.years, []);

      const banks = await views.scopedEntitlementOpenings(unrestricted);
      assert.ok(banks.rows.some((r) => r.employeePartyId === fx.employeeId));
      const hiddenBanks = await views.scopedEntitlementOpenings(restricted);
      assert.equal(hiddenBanks.rows.length, 0);
      assert.deepEqual(Object.keys(hiddenBanks.blocked), []);

      // Retro: an org-wide schedule follows the root convention.
      assert.deepEqual(
        (await views.scopedRetroSchedules(visible)).map((s) => s.id),
        [fx.scheduleId],
      );
      assert.deepEqual(await views.scopedRetroSchedules(restricted), []);

      // Assistant tools: the same decisions, expressed as tool results.
      const runs = tool("list_pay_runs");
      const allRuns = await runs.execute({}, unrestricted);
      assert.ok(allRuns.ok && (allRuns.data as { returned: number }).returned === 1);
      const hiddenRuns = await runs.execute({}, restricted);
      assert.ok(hiddenRuns.ok && (hiddenRuns.data as { returned: number }).returned === 0);

      const run = tool("get_pay_run");
      assert.equal((await run.execute({ documentId: input.documentId }, visible)).ok, true);
      assert.deepEqual(await run.execute({ documentId: input.documentId }, restricted), {
        ok: false,
        error: "pay_run_not_found",
      });

      const yearEnd = tool("payroll_year_end");
      assert.equal((await yearEnd.execute({ taxYear: 2026 }, visible)).ok, true);
      assert.deepEqual(await yearEnd.execute({ taxYear: 2026 }, restricted), {
        ok: false,
        error: "not_found",
      });

      const employees = tool("list_payroll_employees");
      const allEmployees = await employees.execute({}, unrestricted);
      assert.ok(allEmployees.ok && (allEmployees.data as { returned: number }).returned === 1);
      const hiddenEmployees = await employees.execute({}, restricted);
      assert.ok(hiddenEmployees.ok && (hiddenEmployees.data as { returned: number }).returned === 0);

      const entitlements = tool("payroll_entitlements");
      assert.equal(
        (await entitlements.execute({ employeePartyId: fx.employeeId }, visible)).ok,
        true,
      );
      assert.deepEqual(await entitlements.execute({ employeePartyId: fx.employeeId }, restricted), {
        ok: false,
        error: "employee_not_found",
      });

      const remittances = tool("payroll_remittances");
      assert.equal(
        (await remittances.execute({ fromDate: "2026-07-01", toDate: "2026-07-31" }, visible)).ok,
        true,
      );
      assert.deepEqual(
        await remittances.execute({ fromDate: "2026-07-01", toDate: "2026-07-31" }, restricted),
        { ok: false, error: "not_found" },
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
