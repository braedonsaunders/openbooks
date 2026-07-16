/**
 * TIME-RECORD IMPORTER — NetSuite `timebill` → openbooks `time_entries`.
 *
 * timebill is the atom of job costing here (100,984 rows): one employee-day
 * line per timesheet. Each carries the employee, the job (`customer`, always a
 * job when set), the service item (MECH:Foreman…), hours, bill rate, labor
 * cost, billable flag, and a time-TYPE custom record (Regular / Over Time /
 * Double Time + Admin variants) via custcol_bit_cost_multiplier — NOT the
 * native `timetype` field (which is always "Actual Time" here).
 *
 * Also seeds `time_types` from customrecord_bit_time_type (7 types, with the
 * real Labor Cost Multiplier) so each time entry maps to a real pay type.
 *
 * Idempotent: a timebill whose time_entry (custom.nsId) exists is skipped.
 * Resilient to the WG tunnel flaps (per-batch retry). Resumable.
 *
 * Run:  node_modules/.bin/tsx engine/src/import-time.mts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, schema } from "./db.ts";

const extraction = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extraction");
const readJson = (p: string) => JSON.parse(readFileSync(join(extraction, p), "utf8"));

const parseDate = (mmddyyyy?: string | null): string | null => {
  if (!mmddyyyy) return null;
  const [m, d, y] = String(mmddyyyy).split("/");
  if (!m || !d || !y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};

// Retry transient DB errors (the WG path to the DB VIP flaps).
async function rexec(fn: () => Promise<any>, tries = 12): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const transient = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|terminat|Connection|connection|timeout|socket/i.test(msg);
      if (!transient || i >= tries) throw e;
      console.error(`[rexec] transient DB error (retry ${i + 1}/${tries}): ${msg.slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1500 * (i + 1))));
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Org + mapping bridges
// ---------------------------------------------------------------------------
console.log("loading mappings…");
const [org] = (await rexec(() => db.execute(sql`select id from orgs limit 1`))).rows as any[];

const mapByNs = async (table: string): Promise<Map<string, string>> => {
  const m = new Map<string, string>();
  for (const r of (await rexec(() => db.execute(sql`
    select id, custom->>'nsId' ns from ${sql.raw(table)} where custom->>'nsId' is not null`))).rows as any[])
    m.set(r.ns, r.id);
  return m;
};
const partyByNs = await mapByNs("parties");
const projectByNs = await mapByNs("projects");
const itemByNs = await mapByNs("items");
const deptByNs = await mapByNs("departments");

// ---------------------------------------------------------------------------
// 2. Seed time_types from the NetSuite custom record (nsId-tagged).
// ---------------------------------------------------------------------------
await rexec(() => db.execute(sql`alter table time_types add column if not exists custom jsonb not null default '{}'::jsonb`));
// time_entries.custom holds the timebill nsId bridge (schema declares it; the
// live DB predates it).
await rexec(() => db.execute(sql`alter table time_entries add column if not exists custom jsonb not null default '{}'::jsonb`));
const timeTypesRaw = readJson("account-data/time-types.json") as any[];
const timeTypeByNs = new Map<string, { id: string; mult: string }>();
for (const t of timeTypesRaw) {
  const ns = String(t.id);
  const mult = String(t.multiplier ?? "1");
  const existing = (await rexec(() => db.execute(sql`
    select id from time_types where custom->>'nsId' = ${ns}`))).rows as any[];
  let id: string;
  if (existing[0]) {
    id = existing[0].id;
    await rexec(() => db.execute(sql`
      update time_types set name = ${t.name}, cost_multiplier = ${mult},
        is_active = ${t.isinactive !== "T"} where id = ${id}`));
  } else {
    const [row] = (await rexec(() => db.execute(sql`
      insert into time_types (org_id, name, cost_multiplier, is_active, custom)
      values (${org.id}, ${t.name}, ${mult}, ${t.isinactive !== "T"},
              ${JSON.stringify({ nsId: ns })}::jsonb)
      returning id`))).rows as any[];
    id = row.id;
  }
  timeTypeByNs.set(ns, { id, mult });
}
// Retire the placeholder time_types (no nsId) now the real ones exist — none
// are referenced (time_entries + document_lines.time_type_id are empty).
await rexec(() => db.execute(sql`delete from time_types where (custom->>'nsId') is null`));
console.log(`  parties:${partyByNs.size} projects:${projectByNs.size} items:${itemByNs.size} depts:${deptByNs.size} timeTypes:${timeTypeByNs.size}`);

// ---------------------------------------------------------------------------
// 3. Idempotency: already-imported timebill nsIds.
// ---------------------------------------------------------------------------
const existing = new Set<string>();
for (const r of (await rexec(() => db.execute(sql`
  select custom->>'nsId' ns from time_entries where custom->>'nsId' is not null`))).rows as any[])
  if (r.ns) existing.add(r.ns);
console.log(`  already imported: ${existing.size} time entries`);

// ---------------------------------------------------------------------------
// 4. Stream timebill.ndjson, map, batch-insert.
// ---------------------------------------------------------------------------
type TB = {
  id: string; employee?: string; customer?: string; department?: string; item?: string;
  hours?: string; rate?: string; laborcost?: string; laborcostcurrency?: string;
  isbillable?: string; timetype?: string; status?: string; billed?: string; posted?: string;
  trandate?: string; timesheet?: string; costmult?: string; tsnum?: string; itemcat?: string;
};

const rows = readFileSync(join(extraction, "account-data", "timebill.ndjson"), "utf8").split("\n").filter(Boolean);
console.log(`timebill rows: ${rows.length}`);

const BATCH = 1000;
let inserted = 0, skippedExisting = 0, skippedNoEmployee = 0, processed = 0;
let batch: (typeof schema.timeEntries.$inferInsert)[] = [];
const unmappedEmp = new Set<string>();

async function flush() {
  if (!batch.length) return;
  const b = batch;
  batch = [];
  await rexec(() => db.insert(schema.timeEntries).values(b));
  inserted += b.length;
}

for (const line of rows) {
  processed++;
  const tb = JSON.parse(line) as TB;
  const ns = String(tb.id);
  if (existing.has(ns)) { skippedExisting++; continue; }

  const empId = tb.employee ? partyByNs.get(tb.employee) : undefined;
  if (!empId) { skippedNoEmployee++; if (tb.employee) unmappedEmp.add(tb.employee); continue; }

  const tt = tb.costmult ? timeTypeByNs.get(tb.costmult) : undefined;

  batch.push({
    orgId: org.id,
    employeePartyId: empId,
    workedOn: parseDate(tb.trandate) ?? "1970-01-01",
    hours: tb.hours ?? "0",
    timeTypeId: tt?.id ?? null,
    itemId: tb.item ? itemByNs.get(tb.item) ?? null : null,
    projectId: tb.customer ? projectByNs.get(tb.customer) ?? null : null,
    departmentId: tb.department ? deptByNs.get(tb.department) ?? null : null,
    isBillable: tb.isbillable === "T",
    costRate: tb.laborcost ?? null,
    billRate: tb.rate ?? null,
    status: "approved", // posted historical time
    // Everything semantic is a native column (employee/project/item/department/
    // time_type→multiplier/is_billable/rates). `custom` carries only the source
    // key used to make the migration idempotent — same convention as accounts /
    // parties / items / projects.
    custom: { nsId: ns },
  });

  if (batch.length >= BATCH) {
    await flush();
    if (inserted % 10000 === 0) console.log(`  inserted ${inserted} (processed ${processed}/${rows.length})`);
  }
}
await flush();

console.log("\n============ TIME IMPORT SUMMARY ============");
console.log(`processed:              ${processed}`);
console.log(`time_entries inserted:  ${inserted}`);
console.log(`skipped (existing):     ${skippedExisting}`);
console.log(`skipped (no employee):  ${skippedNoEmployee}`);
if (unmappedEmp.size) console.log(`unmapped employee nsIds: ${[...unmappedEmp].slice(0, 20).join(", ")}${unmappedEmp.size > 20 ? " …" : ""}`);

await pool.end();
process.exit(0);
