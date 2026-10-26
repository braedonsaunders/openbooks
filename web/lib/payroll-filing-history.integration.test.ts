import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { resolveEngineSpecifier } from "../testing/engine-resolve-hooks.ts";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { commitPayRun } from "@openbooks/engine/payroll/run-commit";
import {
  dropScratchOrgReporting,
  grantScratchPermissions,
} from "@openbooks/engine/testing/fixtures";
import {
  seedAdoption,
  calculatedRun,
  markLegacy,
} from "@openbooks/engine/testing/payroll/filing-test-fixtures";
// Session-boundary fixture for the remittance route's real authorization
// chain. The route resolves its caller through defineRoute →
// guardFeaturePermission → guardPermission → getAuthz → currentUser, which
// normally reaches Next's request cookies; those do not exist in this plain
// Node route harness, so only that cookie→identity step is scripted. Every
// downstream decision — role assignments, overrides, subsidiary scope,
// feature state — executes for real against the scratch org.
const sessionKey = Symbol.for("openbooks.payroll-filing-history-session");
interface FilingSession {
  user: {
    id: string;
    email: string;
    name: string;
    roles: ReadonlyArray<{ key: string; name: string }>;
    orgId: string;
    envKind: "sandbox";
    productionOrgId: string;
    isSuperAdmin: false;
    homeUserId: string;
    homeOrgId: string;
  } | null;
}
const filingSession: FilingSession = { user: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[sessionKey] = filingSession;

// Real authorization scaffolding for route calls: the session seam above
// supplies only the cookie→identity step. Permission grants, the payroll
// feature flag, and the actor's subsidiary restriction are ordinary
// production rows, so every refusal below is computed by the real chain.
async function establishFilingSession(
  fx: { orgId: string; actorId: string },
  grants: string[],
  subsidiaryIds: string[] | null,
): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":true}'::jsonb) where id=${fx.orgId}`,
    );
    await grantScratchPermissions(fx.orgId, fx.actorId, grants);
    const restriction = subsidiaryIds === null ? { mode: "all" } : { mode: "list", subsidiaryIds };
    await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify(restriction)}::jsonb
      where org_id=${fx.orgId} and key='admin'`);
  });
  filingSession.user = {
    id: fx.actorId,
    email: `u-${fx.actorId.slice(0, 8)}@scratch.test`,
    name: "Admin",
    roles: [{ key: "admin", name: "admin" }],
    orgId: fx.orgId,
    envKind: "sandbox",
    productionOrgId: fx.orgId,
    isSuperAdmin: false,
    homeUserId: fx.actorId,
    homeOrgId: fx.orgId,
  };
}

// This file lives in web/lib; route aliases resolve against web/.
const webRoot = new URL("../", import.meta.url);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Engine contracts stay pinned to this checkout; other workspaces retain
    // their native package export resolution, including named subpaths.
    const engine = resolveEngineSpecifier(specifier);
    if (engine) return nextResolve(engine, context);
    if (specifier === "@openbooks/schema") {
      return nextResolve(new URL("../schema/src/index.ts", webRoot).href, context);
    }
    // Only the cookie→identity step is scripted: the real permission reader,
    // feature gate, and scope resolver run against the fixture below.
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(`
          export async function currentUser() { return globalThis[Symbol.for('openbooks.payroll-filing-history-session')].user; }
        `),
        shortCircuit: true,
      };
    }
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    // next/navigation only redirects disabled features elsewhere; the payroll
    // feature stays enabled here, so the target never runs in this harness.
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
    if (specifier === "next/navigation") {
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(`
          export function redirect() { throw new Error('redirect is unavailable in the route harness'); }
        `),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const routeUrl = "../app/api/payroll/remittances/route.ts?filing-history";
const { GET, POST } = (await import(
  routeUrl
)) as typeof import("../app/api/payroll/remittances/route.ts");
// The session seam above has served every module load it will ever serve:
// the route handlers are imported and the real authorization chain is
// cached. Deregister now so the fixture cannot leak into the later
// consolidated rival route fixtures below.
hooks.deregister();
// Later consolidated blocks import engine modules dynamically; keep the
// workspace and server-only mapping live for them without any gate logic.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const engine = resolveEngineSpecifier(specifier);
    if (engine) return nextResolve(engine, context);
    if (specifier === "@openbooks/schema") {
      return nextResolve(new URL("../schema/src/index.ts", webRoot).href, context);
    }
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const get = (orgId: string) =>
  withOrgContext(orgId, () =>
    GET(new Request("http://openbooks.test/api/payroll/remittances?from=2026-07-01&to=2026-07-31")),
  );

for (const change of ["hidden-original", "inactive-original", "unknown"] as const) {
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
        // The hidden employer's run is genuinely invisible to this caller:
        // payroll.read, the payroll flag, and the visible-entity restriction
        // all resolve through production reads under the session seam above.
        await establishFilingSession(fx, ["payroll.read"], [fx.subsidiaryId]);
        if (change === "hidden-original") {
          await withBypassContext(() =>
            db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${second} where org_id=${fx.orgId}`,
            ),
          );
          const response = await get(fx.orgId);
          assert.equal(response.status, 404);
          assert.deepEqual(await response.json(), { error: "not_found" });
        } else if (change === "inactive-original") {
          await withBypassContext(() =>
            db.execute(
              sql`update payroll_filing_accounts set is_active=false where id=${first} and org_id=${fx.orgId}`,
            ),
          );
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
              (g: { hasUnknownFilingAccount?: boolean }) => g.hasUnknownFilingAccount,
            ),
            "the legacy run surfaces unfiled without failing the route",
          );
        }
      } finally {
        filingSession.user = null;
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

const consolidatedRows = [
  {
    label: "payroll filing history scope",
    register: async () => {
      const assert: typeof import("node:assert/strict") = (await import("node:assert/strict"))
        .default;
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
      const { db, withBypassContext, withOrgContext } =
        await import("@openbooks/engine/platform/db");
      const { seedAdoption, calculatedRun } =
        await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
      const { dropScratchOrgReporting } = await import("@openbooks/engine/testing/fixtures");
      const { commitPayRun } = await import("@openbooks/engine/payroll/run-commit");
      const { orgYearEndFilings } = await import("@openbooks/engine/payroll/yearend");
      const { guardPayrollYearEndFilings, guardPayrollFilingData, guardPayrollFilingRowIds } =
        await import("../app/api/payroll/subsidiary-scope");

      test(
        "annual filing and amendment access stays with the historical employer after a transfer",
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
              await withOrgContext(fx.orgId, () => guardPayrollYearEndFilings(gate, filings, 2026)),
              null,
              "original employer retains the issued-year population",
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingData(gate, "CA", "t4", t4.data, 2026),
              ),
              null,
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
              ),
              null,
              "stored amendment rows use the same historical scope",
            );
            const moved = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollYearEndFilings(moved, filings, 2026),
                )
              )?.status,
              404,
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(moved, "CA", "t4", [rowId], 2026),
                )
              )?.status,
              404,
              "new employer cannot read earlier payroll",
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    { ...gate, allowedSubsidiaryIds: new Set() },
                    "CA",
                    "t4",
                    [rowId],
                    2026,
                  ),
                )
              )?.status,
              404,
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(
                  { ...gate, allowedSubsidiaryIds: null },
                  "CA",
                  "t4",
                  [rowId],
                  2026,
                ),
              ),
              null,
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2025),
                )
              )?.status,
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
            await withBypassContext(() =>
              db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ),
            );
            const { input } = await withBypassContext(() => calculatedRun(fx));
            await withOrgContext(fx.orgId, () => commitPayRun(input));
            await withBypassContext(() =>
              db.execute(
                sql`insert into payroll_opening_balances(org_id,employee_party_id,tax_year,taxable_ytd,created_by,updated_by) values(${fx.orgId},${fx.employeeId},2026,100,${fx.actorId},${fx.actorId})`,
              ),
            );
            const gate = {
              user: { orgId: fx.orgId, id: fx.actorId },
              permissions: new Set(["payroll.read"]),
              allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
            } as Authz;
            const rowId = `${fx.employeeId}:ON:`;
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
              ),
              null,
              "opening carry-in retains its employee boundary alongside posted payroll",
            );
            const hidden = randomUUID();
            await withBypassContext(() =>
              db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Opening balance employee transfer','CAD','CA')`,
              ),
            );
            await withBypassContext(() =>
              db.execute(
                sql`update parties set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ),
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
                )
              )?.status,
              404,
              "unstamped carry-in cannot be assigned to an original pay-run employer by inference",
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    { ...gate, allowedSubsidiaryIds: new Set([hidden]) },
                    "CA",
                    "t4",
                    [rowId],
                    2026,
                  ),
                )
              )?.status,
              404,
              "current employee ownership cannot grant access to another employer payroll",
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(
                  { ...gate, allowedSubsidiaryIds: new Set([hidden, fx.subsidiaryId]) },
                  "CA",
                  "t4",
                  [rowId],
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
    },
  },
  {
    label: "payroll filing row scope",
    register: async () => {
      const assert: typeof import("node:assert/strict") = (await import("node:assert/strict"))
        .default;
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
      const { db, withBypassContext, withOrgContext } =
        await import("@openbooks/engine/platform/db");
      const { seedAdoption } =
        await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
      const { dropScratchOrgReporting } = await import("@openbooks/engine/testing/fixtures");
      const { guardPayrollFilingRowIds, guardPayrollFilingData, payrollRowScope } =
        await import("../app/api/payroll/subsidiary-scope");

      test(
        "native UUIDv7 filing accounts retain their entity authorization and invalid suffixes fail closed",
        { skip: !process.env.OPENBOOKS_DB_URL },
        async () => {
          const fx = await withBypassContext(() => seedAdoption());
          try {
            await withBypassContext(() =>
              db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ),
            );
            const hidden = randomUUID();
            await withBypassContext(() =>
              db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Hidden filing entity','CAD','CA')`,
              ),
            );
            const account = (
              await withBypassContext(() =>
                db.execute<{ id: string }>(
                  sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'CA','ca_rp','123456789RP0001','Native filing account',${hidden}) returning id`,
                  "objects",
                ),
              )
            )[0]!.id;
            assert.equal(account[14], "7", "fixture uses the database native UUID generator");
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
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
                )
              )?.status,
              404,
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingData(
                    gate,
                    "CA",
                    "t4",
                    {
                      columns: [],
                      rowKey: "rowId",
                      rows: [{ rowId }],
                    },
                    2026,
                  ),
                )
              )?.status,
              404,
            );
            await withBypassContext(() =>
              db.execute(
                sql`update payroll_filing_accounts set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${account}`,
              ),
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
              ),
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
                  await withOrgContext(fx.orgId, () =>
                    guardPayrollFilingRowIds(gate, country, filing, [malformed], 2026),
                  )
                )?.status,
                // Item 34: a row id that fails the filing's grammar is MALFORMED
                // INPUT, refused for every caller (422) before the actor's scope is
                // consulted — not a scope 404, which stays reserved for rows that
                // exist outside the caller's subsidiaries.
                422,
              );
            }
            const employee = (
              await withBypassContext(() =>
                db.execute<{ id: string }>(
                  sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${fx.orgId},'person','Native payroll employee',${fx.subsidiaryId}) returning id`,
                  "objects",
                ),
              )
            )[0]!.id;
            assert.equal(employee[14], "7");
            for (const filing of ["roe", "rl1"])
              assert.deepEqual(payrollRowScope("CA", filing, employee), {
                employees: [employee],
                accounts: [],
              });
            assert.deepEqual(payrollRowScope("CA", "t4", `${employee}:ON:${account}`), {
              employees: [employee],
              accounts: [account],
            });
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
    },
  },
] as const;

for (const row of consolidatedRows) await row.register();

const payrollFilingScopeCases = [
  {
    label: "payroll 941 source scope",
    register: async () => {
      const assert: typeof import("node:assert/strict") = (await import("node:assert/strict"))
        .default;
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
      const { db, withBypassContext, withOrgContext } =
        await import("@openbooks/engine/platform/db");
      const { seedAdoption } =
        await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
      const { dropScratchOrgReporting } = await import("@openbooks/engine/testing/fixtures");
      const { form941Worksheet } = await import("@openbooks/engine/payroll/yearend");
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
            await withBypassContext(() =>
              db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Hidden Form 941 employer','CAD','US')`,
              ),
            );
            const account = (
              await withBypassContext(() =>
                db.execute<{ id: string }>(
                  sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'US','us_ein','12-3456789','Hidden source EIN',${hidden}) returning id`,
                  "objects",
                ),
              )
            )[0]!.id;
            await withBypassContext(() =>
              db.execute(
                sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${doc},${fx.orgId},'pay_run','941-SOURCE',${hidden},'2026-07-15','USD','draft')`,
              ),
            );
            await withBypassContext(() =>
              db.execute(
                sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${doc},${fx.orgId},${fx.scheduleId},'2026-07-15','2026-07-15','2026-07-15',2026,'committed','bonus')`,
              ),
            );
            await withBypassContext(() =>
              db.execute(
                sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,employment_id,country,country_source,filing_account_id,filing_account_source,province,periods_per_year,pay_date,tax_year,currency_code,pensionable_earnings) values(${fx.orgId},${doc},${fx.employeeId},${fx.employmentId},'US','calculation',${account},'calculation','NY',26,'2026-07-15',2026,'USD',100)`,
              ),
            );
            const quarters = await withOrgContext(fx.orgId, () => form941Worksheet(fx.orgId, 2026));
            assert.equal(quarters.length, 1);
            const gate = {
              user: { orgId: fx.orgId, id: fx.actorId },
              permissions: new Set(["payroll.read"]),
              allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
            } as Authz;
            const denied = await withOrgContext(fx.orgId, () =>
              guardPayrollFilingRowIds(gate, "US", "941", [`${account}:3`], 2026),
            );

            assert.equal(
              denied?.status,
              404,
              "a scoped operator cannot authorize a hidden EIN and its payroll sources",
            );
            await withBypassContext(() =>
              db.execute(
                sql`update payroll_filing_accounts set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${account}`,
              ),
            );
            const child = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(child, "US", "941", [`${account}:3`], 2026),
              ),
              null,
              "visible account and source remain accessible",
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(child, "US", "941", [`${account}:2`], 2026),
                )
              )?.status,
              404,
              "a different quarter cannot borrow source ownership",
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(child, "US", "941", [`${account}:3`], 2025),
                )
              )?.status,
              404,
              "a different year cannot borrow source ownership",
            );
            const unassignedDoc = randomUUID();
            await withBypassContext(() =>
              db.execute(
                sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${unassignedDoc},${fx.orgId},'pay_run','941-UNASSIGNED',${hidden},'2026-07-16','USD','draft')`,
              ),
            );
            await withBypassContext(() =>
              db.execute(
                sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${unassignedDoc},${fx.orgId},${fx.scheduleId},'2026-07-16','2026-07-16','2026-07-16',2026,'committed','bonus')`,
              ),
            );
            await withBypassContext(() =>
              db.execute(
                sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,employment_id,country,country_source,filing_account_id,filing_account_source,province,periods_per_year,pay_date,tax_year,currency_code,pensionable_earnings) values(${fx.orgId},${unassignedDoc},${fx.employeeId},${fx.employmentId},'US','calculation',null,'calculation','NY',26,'2026-07-16',2026,'USD',50)`,
              ),
            );
            const all = await withOrgContext(fx.orgId, () => form941Worksheet(fx.orgId, 2026));
            assert.equal(all.length, 2);
            assert.deepEqual(payrollRowScope("US", "941", ":3"), {
              employees: [],
              accounts: [],
            });
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(child, "US", "941", [":3"], 2026),
                )
              )?.status,
              404,
              "unassigned aggregate still requires root visibility",
            );
            const rowIds = all.map((q) => `${q.filingAccountId ?? ""}:${q.quarter}`);
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(child, "US", "941", rowIds, 2026),
                )
              )?.status,
              404,
              "a visible assigned account cannot mask an unassigned row",
            );
            const both = {
              ...gate,
              allowedSubsidiaryIds: new Set([fx.subsidiaryId, hidden]),
            };
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(both, "US", "941", rowIds, 2026),
              ),
              null,
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingData(
                  both,
                  "US",
                  "941",
                  { columns: [], rowKey: "id", rows: rowIds.map((id) => ({ id })) },
                  2026,
                ),
              ),
              null,
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingData(
                    child,
                    "US",
                    "941",
                    { columns: [], rowKey: "id", rows: rowIds.map((id) => ({ id })) },
                    2026,
                  ),
                )
              )?.status,
              404,
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(
                    { ...gate, allowedSubsidiaryIds: new Set() },
                    "US",
                    "941",
                    rowIds,
                    2026,
                  ),
                )
              )?.status,
              404,
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(
                  { ...gate, allowedSubsidiaryIds: null },
                  "US",
                  "941",
                  rowIds,
                  2026,
                ),
              ),
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
            await withBypassContext(() =>
              db.execute(sql`update pay_runs set run_status='voided' where org_id=${fx.orgId}`),
            );
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(both, "US", "941", rowIds, 2026),
              ),
              null,
              "voided payroll retains ownership evidence for stored correction artifacts",
            );
          } finally {
            await dropScratchOrgReporting(fx.orgId);
          }
        },
      );
    },
  },
  {
    label: "payroll remittance history scope",
    register: async () => {
      const assert: typeof import("node:assert/strict") = (await import("node:assert/strict"))
        .default;
      const { randomUUID } = await import("node:crypto");
      const test = (await import("node:test")).default;
      type Authz = import("./authz").Authz;
      // Route handlers come from the top-level import above, already loaded
      // under the single session-boundary seam; only cookie→identity is
      // scripted via establishFilingSession, and the gate below shapes just
      // the direct scopedRemittanceSummary calls.
      const { sql } = await import("drizzle-orm");
      const { db, withBypassContext, withOrgContext } =
        await import("@openbooks/engine/platform/db");
      const { seedAdoption, calculatedRun } =
        await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
      const { dropScratchOrgReporting } = await import("@openbooks/engine/testing/fixtures");
      const { commitPayRun } = await import("@openbooks/engine/payroll/run-commit");
      const { guardRemittancePeriod } = await import("../app/api/payroll/subsidiary-scope");
      const { payrollRemittanceSummary, createRemittanceBill } =
        await import("@openbooks/engine/payroll/remittance");

      const { scopedRemittanceSummary } = await import("./payroll-scoped-views");

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
              await withOrgContext(fx.orgId, () =>
                guardRemittancePeriod(gate, range.from, range.to),
              ),
              null,
            );
            const before = await withOrgContext(fx.orgId, () =>
              payrollRemittanceSummary(fx.orgId, range, gate.allowedSubsidiaryIds),
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
              await withOrgContext(fx.orgId, () =>
                guardRemittancePeriod(gate, range.from, range.to),
              ),
              null,
              "original employer retains its history",
            );
            assert.deepEqual(
              await withOrgContext(fx.orgId, () =>
                payrollRemittanceSummary(fx.orgId, range, gate.allowedSubsidiaryIds),
              ),
              before,
            );
            const moved = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardRemittancePeriod(moved, range.from, range.to),
                )
              )?.status,
              404,
              "new employer cannot read the earlier employer payroll",
            );
            assert.deepEqual(
              await withOrgContext(fx.orgId, () =>
                payrollRemittanceSummary(fx.orgId, range, moved.allowedSubsidiaryIds),
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
              await withOrgContext(fx.orgId, () =>
                payrollRemittanceSummary(fx.orgId, range, new Set()),
              ),
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
            const filingAccountId = randomUUID();
            await withBypassContext(() =>
              db.execute(sql`insert into payroll_filing_accounts
                (id,org_id,country,program_type,account_number,name,subsidiary_id,remitter_type,is_default)
                values(${filingAccountId},${fx.orgId},'CA','ca_rp','123456789RP0001','Shared remitter',${fx.subsidiaryId},'regular',true)`),
            );
            await withBypassContext(() =>
              db.execute(sql`update employee_payroll_profiles
                set filing_account_id=${filingAccountId} where org_id=${fx.orgId}`),
            );
            await withBypassContext(() =>
              db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              ),
            );
            const { input } = await withBypassContext(() => calculatedRun(fx));
            await withOrgContext(fx.orgId, () => commitPayRun(input));
            const range = { from: "2026-07-01", to: "2026-07-31" };
            const group = (
              await withOrgContext(fx.orgId, () => payrollRemittanceSummary(fx.orgId, range))
            )[0]!;
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
                  "objects",
                ),
              )
            )[0]!.id;
            await withBypassContext(() =>
              db.execute(
                sql`insert into document_lines(org_id,document_id,line_number,account_id,subsidiary_id,description,quantity,unit_price,amount,tax_amount) values(${fx.orgId},${invoice},1,${expense},${hidden},'Other entity remittance',1,999,999,0)`,
              ),
            );
            assert.ok(
              (await withOrgContext(fx.orgId, () => payrollRemittanceSummary(fx.orgId, range)))
                .flatMap((g) => g.existingBills)
                .some((b) => b.documentId === invoice),
              "the unfiltered fixture actually contains the matching bill",
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  payrollRemittanceSummary(fx.orgId, range, new Set([fx.subsidiaryId])),
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
            // Both transports below run the real authorization chain under
            // the file's session seam: read/run grants, the payroll flag,
            // and the visible-entity restriction are production rows. The
            // gate object above shapes only the direct loader call.
            await establishFilingSession(fx, ["payroll.read", "payroll.run"], [fx.subsidiaryId]);
            const loaded = await withOrgContext(fx.orgId, () =>
              scopedRemittanceSummary(gate, range),
            );
            const response = await withOrgContext(fx.orgId, () =>
              GET(
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
              POST(
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
                  "objects",
                ),
              )
            )[0]!.count;
            assert.equal(bills, 1, "a hidden overlap still prevents another liability bill");
            await withBypassContext(() =>
              db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb
                  where org_id=${fx.orgId} and key='admin'`),
            );
            const unrestricted = await withOrgContext(fx.orgId, () =>
              GET(
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
            filingSession.user = null;
            await dropScratchOrgReporting(fx.orgId);
          }
        },
      );
    },
  },
  {
    label: "payroll roe source scope",
    register: async () => {
      const assert: typeof import("node:assert/strict") = (await import("node:assert/strict"))
        .default;
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
      const { db, withBypassContext, withOrgContext } =
        await import("@openbooks/engine/platform/db");
      const { seedAdoption, calculatedRun, seedRoeIssuanceFixture } =
        await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
      const { dropScratchOrgReporting } = await import("@openbooks/engine/testing/fixtures");
      const { commitPayRun } = await import("@openbooks/engine/payroll/run-commit");
      const { roeRecord, roeSourceScope } = await import("@openbooks/engine/payroll/yearend");
      const { guardPayrollFilingRowIds, guardPayrollFilingData, guardPayrollFilingAccounts } =
        await import("../app/api/payroll/subsidiary-scope");
      const { POST } = await import("../app/api/payroll/year-end/file/route");

      test(
        "ROE row, population and selected-file access checks historical earnings and current profile ownership",
        { skip: !process.env.OPENBOOKS_DB_URL },
        async () => {
          const fx = await withBypassContext(() => seedAdoption());
          try {
            await withBypassContext(async () => {
              await db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
              );
              const filingAccountId = randomUUID();
              assert.equal(
                (
                  await db.execute(
                    sql`insert into payroll_filing_accounts
                  (id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
                  values (${filingAccountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp',
                    '123456789RP0001','Retained employer payroll account',true) returning id`,
                    "objects",
                  )
                ).length,
                1,
              );
              assert.equal(
                (
                  await db.execute(
                    sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
                  where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} returning employee_party_id`,
                    "objects",
                  )
                ).length,
                1,
              );
              await seedRoeIssuanceFixture(fx.orgId, fx.employeeId);
              // This scenario's only wages were earned on July 14 in the
              // committed July 5–18 schedule, before the interruption.
              assert.equal(
                (
                  await db.execute(
                    sql`update payroll_roe_separation_events
                  set first_day_worked='2026-07-14',last_insurable_earnings_on='2026-07-14',
                      interruption_on='2026-07-15'
                  where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}
                    and status='confirmed' returning id`,
                    "objects",
                  )
                ).length,
                1,
              );
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
                guardPayrollFilingRowIds(gate, "CA", "roe", [fx.employeeId], 2026),
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
            const record = await withOrgContext(fx.orgId, () => roeRecord(fx.orgId, fx.employeeId));
            assert.equal(record?.totalInsurableEarnings, "240.0000");
            assert.equal(record?.periods.length, 1);
            const moved = { ...gate, allowedSubsidiaryIds: new Set([movedId]) };
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(moved, "CA", "roe", [fx.employeeId], 2026),
                )
              )?.status,
              404,
              "the current employer cannot read the earlier employer earnings",
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(moved, "CA", "roe", [fx.employeeId], 2025),
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
            // The selected-file POST runs the real chain under the file's
            // session seam: the run grant, payroll flag, and moved-entity
            // restriction are production rows, so the 404 below is the
            // source boundary refusing — not a missing fixture.
            await establishFilingSession(fx, ["payroll.run"], [movedId]);
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
              `selected employee files use the same source boundary: ${JSON.stringify(await response.clone().json())}`,
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingRowIds(gate, "CA", "roe", [fx.employeeId], 2026),
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
                guardPayrollFilingRowIds(combined, "CA", "roe", [fx.employeeId], 2026),
              ),
              null,
            );
            const retainedSources = await withOrgContext(fx.orgId, () =>
              roeSourceScope(fx.orgId, [fx.employeeId]),
            );
            const retainedAccounts = [
              ...new Set(retainedSources.map((source) => source.filingAccountId)),
            ];
            assert.equal(retainedAccounts.length, 1);
            assert.ok(retainedAccounts[0]);
            const accountOwner = randomUUID(),
              currentAccountId = randomUUID();
            await withBypassContext(async () => {
              await db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${accountOwner},${fx.orgId},${fx.subsidiaryId},'Hidden ROE account','CAD','CA')`,
              );
              const account = (
                await db.execute<{ id: string }>(
                  sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,subsidiary_id) values(${currentAccountId},${fx.orgId},'CA','ca_rp','123456789RP0002','Current profile payroll account',${accountOwner}) returning id`,
                  "objects",
                )
              )[0]!.id;
              await db.execute(
                sql`update employee_payroll_profiles set filing_account_id=${account} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`,
              );
            });
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(combined, "CA", "roe", [fx.employeeId], 2026),
              ),
              null,
              "An unrelated current-profile account cannot replace the selected historical ROE account",
            );
            assert.deepEqual(
              await withOrgContext(fx.orgId, () => roeSourceScope(fx.orgId, [fx.employeeId])),
              retainedSources,
            );
            assert.ok(
              retainedSources.every((source) => source.filingAccountId !== currentAccountId),
            );
            assert.equal(
              (
                await withOrgContext(fx.orgId, () =>
                  guardPayrollFilingAccounts(combined, [currentAccountId], true),
                )
              )?.status,
              404,
              "An explicitly requested hidden account still requires its own entity authority",
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
            filingSession.user = null;
            await dropScratchOrgReporting(fx.orgId);
          }
        },
      );

      test(
        "ROE authorization uses the monthly service calendar and refuses conflicting final-period employer evidence",
        { skip: !process.env.OPENBOOKS_DB_URL },
        async () => {
          const fx = await withBypassContext(() => seedAdoption());
          try {
            const hidden = randomUUID(),
              accountId = randomUUID();
            await withBypassContext(async () => {
              await db.execute(
                sql`update pay_schedules set frequency='monthly',periods_per_year=12 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
              );
              await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
                  values(${hidden},${fx.orgId},${fx.subsidiaryId},'Other source employer','CAD','CA')`);
              await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
                  values(${accountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Retained payroll account',true)`);
              await db.execute(
                sql`update employee_payroll_profiles set filing_account_id=${accountId} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`,
              );
              await seedRoeIssuanceFixture(fx.orgId, fx.employeeId);
              await db.execute(sql`update payroll_roe_separation_events set first_day_worked='2025-07-01',
                  interruption_on='2026-08-01',last_insurable_earnings_on='2026-07-31' where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
            });
            const component = await withOrgContext(fx.orgId, async () => {
              const rows = await db.execute<{ id: string }>(
                sql`select id from pay_components where org_id=${fx.orgId} and system_key='base_pay'`,
                "objects",
              );
              assert.equal(rows.length, 1);
              return rows[0]!.id;
            });
            // Retained monthly calendar, employee hours and dated earning evidence are coherent.
            async function retainedPeriod(
              start: string,
              end: string,
              owner: string,
              runType: "regular" | "supplemental",
            ) {
              await withBypassContext(() =>
                db.transaction(async (tx) => {
                  const documentId = randomUUID(),
                    stubId = randomUUID();
                  await tx.execute(sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status)
                    values(${documentId},${fx.orgId},'pay_run',${"ROE-" + documentId},${owner},${end},'CAD','draft')`);
                  await tx.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type)
                    values(${documentId},${fx.orgId},${fx.scheduleId},${start},${end},${end},${Number(end.slice(0, 4))},'committed',${runType})`);
                  await tx.execute(sql`insert into pay_stubs(id,org_id,pay_run_document_id,employee_party_id,employment_id,filing_account_id,
                    country,country_source,province,periods_per_year,pay_date,tax_year,currency_code,gross,insurable_earnings)
                    values(${stubId},${fx.orgId},${documentId},${fx.employeeId},${fx.employmentId},${accountId},
                      'CA','calculation','ON',12,${end},${Number(end.slice(0, 4))},'CAD',1,1)`);
                  await tx.execute(sql`insert into pay_stub_lines(org_id,stub_id,component_id,kind,description,amount,hours,earned_from,earned_to)
                    values(${fx.orgId},${stubId},${component},'earning','Retained monthly insured service',1,1,${start},${end})`);
                }),
              );
            }
            await retainedPeriod("2025-06-01", "2025-06-30", hidden, "regular");
            for (let index = 0; index < 13; index++) {
              const date = new Date(Date.UTC(2025, 6 + index, 1)),
                next = new Date(Date.UTC(2025, 7 + index, 0));
              await retainedPeriod(
                date.toISOString().slice(0, 10),
                next.toISOString().slice(0, 10),
                fx.subsidiaryId,
                "regular",
              );
            }
            const gate = {
              user: { orgId: fx.orgId, id: fx.actorId },
              permissions: new Set(["payroll.read"]),
              allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
            } as Authz;
            assert.equal(
              await withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(gate, "CA", "roe", [fx.employeeId], 2026),
              ),
              null,
              "an older source outside the declared employment window cannot move its ownership",
            );
            const before = await withOrgContext(fx.orgId, () => roeRecord(fx.orgId, fx.employeeId));
            assert.equal(before?.periods.length, 13);
            assert.equal(before?.totalInsurableHours, "13.0000");
            assert.equal(
              before?.totalInsurableEarnings,
              "7.0000",
              "monthly earnings use seven service periods, hours use thirteen",
            );
            await retainedPeriod("2026-07-01", "2026-07-31", hidden, "supplemental");
            await assert.rejects(
              withOrgContext(fx.orgId, () => roeRecord(fx.orgId, fx.employeeId)),
              /conflicting retained payroll employment or legal-employer/,
            );
            await assert.rejects(
              withOrgContext(fx.orgId, () =>
                guardPayrollFilingRowIds(gate, "CA", "roe", [fx.employeeId], 2026),
              ),
              /conflicting retained payroll employment or legal-employer/,
              "a same-period source must retain its actual employer",
            );
          } finally {
            await dropScratchOrgReporting(fx.orgId);
          }
        },
      );
    },
  },
] as const;

for (const row of payrollFilingScopeCases) await row.register();
