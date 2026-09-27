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


const payrollFilingScopeCases = [
  { label: "payroll 941 source scope", register: async () => {
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
        const { form941Worksheet } =
          await import("@openbooks/engine/src/payroll/yearend.ts");
        const { guardPayrollFilingRowIds, guardPayrollFilingData, payrollRowScope } =
          await import("../app/api/payroll/subsidiary-scope");
        test(
          "Form 941 guards every quarter source and preserves unassigned-root isolation",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              const hidden = randomUUID(),
                doc = randomUUID();
              await withBypassContext(() => db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Hidden Form 941 employer','CAD','US')`,
              ));
              const account = (
                await withBypassContext(() => db.execute<{ id: string }>(
                  sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'US','us_ein','12-3456789','Visible EIN',${fx.subsidiaryId}) returning id`,
                ))
              ).rows[0]!.id;
              await withBypassContext(() => db.execute(
                sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${doc},${fx.orgId},'pay_run','941-SOURCE',${hidden},'2026-07-15','USD','draft')`,
              ));
              await withBypassContext(() => db.execute(
                sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${doc},${fx.orgId},${fx.scheduleId},'2026-07-15','2026-07-15','2026-07-15',2026,'committed','bonus')`,
              ));
              await withBypassContext(() => db.execute(
                sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,employment_id,country,country_source,filing_account_id,filing_account_source,province,periods_per_year,pay_date,tax_year,currency_code,pensionable_earnings) values(${fx.orgId},${doc},${fx.employeeId},${fx.employmentId},'US','calculation',${account},'calculation','NY',26,'2026-07-15',2026,'USD',100)`,
              ));
              const quarters = await withOrgContext(fx.orgId, () => form941Worksheet(fx.orgId, 2026));
              assert.equal(quarters.length, 1);
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              const denied = await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                gate,
                "US",
                "941",
                [`${account}:3`],
                2026,
              ));

              assert.equal(
                denied?.status,
                404,
                "a visible EIN cannot authorize hidden payroll sources",
              );
              await withBypassContext(() => db.execute(
                sql`update payroll_filing_accounts set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${account}`,
              ));
              const child = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                  child,
                  "US",
                  "941",
                  [`${account}:3`],
                  2026,
                )),
                null,
                "visible account and source remain accessible",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                    child,
                    "US",
                    "941",
                    [`${account}:2`],
                    2026,
                  ))
                )?.status,
                404,
                "a different quarter cannot borrow source ownership",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                    child,
                    "US",
                    "941",
                    [`${account}:3`],
                    2025,
                  ))
                )?.status,
                404,
                "a different year cannot borrow source ownership",
              );
              const unassignedDoc = randomUUID();
              await withBypassContext(() => db.execute(
                sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${unassignedDoc},${fx.orgId},'pay_run','941-UNASSIGNED',${hidden},'2026-07-16','USD','draft')`,
              ));
              await withBypassContext(() => db.execute(
                sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${unassignedDoc},${fx.orgId},${fx.scheduleId},'2026-07-16','2026-07-16','2026-07-16',2026,'committed','bonus')`,
              ));
              await withBypassContext(() => db.execute(
                sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,employment_id,country,country_source,filing_account_id,filing_account_source,province,periods_per_year,pay_date,tax_year,currency_code,pensionable_earnings) values(${fx.orgId},${unassignedDoc},${fx.employeeId},${fx.employmentId},'US','calculation',null,'calculation','NY',26,'2026-07-16',2026,'USD',50)`,
              ));
              const all = await withOrgContext(fx.orgId, () => form941Worksheet(fx.orgId, 2026));
              assert.equal(all.length, 2);
              assert.deepEqual(payrollRowScope("US", "941", ":3"), {
                employees: [],
                accounts: [],
              });
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(child, "US", "941", [":3"], 2026)))
                  ?.status,
                404,
                "unassigned aggregate still requires root visibility",
              );
              const rowIds = all.map((q) => `${q.filingAccountId ?? ""}:${q.quarter}`);
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(child, "US", "941", rowIds, 2026)))
                  ?.status,
                404,
                "a visible assigned account cannot mask an unassigned row",
              );
              const both = {
                ...gate,
                allowedSubsidiaryIds: new Set([fx.subsidiaryId, hidden]),
              };
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(both, "US", "941", rowIds, 2026)),
                null,
              );
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingData(
                  both,
                  "US",
                  "941",
                  { columns: [], rowKey: "id", rows: rowIds.map((id) => ({ id })) },
                  2026,
                )),
                null,
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () => guardPayrollFilingData(
                    child,
                    "US",
                    "941",
                    { columns: [], rowKey: "id", rows: rowIds.map((id) => ({ id })) },
                    2026,
                  ))
                )?.status,
                404,
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                    { ...gate, allowedSubsidiaryIds: new Set() },
                    "US",
                    "941",
                    rowIds,
                    2026,
                  ))
                )?.status,
                404,
              );
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(
                  { ...gate, allowedSubsidiaryIds: null },
                  "US",
                  "941",
                  rowIds,
                  2026,
                )),
                null,
              );
              for (const id of [
                `${account}:0`,
                `${account}:5`,
                `${account}:1x`,
                ":0",
                ":5",
                "bad-account:1",
              ])
                assert.equal(payrollRowScope("US", "941", id), null);
              await withBypassContext(() => db.execute(
                sql`update pay_runs set run_status='voided' where org_id=${fx.orgId}`,
              ));
              assert.equal(
                await withOrgContext(fx.orgId, () => guardPayrollFilingRowIds(both, "US", "941", rowIds, 2026)),
                null,
                "voided payroll retains ownership evidence for stored correction artifacts",
              );
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );
  } },
  { label: "payroll remittance history scope", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;
        const routeState: { gate: Authz | null } = { gate: null };
        (globalThis as typeof globalThis & Record<symbol, unknown>)[
          Symbol.for("openbooks.remittance-history-route")
        ] = routeState;
        registerHooks({
          resolve(specifier, context, next) {
            if (
              specifier === "../../../../lib/feature-gates" &&
              context.parentURL?.endsWith("/api/payroll/remittances/route.ts")
            )
              return {
                shortCircuit: true,
                url:
                  "data:text/javascript," +
                  encodeURIComponent(
                    "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.remittance-history-route')].gate}",
                  ),
              };
            return next(specifier, context);
          },
        });
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { seedAdoption, calculatedRun } =
          await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
        const { dropScratchOrgReporting } =
          await import("@openbooks/engine/src/testing/fixtures.ts");
        const { commitPayRun } = await import("@openbooks/engine/src/payroll/run-commit.ts");
        const { guardRemittancePeriod } =
          await import("../app/api/payroll/subsidiary-scope");
        const { payrollRemittanceSummary, createRemittanceBill } =
          await import("@openbooks/engine/src/payroll/remittance.ts");

        const { scopedRemittanceSummary } = await import("./payroll-scoped-views");
        const { GET: remittanceGet, POST: remittancePost } =
          await import("../app/api/payroll/remittances/route");

        test(
          "remittance history remains scoped to the original pay-run entity after employee transfer",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              await withBypassContext(() =>
                db.execute(
                  sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
                ),
              );
              const { input } = await withBypassContext(() => calculatedRun(fx));
              await withOrgContext(fx.orgId, () => commitPayRun(input));
              const range = { from: "2026-07-01", to: "2026-07-31" };
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              assert.equal(
                await withOrgContext(fx.orgId, () => guardRemittancePeriod(gate, range.from, range.to)),
                null,
              );
              const before = await withOrgContext(fx.orgId, () =>
                payrollRemittanceSummary(
                  fx.orgId,
                  range,
                  gate.allowedSubsidiaryIds,
                ),
              );
              assert.ok(before.length);
              const hidden = randomUUID();
              await withBypassContext(() =>
                db.execute(
                  sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Transferred employee entity','CAD','CA')`,
                ),
              );
              await withBypassContext(() =>
                db.execute(
                  sql`update parties set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${fx.employeeId}`,
                ),
              );
              assert.equal(
                await withOrgContext(fx.orgId, () => guardRemittancePeriod(gate, range.from, range.to)),
                null,
                "original employer retains its history",
              );
              assert.deepEqual(
                await withOrgContext(fx.orgId, () =>
                  payrollRemittanceSummary(
                    fx.orgId,
                    range,
                    gate.allowedSubsidiaryIds,
                  ),
                ),
                before,
              );
              const moved = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
              assert.equal(
                (await withOrgContext(fx.orgId, () => guardRemittancePeriod(moved, range.from, range.to)))?.status,
                404,
                "new employer cannot read the earlier employer payroll",
              );
              assert.deepEqual(
                await withOrgContext(fx.orgId, () =>
                  payrollRemittanceSummary(
                    fx.orgId,
                    range,
                    moved.allowedSubsidiaryIds,
                  ),
                ),
                [],
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    guardRemittancePeriod(
                      { ...gate, allowedSubsidiaryIds: new Set() },
                      range.from,
                      range.to,
                    ),
                  )
                )?.status,
                404,
              );
              assert.deepEqual(
                await withOrgContext(fx.orgId, () => payrollRemittanceSummary(fx.orgId, range, new Set())),
                [],
              );
              assert.equal(
                await withOrgContext(fx.orgId, () =>
                  guardRemittancePeriod(
                    { ...gate, allowedSubsidiaryIds: null },
                    range.from,
                    range.to,
                  ),
                ),
                null,
              );
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );

        test(
          "scoped remittance history excludes matching bill artifacts owned by another legal entity",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              const vendor = randomUUID(),
                hidden = randomUUID(),
                invoice = randomUUID();
              await withBypassContext(() =>
                db.execute(
                  sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${fx.orgId},'organization','Shared remittance authority',true)`,
                ),
              );
              await withBypassContext(() =>
                db.execute(
                  sql`insert into vendor_roles(org_id,party_id,is_active) values(${fx.orgId},${vendor},true)`,
                ),
              );
              await withBypassContext(() =>
                db.execute(
                  sql`update pay_components set remittance_party_id=${vendor} where org_id=${fx.orgId}`,
                ),
              );
              await withBypassContext(() =>
                db.execute(
                  sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
                ),
              );
              const { input } = await withBypassContext(() => calculatedRun(fx));
              await withOrgContext(fx.orgId, () => commitPayRun(input));
              const range = { from: "2026-07-01", to: "2026-07-31" };
              const group = (await withOrgContext(fx.orgId, () => payrollRemittanceSummary(fx.orgId, range)))[0]!;
              assert.equal(group.partyId, vendor);
              await withBypassContext(() =>
                db.execute(
                  sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Other bill owner','CAD','CA')`,
                ),
              );
              await withBypassContext(() =>
                db.execute(
                  sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,document_date,currency,status,custom) values(${invoice},${fx.orgId},'vendor_bill','HIDDEN-REMIT',${vendor},${hidden},'2026-07-31','CAD','draft',${JSON.stringify({ payrollRemittance: { ...range, partyId: vendor, filingAccountId: group.filingAccount.id } })}::jsonb)`,
                ),
              );
              const expense = (
                await withBypassContext(() =>
                  db.execute<{ id: string }>(
                    sql`select id from accounts where org_id=${fx.orgId} and type='expense' and not is_summary limit 1`,
                  ),
                )
              ).rows[0]!.id;
              await withBypassContext(() =>
                db.execute(
                  sql`insert into document_lines(org_id,document_id,line_number,account_id,subsidiary_id,description,quantity,unit_price,amount,tax_amount) values(${fx.orgId},${invoice},1,${expense},${hidden},'Other entity remittance',1,999,999,0)`,
                ),
              );
              assert.ok(
                (
                  await withOrgContext(fx.orgId, () =>
                    payrollRemittanceSummary(fx.orgId, range),
                  )
                )
                  .flatMap((g) => g.existingBills)
                  .some((b) => b.documentId === invoice),
                "the unfiltered fixture actually contains the matching bill",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    payrollRemittanceSummary(
                      fx.orgId,
                      range,
                      new Set([fx.subsidiaryId]),
                    ),
                  )
                )
                  .flatMap((g) => g.existingBills)
                  .some((b) => b.documentId === invoice),
                false,
              );
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              routeState.gate = gate;
              const loaded = await withOrgContext(fx.orgId, () => scopedRemittanceSummary(gate, range));
              const response = await withOrgContext(fx.orgId, () =>
                remittanceGet(
                  new Request(
                    `http://localhost/api/payroll/remittances?from=${range.from}&to=${range.to}`,
                  ),
                ),
              );
              assert.equal(response.status, 200);
              const body = (await response.json()) as { groups: (typeof group)[] };
              const loaderLeaks = loaded
                ?.flatMap((g) => g.existingBills)
                .some((b) => b.documentId === invoice);
              const apiLeaks = body.groups
                .flatMap((g) => g.existingBills)
                .some((b) => b.documentId === invoice);
              assert.deepEqual(
                { loaderLeaks, apiLeaks },
                { loaderLeaks: false, apiLeaks: false },
                "both real transports must exclude the hidden bill",
              );
              await assert.rejects(
                withOrgContext(fx.orgId, () =>
                  createRemittanceBill(fx.orgId, fx.actorId, {
                    partyId: vendor,
                    ...range,
                    filingAccountId: group.filingAccount.id,
                    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
                  }),
                ),
                (error) =>
                  error instanceof Error &&
                  error.message === "nothing to remit to this vendor for the period",
                "duplicate prevention must not reveal a hidden bill number",
              );
              const refused = await withOrgContext(fx.orgId, () =>
                remittancePost(
                  new Request("http://localhost/api/payroll/remittances", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "create-bill",
                      partyId: vendor,
                      ...range,
                      filingAccountId: group.filingAccount.id,
                    }),
                  }),
                ),
              );
              assert.equal(refused.status, 422);
              assert.deepEqual(await refused.json(), {
                error: "nothing to remit to this vendor for the period",
              });
              const bills = (
                await withOrgContext(fx.orgId, () =>
                  db.execute<{ count: number }>(
                    sql`select count(*)::int as count from documents where org_id=${fx.orgId} and kind='vendor_bill'`,
                  ),
                )
              ).rows[0]!.count;
              assert.equal(
                bills,
                1,
                "a hidden overlap still prevents another liability bill",
              );
              routeState.gate = { ...gate, allowedSubsidiaryIds: null };
              const unrestricted = await withOrgContext(fx.orgId, () =>
                remittanceGet(
                  new Request(
                    `http://localhost/api/payroll/remittances?from=${range.from}&to=${range.to}`,
                  ),
                ),
              );
              assert.ok(
                ((await unrestricted.json()) as { groups: (typeof group)[] }).groups
                  .flatMap((g) => g.existingBills)
                  .some((b) => b.documentId === invoice),
              );
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );
  } },
  { label: "payroll roe source scope", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;
        const state: { gate: Authz | null } = { gate: null };
        (globalThis as typeof globalThis & Record<symbol, unknown>)[
          Symbol.for("openbooks.roe-source-route")
        ] = state;
        registerHooks({
          resolve(s, c, n) {
            if (
              s === "../../../../../lib/feature-gates" &&
              c.parentURL?.endsWith("/api/payroll/year-end/file/route.ts")
            )
              return {
                shortCircuit: true,
                url:
                  "data:text/javascript," +
                  encodeURIComponent(
                    "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.roe-source-route')].gate}",
                  ),
              };
            return n(s, c);
          },
        });
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { seedAdoption, calculatedRun, seedRoeIssuanceFixture } =
          await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
        const { dropScratchOrgReporting } =
          await import("@openbooks/engine/src/testing/fixtures.ts");
        const { commitPayRun } = await import("@openbooks/engine/src/payroll/run-commit.ts");
        const { roeRecord } = await import("@openbooks/engine/src/payroll/yearend.ts");
        const { guardPayrollFilingRowIds, guardPayrollFilingData } =
          await import("../app/api/payroll/subsidiary-scope");
        const { POST } = await import("../app/api/payroll/year-end/file/route");

        test(
          "ROE row, population and selected-file access checks historical earnings and current profile ownership",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              await withBypassContext(async () => {
                await db.execute(sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
                await seedRoeIssuanceFixture(fx.orgId, fx.employeeId);
              });
              const { input } = await withOrgContext(fx.orgId, () => calculatedRun(fx));
              await withOrgContext(fx.orgId, () => commitPayRun(input));
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read", "payroll.run"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              assert.equal(
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    gate,
                    "CA",
                    "roe",
                    [fx.employeeId],
                    2026,
                  ),
                ),
                null,
              );
              const movedId = randomUUID();
              await withBypassContext(async () => {
                await db.execute(
                  sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${movedId},${fx.orgId},${fx.subsidiaryId},'Transferred ROE employee','CAD','CA')`,
                );
                await db.execute(
                  sql`update parties set subsidiary_id=${movedId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
                );
              });
              const record = await withOrgContext(fx.orgId, () =>
                roeRecord(fx.orgId, fx.employeeId),
              );
              assert.equal(record?.totalInsurableEarnings, "240.0000");
              assert.equal(record?.periods.length, 1);
              const moved = { ...gate, allowedSubsidiaryIds: new Set([movedId]) };
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    guardPayrollFilingRowIds(
                      moved,
                      "CA",
                      "roe",
                      [fx.employeeId],
                      2026,
                    ),
                  )
                )?.status,
                404,
                "the current employer cannot read the earlier employer earnings",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    guardPayrollFilingRowIds(
                      moved,
                      "CA",
                      "roe",
                      [fx.employeeId],
                      2025,
                    ),
                  )
                )?.status,
                404,
                "ROE source reads span years, independently of the population year",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    guardPayrollFilingData(
                      moved,
                      "CA",
                      "roe",
                      { columns: [], rowKey: "id", rows: [{ id: fx.employeeId }] },
                      2026,
                    ),
                  )
                )?.status,
                404,
              );
              state.gate = moved;
              const response = await withOrgContext(fx.orgId, () =>
                POST(
                  new Request("http://localhost/api/payroll/year-end/file", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      country: "CA",
                      filing: "roe",
                      year: 2026,
                      employees: `${fx.employeeId}:A`,
                    }),
                  }),
                ),
              );
              assert.equal(
                response.status,
                404,
                "selected employee files use the same source boundary",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    guardPayrollFilingRowIds(
                      gate,
                      "CA",
                      "roe",
                      [fx.employeeId],
                      2026,
                    ),
                  )
                )?.status,
                404,
                "historical access alone cannot disclose the current employment profile",
              );
              const combined = {
                ...gate,
                allowedSubsidiaryIds: new Set([fx.subsidiaryId, movedId]),
              };
              assert.equal(
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    combined,
                    "CA",
                    "roe",
                    [fx.employeeId],
                    2026,
                  ),
                ),
                null,
              );
              const accountOwner = randomUUID();
              await withBypassContext(async () => {
                await db.execute(
                  sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${accountOwner},${fx.orgId},${fx.subsidiaryId},'Hidden ROE account','CAD','CA')`,
                );
                const account = (
                  await db.execute<{ id: string }>(
                    sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'CA','ca_rp','123456789RP0001','ROE profile account',${accountOwner}) returning id`,
                  )
                ).rows[0]!.id;
                await db.execute(
                  sql`update employee_payroll_profiles set filing_account_id=${account} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`,
                );
              });
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    guardPayrollFilingRowIds(
                      combined,
                      "CA",
                      "roe",
                      [fx.employeeId],
                      2026,
                    ),
                  )
                )?.status,
                404,
                "the ROE header filing account is also protected",
              );
              assert.equal(
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    {
                      ...combined,
                      allowedSubsidiaryIds: new Set([
                        ...combined.allowedSubsidiaryIds!,
                        accountOwner,
                      ]),
                    },
                    "CA",
                    "roe",
                    [fx.employeeId],
                    2026,
                  ),
                ),
                null,
              );
              assert.equal(
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    { ...gate, allowedSubsidiaryIds: null },
                    "CA",
                    "roe",
                    [fx.employeeId],
                    2026,
                  ),
                ),
                null,
              );
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );

        test(
          "ROE authorization follows the declared period window and includes final-date ties outside it",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              const hidden = randomUUID();
              await withBypassContext(async () => {
                await db.execute(
                  sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
                );
                await db.execute(
                  sql`update pay_schedules set frequency='monthly',periods_per_year=12 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
                );
                await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Historical source outside the window','CAD','CA')`);
                await seedRoeIssuanceFixture(fx.orgId, fx.employeeId);
              });
              // Minimal committed source history for exercising the selector itself.
              // Thirteen monthly-window stubs supersede one older hidden source.
              await withBypassContext(() => db.transaction(async (tx) => {
                for (let index = 0; index <= 13; index++) {
                  const documentId = randomUUID();
                  const stubId =
                    index === 0 ? "00000000-0000-4000-8000-000000000001" : randomUUID();
                  const date =
                    index === 0
                      ? "2026-06-30"
                      : `2026-07-${String(index).padStart(2, "0")}`;
                  await tx.execute(
                    sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${documentId},${fx.orgId},'pay_run',${`ROE-WINDOW-${index}`},${index === 0 ? hidden : fx.subsidiaryId},${date},'CAD','draft')`,
                  );
                  await tx.execute(
                    sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${documentId},${fx.orgId},${fx.scheduleId},${date},${date},${date},2026,'committed','bonus')`,
                  );
                  await tx.execute(
                    sql`insert into pay_stubs(id,org_id,pay_run_document_id,employee_party_id,employment_id,country,country_source,province,periods_per_year,pay_date,tax_year,currency_code,insurable_earnings) values(${stubId},${fx.orgId},${documentId},${fx.employeeId},${fx.employmentId},'CA','calculation','ON',12,${date},2026,'CAD',${index === 0 ? "999" : "1"})`,
                  );
                }
              }));
              const gate = {
                user: { orgId: fx.orgId, id: fx.actorId },
                permissions: new Set(["payroll.read"]),
                allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
              } as Authz;
              assert.equal(
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    gate,
                    "CA",
                    "roe",
                    [fx.employeeId],
                    2026,
                  ),
                ),
                null,
                "older history outside the actual window does not block access",
              );
              const before = await withOrgContext(fx.orgId, () =>
                roeRecord(fx.orgId, fx.employeeId),
              );
              assert.equal(before?.periods.length, 13);
              assert.equal(before?.totalInsurableEarnings, "13.0000");
              // All records now tie on the final pay date. The hidden UUID sorts last and
              // stays outside Block 15, but Block 17 reads that complete final date.
              await withBypassContext(() =>
                db.execute(
                  sql`update pay_stubs set pay_date='2026-07-13' where org_id=${fx.orgId}`,
                ),
              );
              const tied = await withOrgContext(fx.orgId, () =>
                roeRecord(fx.orgId, fx.employeeId),
              );
              assert.equal(tied?.periods.length, 13);
              assert.equal(
                tied?.totalInsurableEarnings,
                "13.0000",
                "window ties have deterministic ordering",
              );
              assert.equal(
                (
                  await withOrgContext(fx.orgId, () =>
                    guardPayrollFilingRowIds(
                      gate,
                      "CA",
                      "roe",
                      [fx.employeeId],
                      2026,
                    ),
                  )
                )?.status,
                404,
                "the separate final-date source must also be authorized",
              );
            } finally {
              await dropScratchOrgReporting(fx.orgId);
            }
          },
        );
  } },
] as const;

for (const row of payrollFilingScopeCases) await row.register();
