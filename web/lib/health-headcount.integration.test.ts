import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "../money-server" && context.parentURL?.includes("/analytics/")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}" };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { financialHealth, DEFAULT_BENCHMARKS } = await import("./analytics/financial-health");

const cases = [
  { name: "active employee", hired: "2026-01-01", terminated: null, expected: 1 },
  { name: "future hire", hired: "2026-08-01", terminated: null, expected: 0 },
  { name: "later termination", hired: "2026-01-01", terminated: "2026-08-01", expected: 1 },
  { name: "termination on cutoff", hired: "2026-01-01", terminated: "2026-07-31", expected: 1 },
  { name: "earlier termination", hired: "2026-01-01", terminated: "2026-07-30", expected: 0 },
  { name: "undated employee", hired: null, terminated: null, expected: 1 },
];
for (const scenario of cases) {
  test(`Financial Health period-end headcount: ${scenario.name}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const employee = randomUUID();
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
        values (${employee},${org.orgId},'person','Historical employee',${org.subsidiaryId})`);
      await db.execute(sql`insert into employee_roles(org_id,party_id,hired_on,terminated_on)
        values (${org.orgId},${employee},${scenario.hired},${scenario.terminated})`);
      await withOrgContext(org.orgId, async () => {
        const data = await financialHealth({ from: "2026-07-01", to: "2026-07-31", label: "July" }, DEFAULT_BENCHMARKS, org.orgId, null);
        assert.equal(data.figures.headcount, scenario.expected);
        for (const key of ["rev_per_employee", "gp_per_employee"]) {
          const ratio = Object.values(data.ratios).flat().find(row => row.id === key);
          assert.ok(ratio);
          assert.equal(ratio.value, scenario.expected ? 0 : null);
          assert.equal(ratio.noData, scenario.expected === 0);
        }
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}
