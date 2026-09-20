import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ExcelJS from "exceljs";
import { resolveAppModule } from "./test-module-hooks";

const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: import("./auth").SessionUser | null } = { user: null };
Object.assign(globalThis, { __pagedExportStreamState: state });
registerHooks({
  resolve(s, c, next) {
    if (s === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (s === "next-intl/server") {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          'export async function getTranslations(){const t=(s)=>s;t.has=()=>false;t.rich=(s)=>s;return t;};export async function getLocale(){return "en"}',
        ),
      };
    }
    if ((s === "./auth" || s.endsWith("/lib/auth")) && c.parentURL?.includes("/web/") && !c.parentURL.includes("/web/lib/auth.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          `export * from ${JSON.stringify(root + "web/lib/auth.ts")};export async function currentUser(){return globalThis.__pagedExportStreamState.user;}`,
        ),
      };
    }
    if (s.endsWith("/lib/authz") && c.parentURL?.includes("/api/reports/definitions/")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          "export async function guardPermission(){return {user:globalThis.__pagedExportStreamState.user,permissions:new Set(['reports.read'])}}",
        ),
      };
    }
    const app = resolveAppModule(s, c, next, root);
    if (app) return app;
    return next(s, c);
  },
});

const { db, withBypassContext, withOrgContext, withOrgTransaction } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { withReportAuthz } = await import("./report-execution-context");
const { executeReportAllPages, streamPagedReportCsv, streamPagedReportXlsx } = await import("./custom-reports");
const { exportDataToCsv, exportDataToXlsx, runResultToExportData } = await import("./report-pdf");
const { readSheet } = await import("@openbooks/office");

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const GENERATED_AT = new Date("2026-03-01T00:00:00Z");
const COLUMNS = ["lot_number", "expires_on", "item_code", "item_name", "kind", "moved_at", "quantity", "memo"];
const plan = (groupBy: string | null = null, lotFilter: string | null = null) => ({
  entity: "inventory_lot_movements",
  mode: "rows" as const,
  columns: COLUMNS,
  filters: lotFilter
    ? { combinator: "and" as const, rules: [{ field: "lot_number", op: "contains" as const, value: lotFilter }] }
    : null,
  groupBy,
  sorts: [
    { column: "moved_at", direction: "desc" as const },
    { column: "movement_id", direction: "desc" as const },
  ],
});

async function fixture(rows: number) {
  // Fixture seeding runs under bypass (exactly what the pooled fixture path
  // does): the shared cluster enforces RLS and CI's superuser role hides it.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const uid = await withBypassContext(async () => {
      const id = await createScratchUser(org.orgId, "Recall exporter", "recall_exporter");
      await db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb where org_id=${org.orgId} and key='recall_exporter'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`
        update item_inventory_profiles set tracking = 'lot', updated_at = now()
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);
      await db.execute(sql`
        insert into lots (org_id, item_id, lot_number, expires_on)
        select ${org.orgId}, ${org.items.fifo}, 'LOT-' || lpad(g::text, 4, '0'), date '2027-01-01' + (g % 365)
        from generate_series(1, 40) g`);
      await db.execute(sql`
        insert into inventory_movements (org_id, item_id, kind, moved_at, stock_location_id, lot_id, quantity, unit_cost, total_value, status, memo)
        select ${org.orgId}::uuid, ${org.items.fifo}::uuid,
          case when g % 2 = 0 then 'receipt' else 'issue' end,
          timestamptz '2026-01-01' + (g || ' seconds')::interval,
          ${org.stockLocationId}::uuid, lot.id,
          case when g % 2 = 0 then 5 else -2 end,
          '10.5000', '52.5000', 'posted',
          case when g = 777 then '=cmd|evil' end
        from generate_series(1, ${rows}) g
        join (select id, row_number() over (order by lot_number) as rn from lots where org_id = ${org.orgId}::uuid) lot
          on lot.rn = (g % 40) + 1`);
      return id;
    });
    state.user = { id: uid, orgId: org.orgId, isSuperAdmin: false, name: "Recall exporter", email: "recall@example.test",
      roles: [], envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: uid };
    const authz = { user: state.user, permissions: new Set(["reports.read"]), allowedSubsidiaryIds: null } as import("./authz").Authz;
    return { org, authz };
  } catch (err) {
    state.user = null;
    await dropScratchOrg(org.orgId);
    throw err;
  }
}

async function release(fx: Awaited<ReturnType<typeof fixture>>) {
  state.user = null;
  await dropScratchOrg(fx.org.orgId);
}

async function oldOutputs(fx: Awaited<ReturnType<typeof fixture>>, groupBy: string | null = null, lotFilter: string | null = null) {
  return withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, async () => {
    const result = await executeReportAllPages(fx.org.orgId, plan(groupBy, lotFilter));
    const data = runResultToExportData(result, { title: "Recall", dateRangeLabel: "" });
    return {
      csv: exportDataToCsv(data, { sectionHeader: "Section" }),
      xlsx: await exportDataToXlsx(data, { reportName: "Recall", dateRangeLabel: "", generatedAt: GENERATED_AT }),
    };
  }));
}

// ExcelJS's streaming writer omits truly-empty cells where the document
// builder stores an empty string; Excel renders both as blank.
function sameCell(a: unknown, b: unknown): boolean {
  const blank = (v: unknown): boolean => v === null || v === undefined || v === "";
  return (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
}

async function assertWorkbooksMatch(actual: Buffer, expected: Buffer) {
  const load = async (buf: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb;
  };
  const [newWb, oldWb] = [await load(actual), await load(expected)];
  assert.deepEqual(newWb.worksheets.map((w) => w.name), oldWb.worksheets.map((w) => w.name));
  assert.equal(newWb.worksheets.length, oldWb.worksheets.length);
  for (let s = 0; s < oldWb.worksheets.length; s++) {
    const oldWs = oldWb.worksheets[s]!;
    const newWs = newWb.worksheets[s]!;
    assert.equal(newWs.rowCount, oldWs.rowCount, `sheet ${s} row count`);
    for (let r = 1; r <= oldWs.rowCount; r++) {
      for (let c = 1; c <= COLUMNS.length; c++) {
        assert.ok(
          sameCell(newWs.getCell(r, c).value, oldWs.getCell(r, c).value),
          `sheet ${s} r${r}c${c}: ${JSON.stringify(newWs.getCell(r, c).value)} !== ${JSON.stringify(oldWs.getCell(r, c).value)}`,
        );
      }
    }
    assert.deepEqual(newWs.getCell(1, 1).font, oldWs.getCell(1, 1).font);
    assert.deepEqual(newWs.getCell(4, 1).font, oldWs.getCell(4, 1).font);
    assert.deepEqual(newWs.getCell(4, 1).fill, oldWs.getCell(4, 1).fill);
    for (let c = 1; c <= COLUMNS.length; c++) {
      assert.equal(newWs.getColumn(c).width, oldWs.getColumn(c).width, `sheet ${s} col ${c} width`);
    }
  }
}

test("streamed CSV is byte-identical to the buffered export on a three-page recall", enabled, async () => {
  const fx = await fixture(1200);
  try {
    const old = await oldOutputs(fx);
    const streamed = await withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, () =>
      streamPagedReportCsv(fx.org.orgId, plan(), { title: "Recall", sectionHeader: "Section", generatedAt: GENERATED_AT })));
    assert.equal(streamed.csv, old.csv);
    assert.equal(streamed.rowCount, 1200);
    assert.equal(streamed.totalRows, 1200);
    assert.equal(streamed.truncated, false);
  } finally { await release(fx); }
});

test("streamed CSV matches on sections spanning page boundaries", enabled, async () => {
  const fx = await fixture(1200);
  try {
    const old = await oldOutputs(fx, "kind");
    const streamed = await withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, () =>
      streamPagedReportCsv(fx.org.orgId, plan("kind"), { title: "Recall", sectionHeader: "Section", generatedAt: GENERATED_AT })));
    assert.equal(streamed.csv, old.csv);
    assert.ok(streamed.csv.startsWith("Section,"));
    assert.equal(streamed.rowCount, 1200);
  } finally { await release(fx); }
});

test("streamed XLSX carries the same sheets and values as the buffered export", enabled, async () => {
  const fx = await fixture(1200);
  try {
    const old = await oldOutputs(fx);
    const streamed = await withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, () =>
      streamPagedReportXlsx(fx.org.orgId, plan(), { title: "Recall", dateRangeLabel: "", generatedAt: GENERATED_AT })));
    assert.equal(streamed.rowCount, 1200);
    assert.equal(streamed.truncated, false);
    await assertWorkbooksMatch(streamed.xlsx, old.xlsx);
    // The repo's own sheet reader sees the same content.
    const back = await readSheet(streamed.xlsx);
    assert.equal(back.headers[0], "Recall");
    assert.ok(back.rows.length >= 1200);
  } finally { await release(fx); }
});

test("streamed XLSX matches on sections spanning page boundaries", enabled, async () => {
  const fx = await fixture(1200);
  try {
    const old = await oldOutputs(fx, "kind");
    const streamed = await withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, () =>
      streamPagedReportXlsx(fx.org.orgId, plan("kind"), { title: "Recall", dateRangeLabel: "", generatedAt: GENERATED_AT })));
    await assertWorkbooksMatch(streamed.xlsx, old.xlsx);
  } finally { await release(fx); }
});

test("streamed CSV covers the empty recall exactly", enabled, async () => {
  const fx = await fixture(10);
  try {
    const old = await oldOutputs(fx, null, "NOPE-NO-LOT");
    const streamed = await withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, () =>
      streamPagedReportCsv(fx.org.orgId, plan(null, "NOPE-NO-LOT"), { title: "Recall", sectionHeader: "Section", generatedAt: GENERATED_AT })));
    assert.equal(streamed.csv, old.csv);
    assert.equal(streamed.rowCount, 0);
  } finally { await release(fx); }
});

test("the row cap truncates with a disclosed footer instead of materialising everything", enabled, async () => {
  const fx = await fixture(1200);
  try {
    const streamed = await withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, () =>
      streamPagedReportCsv(fx.org.orgId, plan(), { title: "Recall", sectionHeader: "Section", generatedAt: GENERATED_AT, rowCap: 700 })));
    assert.equal(streamed.rowCount, 700);
    assert.equal(streamed.totalRows, 1200);
    assert.equal(streamed.truncated, true);
    const lines = streamed.csv.split("\r\n").filter((line) => line !== "");
    assert.equal(lines.length, 1 + 700 + 3);
    const last = lines[lines.length - 1] ?? "";
    assert.ok(last.includes("run.exportTruncated"), last);
    const streamedX = await withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, () =>
      streamPagedReportXlsx(fx.org.orgId, plan(), { title: "Recall", dateRangeLabel: "", generatedAt: GENERATED_AT, rowCap: 700 })));
    assert.equal(streamedX.rowCount, 700);
    assert.equal(streamedX.truncated, true);
    const back = await readSheet(streamedX.xlsx);
    assert.ok(back.rows.some((row) => JSON.stringify(row).includes("run.exportTruncated")));
  } finally { await release(fx); }
});

test("the definitions export route streams paged CSV/XLSX and keeps PDF buffered", enabled, async () => {
  const fx = await fixture(1200);
  try {
    const { GET } = await import("../app/api/reports/definitions/[id]/export/route");
    const inserted = await withOrgContext(fx.org.orgId, () => db.execute<{ id: string }>(sql`
      insert into report_definitions (org_id, slug, name, query)
      values (${fx.org.orgId}, 'recall-stream', 'Recall', ${JSON.stringify(plan())}::jsonb)
      returning id`));
    const defId = inserted.rows[0]!.id;
    const params = { params: Promise.resolve({ id: defId }) };
    const run = <T>(action: () => Promise<T>): Promise<T> =>
      withOrgTransaction(fx.org.orgId, () => withReportAuthz(fx.authz, action));
    const csv = await run(() => GET(new Request(`http://test.local/api/reports/definitions/${defId}/export?format=csv`), params));
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(csv.headers.get("content-disposition") ?? "", /attachment/);
    const body = await csv.text();
    assert.equal(body.split("\r\n").filter((line) => line !== "").length, 1 + 1200 + 2);
    const xlsx = await run(() => GET(new Request(`http://test.local/api/reports/definitions/${defId}/export?format=xlsx`), params));
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get("content-type") ?? "", /spreadsheetml/);
    const back = await readSheet(Buffer.from(await xlsx.arrayBuffer()));
    assert.equal(back.headers[0], "Recall");
    assert.ok(back.rows.length >= 1200);
    const pdf = await run(() => GET(new Request(`http://test.local/api/reports/definitions/${defId}/export?format=pdf`), params));
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-type") ?? "", /application\/pdf/);
  } finally { await release(fx); }
});

test("the truncation notice names the shown and total rows", () => {
  const en = JSON.parse(readFileSync(new URL("../messages/en/reports.json", import.meta.url), "utf8")) as {
    run: { exportTruncated: string };
  };
  assert.match(en.run.exportTruncated, /\{shown\}/);
  assert.match(en.run.exportTruncated, /\{total\}/);
});
