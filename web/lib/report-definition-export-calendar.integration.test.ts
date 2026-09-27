import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import ExcelJS from "exceljs";
import { stubModules } from '../testing/stub-modules.ts'

const root = new URL("./", import.meta.url);
const authState: { user: import("./auth").SessionUser | null } = { user: null };
Object.assign(globalThis, { __definitionExportCalendarState: authState });

stubModules({ navigation: false, intl: 'export async function getTranslations(){const t=(s)=>s;t.has=()=>false;t.rich=(s)=>s;return t} export async function getLocale(){return "en"}', authz: false, features: false });

registerHooks({
  resolve(specifier, context, nextResolve) {
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
const { builtInReportDefinitionId, executeReport, loadReportDefinition } = await import("./custom-reports.ts");
const { salesOrderLineRemainders } = await import("@openbooks/engine/src/records/order-line-remainders.ts");
const { toQuantityUnits } = await import("./order-cycle-math.ts");
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

test("the backorders built-in states the engine open quantity line by line", async () => {
  const fx = await fixture();
  try {
    const orderId = crypto.randomUUID();
    const [partial, shipped, service] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}', settings->'features'
               || '{"orders":true,"warehousing":true,"fulfillment":true}'::jsonb)
         where id = ${fx.org.orgId}`);
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, status, currency, subtotal, tax_total, total, subsidiary_id, party_id)
        values (${orderId}, ${fx.org.orgId}, 'sales_order', 'SO-BACK', ${fx.org.date}, 'draft', 'CAD', '0', '0', '0', ${fx.org.subsidiaryId}, ${fx.org.customerId})`);
      // Open 5 after 3 shipped and 2 cancelled; a fully shipped stock line and
      // a service line are not backorders.
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, item_id, quantity, quantity_fulfilled, quantity_cancelled, unit_price, amount, stock_location_id)
        values (${partial}, ${fx.org.orgId}, ${orderId}, 1, ${fx.org.items.fifo}, '10', '3', '2', '1', '10', ${fx.org.stockLocationId}),
               (${shipped}, ${fx.org.orgId}, ${orderId}, 2, ${fx.org.items.fifo}, '5', '5', '0', '1', '5', ${fx.org.stockLocationId}),
               (${service}, ${fx.org.orgId}, ${orderId}, 3, ${fx.org.items.service}, '4', '0', '0', '1', '4', null)`);
      await db.execute(sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${fx.org.orgId}`);
    });
    const definitionId = await withBypassContext(() => builtInReportDefinitionId(fx.org.orgId, "backorders"));
    assert.ok(definitionId, "the backorders definition is available for this organization");
    const report = await run(fx.org.orgId, fx.authz, async () => {
      const definition = await loadReportDefinition(fx.org.orgId, definitionId);
      assert.ok(definition?.query);
      const columns = [...definition.query.columns!, "line_id"];
      const result = await executeReport(fx.org.orgId, { ...definition.query, columns }, undefined, {});
      const [open, line] = [columns.indexOf("open_quantity"), columns.indexOf("line_id")];
      return result.groups.flatMap((group) => group.rows.map((row) => [String(row[line]), toQuantityUnits(String(row[open]))]));
    });
    const engine = await run(fx.org.orgId, fx.authz, () =>
      salesOrderLineRemainders(db, fx.org.orgId, { documentId: orderId, openOnly: true }));
    assert.deepEqual(report, engine.map((row) => [row.lineId, toQuantityUnits(row.open)]));
    assert.deepEqual(report, [[partial, toQuantityUnits("5")]]);
  } finally {
    await release(fx);
  }
});
