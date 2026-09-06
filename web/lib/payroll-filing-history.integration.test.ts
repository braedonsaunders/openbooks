import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { commitPayRun } from "@openbooks/engine/src/payroll-run.ts";
import { dropScratchOrgReporting } from "@openbooks/engine/src/test-fixtures.ts";
import {
  seedAdoption,
  calculatedRun,
  markLegacy,
} from "@openbooks/engine/src/payroll-filing-test-fixtures.ts";
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
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/")) {
      return nextResolve(
        new URL(`.${specifier.slice(1)}.ts`, webRoot).href,
        context,
      );
    }
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
const get = () =>
  GET(
    new Request(
      "http://openbooks.test/api/payroll/remittances?from=2026-07-01&to=2026-07-31",
    ),
  );

for (const change of [
  "hidden-original",
  "inactive-original",
  "unknown",
] as const) {
  test(
    `remittance route handles ${change} historical attribution`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const fx = await seedAdoption();
      try {
        const hidden = randomUUID(),
          first = randomUUID(),
          second = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,name,base_currency,country,parent_id,is_elimination,is_active,custom)
    values(${hidden},${fx.orgId},'Restricted employer','CAD','CA',${fx.subsidiaryId},false,true,'{}'::jsonb)`);
        await db.execute(
          sql`update parties set subsidiary_id=${fx.subsidiaryId} where id=${fx.employeeId} and org_id=${fx.orgId}`,
        );
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,subsidiary_id,is_default)
    values(${first},${fx.orgId},'CA','ca_rp','123456789RP0001','Original employer',${change === "hidden-original" ? hidden : fx.subsidiaryId},true),
    (${second},${fx.orgId},'CA','ca_rp','123456789RP0002','Future employer',${fx.subsidiaryId},false)`);
        if (change === "inactive-original")
          await db.execute(
            sql`update employee_payroll_profiles set filing_account_id=${first} where org_id=${fx.orgId}`,
          );
        const { input } = await calculatedRun(fx);
        await commitPayRun(input);
        routeState.authz = {
          user: { orgId: fx.orgId, id: fx.actorId },
          permissions: new Set(["payroll.read"]),
          allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        };
        if (change === "hidden-original") {
          await db.execute(
            sql`update employee_payroll_profiles set filing_account_id=${second} where org_id=${fx.orgId}`,
          );
          const response = await get();
          assert.equal(response.status, 404);
          assert.deepEqual(await response.json(), { error: "not found" });
        } else if (change === "inactive-original") {
          await db.execute(
            sql`update payroll_filing_accounts set is_active=false where id=${first} and org_id=${fx.orgId}`,
          );
          const response = await get();
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.ok(body.groups.length > 0);
          assert.equal(body.groups[0].filingAccount.id, first);
        } else {
          await markLegacy(fx.orgId);
          const response = await get();
          assert.equal(response.status, 422);
          assert.match(
            (await response.json()).error,
            /unknown historical filing account/,
          );
        }
      } finally {
        routeState.authz = null;
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}
