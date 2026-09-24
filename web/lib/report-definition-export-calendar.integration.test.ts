import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import ExcelJS from "exceljs";

const root = new URL("./", import.meta.url);
const authState: { user: import("./auth").SessionUser | null } = { user: null };
Object.assign(globalThis, { __definitionExportCalendarState: authState });

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent('export async function getTranslations(){const t=(s)=>s;t.has=()=>false;t.rich=(s)=>s;return t} export async function getLocale(){return "en"}')}`,
      };
    }
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.includes("/web/") &&
      !context.parentURL.includes("/web/lib/auth.ts")
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export * from '${new URL("auth.ts", root).href}'; export async function currentUser() { return globalThis.__definitionExportCalendarState.user }`,
      };
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/reports/definitions/")) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export async function guardPermission() { return { user: globalThis.__definitionExportCalendarState.user, permissions: new Set(['reports.read']), allowedSubsidiaryIds: null } }`,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { db, withBypassContext, withOrgTransaction } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { withSimClock } = await import("@openbooks/engine/src/platform/clock.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { builtInReportDefinitionId } = await import("./custom-reports.ts");
const { withReportAuthz } = await import("./report-execution-context.ts");
const { GET } = await import("../app/api/reports/definitions/[id]/export/route.ts");

const BUSINESS_INSTANT = "2026-03-01T01:00:00.000Z";
const BUSINESS_DAY = "2026-02-28";

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const userId = await withBypassContext(async () => {
      const id = await createScratchUser(org.orgId, "Recall exporter", "recall_exporter");
      await db.execute(sql`
        update app_roles set permissions = '["reports.read"]'::jsonb
         where org_id = ${org.orgId} and key = 'recall_exporter'
      `);
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
             coalesce(settings->'features', '{}'::jsonb) || '{"inventory":true}'::jsonb, true)
         where id = ${org.orgId}
      `);
      await db.execute(sql`
        update item_inventory_profiles set tracking = 'lot', updated_at = now()
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}
      `);
      await db.execute(sql`
        insert into lots (org_id, item_id, lot_number, expires_on)
        select ${org.orgId}, ${org.items.fifo}, 'LOT-' || lpad(g::text, 4, '0'), date '2027-01-01'
          from generate_series(1, 40) g
      `);
      await db.execute(sql`
        insert into inventory_movements
          (org_id, item_id, kind, moved_at, stock_location_id, lot_id, quantity, unit_cost, total_value, status)
        select ${org.orgId}::uuid, ${org.items.fifo}::uuid, 'receipt', timestamptz '2026-01-01',
               ${org.stockLocationId}::uuid, lot.id, 1, '10.0000', '10.0000', 'posted'
          from lots lot where lot.org_id = ${org.orgId}::uuid
      `);
      return id;
    });

    authState.user = {
      id: userId,
      orgId: org.orgId,
      isSuperAdmin: false,
      name: "Recall exporter",
      email: "recall@example.test",
      roles: [],
      envKind: "production",
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: userId,
    };
    const authz = {
      user: authState.user,
      permissions: new Set(["reports.read"]),
      allowedSubsidiaryIds: null,
    } as import("./authz").Authz;
    const definitionId = await withBypassContext(() =>
      builtInReportDefinitionId(org.orgId, "lot-recall"),
    );
    assert.ok(definitionId, "the lot-recall definition is available for this organization");
    return { org, authz, definitionId };
  } catch (error) {
    authState.user = null;
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

async function release(fx: Awaited<ReturnType<typeof fixture>>) {
  authState.user = null;
  await dropScratchOrg(fx.org.orgId);
}

function run<T>(orgId: string, authz: import("./authz").Authz, action: () => Promise<T>) {
  return withOrgTransaction(orgId, () => withReportAuthz(authz, action));
}

function exportRequest(id: string, query: string) {
  return GET(
    new Request(`http://reports.test/api/reports/definitions/${id}/export?${query}`),
    { params: Promise.resolve({ id }) },
  );
}

test("saved-definition export applies its built-in URL filter to real rows", async () => {
  const fx = await fixture();
  try {
    const response = await run(fx.org.orgId, fx.authz, () =>
      exportRequest(fx.definitionId, "format=csv&lotNumber=LOT-0001"),
    );
    assert.equal(response.status, 200);
    const csv = await response.text();
    const matchingRows = csv.split(/\r?\n/).filter((line) => line.includes("LOT-0001"));
    assert.equal(matchingRows.length, 1, "the selected lot has one posted movement");
    assert.doesNotMatch(csv, /LOT-0002/, "neighboring lots are excluded by the URL filter");
  } finally {
    await release(fx);
  }
});

test("saved-definition PDF and XLSX artifacts use the organization business day", async () => {
  const fx = await fixture();
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{timeZone}',
        to_jsonb('America/Los_Angeles'::text), true)
       where id = ${fx.org.orgId}
    `));

    const pdf = await withSimClock(BUSINESS_INSTANT, () =>
      run(fx.org.orgId, fx.authz, () => exportRequest(fx.definitionId, "format=pdf")),
    );
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-disposition") ?? "", new RegExp(BUSINESS_DAY));
    assert.match(pdf.headers.get("content-type") ?? "", /application\/pdf/);

    const xlsx = await withSimClock(BUSINESS_INSTANT, () =>
      run(fx.org.orgId, fx.authz, () => exportRequest(fx.definitionId, "format=xlsx")),
    );
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get("content-disposition") ?? "", new RegExp(BUSINESS_DAY));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await xlsx.arrayBuffer()) as unknown as ArrayBuffer);
    const expected = new Date(`${BUSINESS_DAY}T00:00:00.000Z`);
    assert.equal(workbook.created?.toISOString(), expected.toISOString());
    assert.equal(workbook.modified?.toISOString(), expected.toISOString());
  } finally {
    await release(fx);
  }
});
