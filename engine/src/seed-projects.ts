import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, schema } from "./db.ts";

/**
 * Seed the `projects` dimension from the NetSuite `job` extraction
 * (account-data/projects.json). Projects are the center of this business
 * (job costing / project profitability); NetSuite models them as `job`
 * entity records and costs transactions to them at the LINE level via
 * `transactionline.entity`.
 *
 * Keeps the NetSuite job id in `custom.nsId` so the transaction replay can
 * wire `document_lines.projectId` / `journal_lines.projectId` from each line's
 * entity — the same nsId bridge used for accounts / departments / parties.
 *
 * Idempotent: only inserts jobs whose nsId isn't already a project.
 */

const extraction = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extraction");
const readJson = (p: string) => JSON.parse(readFileSync(join(extraction, p), "utf8"));

// NetSuite entitystatus (project stage) id -> openbooks projects.status enum.
const STATUS_MAP: Record<string, (typeof schema.projects.status.enumValues)[number]> = {
  "1": "closed", // Closed
  "2": "active", // In Progress
  "3": "cancelled", // Not Awarded
  "18": "substantially_complete", // Job Completed
  "19": "closed", // Final Billed
  "21": "substantially_complete", // Work Completed
  "22": "active", // Start Billing
  "23": "awarded", // Waiting for PO
};

// NetSuite jobbillingtype -> openbooks billing_method enum.
const BILLING_MAP: Record<string, (typeof schema.projects.billingMethod.enumValues)[number]> = {
  TM: "time_and_materials",
  FBI: "fixed_price", // Fixed Bid, Interval
  FBM: "fixed_price", // Fixed Bid, Milestone
};

const mdY = (s?: string | null): string | null => {
  if (!s) return null;
  const [m, d, y] = String(s).split("/");
  if (!m || !d || !y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};

export async function seedProjects() {
  const [org] = (await db.execute(sql`select id from orgs limit 1`)).rows as { id: string }[];
  if (!org) throw new Error("no org — run seed-netsuite first");

  // nsId -> local id bridges (parties for customer/foreman/manager, departments).
  const partyByNs = new Map<string, string>();
  for (const r of (await db.execute(sql`
    select id, custom->>'nsId' ns from parties where custom->>'nsId' is not null`)).rows as any[])
    partyByNs.set(r.ns, r.id);
  const deptByNs = new Map<string, string>();
  for (const r of (await db.execute(sql`
    select id, custom->>'nsId' ns from departments where custom->>'nsId' is not null`)).rows as any[])
    deptByNs.set(r.ns, r.id);

  // already-seeded projects (idempotency).
  const existing = new Set<string>();
  for (const r of (await db.execute(sql`
    select custom->>'nsId' ns from projects where custom->>'nsId' is not null`)).rows as any[])
    if (r.ns) existing.add(r.ns);

  const jobs = readJson("account-data/projects.json") as any[];
  const idByNs = new Map<string, string>();
  let inserted = 0;
  let unmappedCustomer = 0;
  const missingStatus = new Set<string>();

  for (const j of jobs) {
    const ns = String(j.id);
    if (existing.has(ns)) continue;

    const status = STATUS_MAP[String(j.entitystatus)];
    if (!status) missingStatus.add(String(j.entitystatus));
    const customerId = j.customer ? partyByNs.get(String(j.customer)) ?? null : null;
    if (j.customer && !customerId) unmappedCustomer++;

    const [row] = await db
      .insert(schema.projects)
      .values({
        orgId: org.id,
        code: j.entityid ?? null,
        name: String(j.companyname ?? j.entityid ?? `Project ${ns}`).slice(0, 500),
        isActive: j.isinactive !== "T",
        customerId,
        foremanId: j.foreman ? partyByNs.get(String(j.foreman)) ?? null : null,
        managerId: j.projectmanager ? partyByNs.get(String(j.projectmanager)) ?? null : null,
        status: status ?? "active",
        billingMethod: BILLING_MAP[String(j.jobbillingtype)] ?? null,
        customerPoNumber: j.po_number ? String(j.po_number) : null,
        startsOn: mdY(j.startdate),
        endsOn: mdY(j.scheduledenddate),
        // All semantic values are native columns (status, billingMethod,
        // customerId, foremanId, managerId, parentId, code). `custom` carries
        // only the source key for idempotent migration — same as every other
        // imported entity.
        custom: { nsId: ns },
      })
      .returning({ id: schema.projects.id });
    idByNs.set(ns, row.id);
    inserted++;
  }

  // Second pass: parent hierarchy, only where the NS parent is itself a job we
  // seeded (jobs' `parent` is usually the customer, not another job).
  const allByNs = new Map<string, string>(idByNs);
  for (const r of (await db.execute(sql`
    select id, custom->>'nsId' ns from projects where custom->>'nsId' is not null`)).rows as any[])
    allByNs.set(r.ns, r.id);
  let parented = 0;
  for (const j of jobs) {
    const childId = allByNs.get(String(j.id));
    const parentId = j.parent ? allByNs.get(String(j.parent)) : undefined;
    if (!childId || !parentId || childId === parentId) continue;
    await db.execute(sql`update projects set parent_id = ${parentId} where id = ${childId}`);
    parented++;
  }

  console.log(`projects seeded: inserted=${inserted} (of ${jobs.length}), already=${existing.size}`);
  console.log(`  parented=${parented}  unmappedCustomer=${unmappedCustomer}`);
  if (missingStatus.size) console.log(`  unmapped entitystatus codes: ${[...missingStatus].join(", ")}`);
}

seedProjects()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
