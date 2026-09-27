import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { commitPayRun } from "@openbooks/engine/src/payroll/run-commit.ts";
import { dropScratchOrgReporting } from "@openbooks/engine/src/testing/fixtures.ts";
import {
  seedAdoption,
  calculatedRun,
  markLegacy,
} from "@openbooks/engine/src/payroll/filing-test-fixtures.ts";
const stateKey = Symbol.for("openbooks.payroll-filing-history-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.payroll-filing-history-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

// This file lives in web/lib; route aliases resolve against web/.
const webRoot = new URL("../", import.meta.url);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Keep workspace imports inside the checkout under test. node_modules
    // symlinks resolve @openbooks/* to the main checkout, so without this a
    // worktree route test would silently exercise main's engine instead of
    // the worktree's. In the main checkout this maps to the same files.
    if (specifier === "@openbooks/schema" || specifier.startsWith("@openbooks/")) {
      const rest =
        specifier === "@openbooks/schema"
          ? "schema/src/index.ts"
          : specifier.slice("@openbooks/".length);
      return nextResolve(new URL(`../${rest}`, webRoot).href, context);
    }
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.endsWith("/lib/feature-gates")) {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "../app/api/payroll/remittances/route.ts?filing-history";
const { GET } = (await import(
  routeUrl
)) as typeof import("../app/api/payroll/remittances/route.ts");
hooks.deregister();
const get = (orgId: string) =>
  withOrgContext(orgId, () =>
    GET(
      new Request(
        "http://openbooks.test/api/payroll/remittances?from=2026-07-01&to=2026-07-31",
      ),
    ));

for (const change of [
  "hidden-original",
  "inactive-original",
  "unknown",
] as const) {
  test(
    `remittance route handles ${change} historical attribution`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      // seedAdoption mixes tenant seed writes (including seedFlowActors) that
      // must run under bypass once the route import trips the resolver.
      const fx = await withBypassContext(() => seedAdoption());
      try {
        const hidden = randomUUID(),
          first = randomUUID(),
          second = randomUUID();
        await withBypassContext(async () => {
          await db.execute(sql`insert into subsidiaries(id,org_id,name,base_currency,country,parent_id,is_elimination,is_active,custom)
    values(${hidden},${fx.orgId},'Restricted employer','CAD','CA',${fx.subsidiaryId},false,true,'{}'::jsonb)`);
          await db.execute(
            sql`update parties set subsidiary_id=${fx.subsidiaryId} where id=${fx.employeeId} and org_id=${fx.orgId}`,
          );
          await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,subsidiary_id,remitter_type,is_default)
    values(${first},${fx.orgId},'CA','ca_rp','123456789RP0001','Original employer',${change === "hidden-original" ? hidden : fx.subsidiaryId},'regular',true),
    (${second},${fx.orgId},'CA','ca_rp','123456789RP0002','Future employer',${fx.subsidiaryId},'regular',false)`);
          if (change === "inactive-original")
            await db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${first} where org_id=${fx.orgId}`,
            );
        });
        const { input } = await withOrgContext(fx.orgId, () => calculatedRun(fx));
        await withOrgContext(fx.orgId, () => commitPayRun(input));
        routeState.authz = {
          user: { orgId: fx.orgId, id: fx.actorId },
          permissions: new Set(["payroll.read"]),
          allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        };
        if (change === "hidden-original") {
          await withBypassContext(() =>
            db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${second} where org_id=${fx.orgId}`,
            ));
          const response = await get(fx.orgId);
          assert.equal(response.status, 404);
          assert.deepEqual(await response.json(), { error: "not_found" });
        } else if (change === "inactive-original") {
          await withBypassContext(() =>
            db.execute(
              sql`update payroll_filing_accounts set is_active=false where id=${first} and org_id=${fx.orgId}`,
            ));
          const response = await get(fx.orgId);
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.ok(body.groups.length > 0);
          assert.equal(body.groups[0].filingAccount.id, first);
        } else {
          await withBypassContext(() => markLegacy(fx.orgId));
          const response = await get(fx.orgId);
          assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
          const body = await response.json();
          assert.ok(body.groups.length > 0);
          assert.ok(
            body.groups.some(
              (g: { hasUnknownFilingAccount?: boolean }) =>
                g.hasUnknownFilingAccount,
            ),
            "the legacy run surfaces unfiled without failing the route",
          );
        }
      } finally {
        routeState.authz = null;
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}


const consolidatedRows = [
  { label: "payroll filing history scope", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;
        registerHooks({
          resolve(s, c, n) {
            return n(s, c);
          },
        });
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { seedAdoption, calculatedRun } =
          await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
        const { dropScratchOrgReporting } =
          await import("@openbooks/engine/src/testing/fixtures.ts");
        const { commitPayRun } = await import("@openbooks/engine/src/payroll/run-commit.ts");
        const { orgYearEndFilings } =
          await import("@openbooks/engine/src/payroll/yearend.ts");
        const {
          guardPayrollYearEndFilings,
          guardPayrollFilingData,
          guardPayrollFilingRowIds,
        } = await import("../app/api/payroll/subsidiary-scope");
        
        test(
          "annual filing and amendment access stays with the historical employer after a transfer",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              await withBypassContext(() => db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ));
              const { input } = await withBypassContext(() => calculatedRun(fx));
              await withOrgContext(fx.orgId, () => commitPayRun(input));
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              const filings = await withOrgContext(fx.orgId, () => orgYearEndFilings(fx.orgId, 2026));
              const t4 = filings.find((f) => f.country === "CA" && f.key === "t4")!;
              assert.equal(t4.data.rows.length, 1);
              const rowId = String(t4.data.rows[0]![t4.data.rowKey]);
              const hidden = randomUUID();
              await withBypassContext(() => db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Transferred employee entity','CAD','CA')`,
              ));
              await withBypassContext(() => db.execute(
                sql`update parties set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ));
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollYearEndFilings(gate, filings, 2026)),
                null,
                "original employer retains the issued-year population",
              );
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingData(gate, "CA", "t4", t4.data, 2026)),
                null,
              );
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026)),
                null,
                "stored amendment rows use the same historical scope",
              );
              const moved = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardPayrollYearEndFilings(moved, filings, 2026)))?.status,
                404,
              );
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(moved, "CA", "t4", [rowId], 2026)))
                  ?.status,
                404,
                "new employer cannot read earlier payroll",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                    { ...gate, allowedSubsidiaryIds: new Set() },
                    "CA",
                    "t4",
                    [rowId],
                    2026,
                  ))
                )?.status,
                404,
              );
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                  { ...gate, allowedSubsidiaryIds: null },
                  "CA",
                  "t4",
                  [rowId],
                  2026,
                )),
                null,
              );
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2025)))
                  ?.status,
                404,
                "a different year cannot borrow this year ownership",
              );
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );
        
        test(
          "opening carry-in retains its additional entity boundary alongside historical payroll",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              await withBypassContext(() => db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ));
              await withBypassContext(() => db.execute(
                sql`insert into payroll_opening_balances(org_id,employee_party_id,tax_year,taxable_ytd,created_by,updated_by) values(${fx.orgId},${fx.employeeId},2026,100,${fx.actorId},${fx.actorId})`,
              ));
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              const rowId = `${fx.employeeId}:ON:`;
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026)),
                null,
                "opening-only population retains its employee boundary",
              );
              const { input } = await withBypassContext(() => calculatedRun(fx));
              await withOrgContext(fx.orgId, () => commitPayRun(input));
              const hidden = randomUUID();
              await withBypassContext(() => db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Opening balance employee transfer','CAD','CA')`,
              ));
              await withBypassContext(() => db.execute(
                sql`update parties set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ));
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026)))
                  ?.status,
                404,
                "unstamped carry-in cannot be assigned to an original pay-run employer by inference",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                    { ...gate, allowedSubsidiaryIds: new Set([hidden]) },
                    "CA",
                    "t4",
                    [rowId],
                    2026,
                  ))
                )?.status,
                404,
                "current employee ownership cannot grant access to another employer payroll",
              );
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                  { ...gate, allowedSubsidiaryIds: new Set([hidden, fx.subsidiaryId]) },
                  "CA",
                  "t4",
                  [rowId],
                  2026,
                )),
                null,
              );
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );
  } },
  { label: "payroll filing row scope", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;
        registerHooks({
          resolve(s, c, n) {
            return n(s, c);
          },
        });
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { seedAdoption } =
          await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
        const { dropScratchOrgReporting } =
          await import("@openbooks/engine/src/testing/fixtures.ts");
        const { guardPayrollFilingRowIds, guardPayrollFilingData, payrollRowScope } =
          await import("../app/api/payroll/subsidiary-scope");
        
        test(
          "native UUIDv7 filing accounts retain their entity authorization and invalid suffixes fail closed",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              await withBypassContext(() => db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ));
              const hidden = randomUUID();
              await withBypassContext(() => db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Hidden filing entity','CAD','CA')`,
              ));
              const account = (
                await withBypassContext(() => db.execute<{ id: string }>(
                  sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'CA','ca_rp','123456789RP0001','Native filing account',${hidden}) returning id`,
                ))
              ).rows[0]!.id;
              assert.equal(
                account[14],
                "7",
                "fixture uses the database native UUID generator",
              );
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              const rowId = `${fx.employeeId}:ON:${account}`;
              assert.deepEqual(payrollRowScope("CA", "t4", rowId), {
                employees: [fx.employeeId],
                accounts: [account],
              });
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026)))
                  ?.status,
                404,
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () => guardPayrollFilingData(
                    gate,
                    "CA",
                    "t4",
                    {
                      columns: [],
                      rowKey: "rowId",
                      rows: [{ rowId }],
                    },
                    2026,
                  ))
                )?.status,
                404,
              );
              await withBypassContext(() => db.execute(
                sql`update payroll_filing_accounts set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${account}`,
              ));
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026)),
                null,
                "visible native account remains usable",
              );
              for (const malformed of [
                `${fx.employeeId}:ON:not-an-account`,
                `${fx.employeeId}:not-an-account`,
              ]) {
                const filing = malformed.split(":").length === 3 ? "t4" : "w2";
                const country = filing === "t4" ? "CA" : "US";
                assert.equal(payrollRowScope(country, filing, malformed), null);
                assert.equal(
                  (
                    await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                      gate,
                      country,
                      filing,
                      [malformed],
                      2026,
                    ))
                  )?.status,
                  // Item 34: a row id that fails the filing's grammar is MALFORMED
                  // INPUT, refused for every caller (422) before the actor's scope is
                  // consulted — not a scope 404, which stays reserved for rows that
                  // exist outside the caller's subsidiaries.
                  422,
                );
              }
              const employee = (
                await withBypassContext(() => db.execute<{ id: string }>(
                  sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${fx.orgId},'person','Native payroll employee',${fx.subsidiaryId}) returning id`,
                ))
              ).rows[0]!.id;
              assert.equal(employee[14], "7");
              for (const filing of ["roe", "rl1"])
                assert.deepEqual(payrollRowScope("CA", filing, employee), {
                  employees: [employee],
                  accounts: [],
                });
              assert.deepEqual(
                payrollRowScope("CA", "t4", `${employee}:ON:${account}`),
                { employees: [employee], accounts: [account] },
              );
              assert.deepEqual(payrollRowScope("US", "w2", `${employee}:${account}`), {
                employees: [employee],
                accounts: [account],
              });
              assert.deepEqual(payrollRowScope("US", "941", `${account}:1`), {
                employees: [],
                accounts: [account],
              });
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );
  } },
] as const;

for (const row of consolidatedRows) await row.register();
