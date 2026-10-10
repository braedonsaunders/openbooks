import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sampleCompanyFeatures } from "./features.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

type RowDigest = { id: string; digest: string };
export type SamplePreservationSnapshot = Map<string, { primaryKey: string; rows: RowDigest[] }>;
const PROTECTED_TABLES = [
  "documents", "document_lines", "journal_entries", "journal_lines", "applications",
  "flows", "flow_runs", "flow_run_effects", "flow_gates", "flow_locks", "approval_delegations",
  "accounts", "subsidiaries", "accounting_books", "fiscal_calendars", "accounting_periods", "period_locks",
  "parties", "customer_roles", "vendor_roles", "employee_roles", "role_assignments", "user_org_access",
  "pay_components", "entitlement_plans", "entitlement_plan_limits", "payroll_compensation_packages",
  "hrm_training_courses", "hrm_shift_templates", "hrm_attendance_devices", "work_schedules",
  "bank_statements", "bank_statement_lines", "reconciliations", "reconciliation_matches",
  "quote_subscription_terms", "quote_ramp_steps", "document_supply_evidence",
  "subscription_plans", "subscriptions", "usage_meters", "usage_rating_plans", "usage_rating_plan_versions",
  "subscription_usage_links", "webhook_endpoints", "rma_lines", "field_ticket_labor_snapshots", "field_ticket_labor_lines",
] as const;

function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new SampleCompanyError("Invalid preservation table identity.");
  return sql.raw(`"${value}"`);
}

/** Existing rows are locked and compared in full; only new rows may be added. */
export async function snapshotSampleRecords(orgId: string, authoredTables: Map<string, string>): Promise<SamplePreservationSnapshot> {
  const tables = new Map(PROTECTED_TABLES.map(table => [table as string, "id"]));
  tables.set("rma_documents", "document_id");
  tables.set("rma_lines", "line_id");
  for (const [table, key] of authoredTables) tables.set(table, key);
  const columns = (await db.execute<{ tableName: string; columnName: string }>(sql`
    select table_name as "tableName",column_name as "columnName" from information_schema.columns
    where table_schema='public' and table_name in (${sql.join([...tables.keys()].map(table => sql`${table}`), sql`, `)})
  `)).rows;
  const snapshot: SamplePreservationSnapshot = new Map();
  for (const [table, primaryKey] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
    const available = columns.filter(column => column.tableName === table).map(column => column.columnName);
    // Optional features may not have a table on an older released schema. The
    // scenario installer separately refuses any missing required feature table.
    if (!available.length) continue;
    if (!available.includes("org_id") || !available.includes(primaryKey)) {
      throw new SampleCompanyError(`Cannot preserve ${table}: its tenant or native primary key is unavailable. Use a compatible released schema before refreshing.`);
    }
    const rows = (await db.execute<RowDigest>(sql`
      select r.${identifier(primaryKey)}::text as id,md5(to_jsonb(r)::text) as digest
      from ${identifier(table)} r where r.org_id=${orgId} order by r.${identifier(primaryKey)} for share
    `)).rows;
    snapshot.set(table, { primaryKey, rows });
  }
  return snapshot;
}

export async function assertSampleRecordsPreserved(orgId: string, before: SamplePreservationSnapshot): Promise<{ records: number; digest: string }> {
  let records = 0;
  for (const [table, snapshot] of before) {
    const rows = (await db.execute<RowDigest>(sql`
      select r.${identifier(snapshot.primaryKey)}::text as id,md5(to_jsonb(r)::text) as digest
      from ${identifier(table)} r where r.org_id=${orgId} order by r.${identifier(snapshot.primaryKey)}
    `)).rows;
    const after = new Map(rows.map(row => [row.id, row.digest]));
    const changed = snapshot.rows.find(row => after.get(row.id) !== row.digest);
    if (changed) throw new SampleCompanyError(`Sample refresh would change existing ${table} record ${changed.id}. The entire company upgrade was rolled back. Preserve that record and use a new versioned scenario identity or resolve the incompatible source state through its native workflow.`);
    records += snapshot.rows.length;
  }
  return { records, digest: createHash("sha256").update(JSON.stringify([...before])).digest("hex") };
}

/** Existing settings survive; only required feature gates and package metadata advance. */
export function assertSampleSettingsPreserved(before: Record<string, unknown>, after: Record<string, unknown>, industryKey: string): void {
  const required = sampleCompanyFeatures(industryKey);
  const compare = (prior: unknown, next: unknown, path: string[]): void => {
    if (path[0] === "demoData") return;
    if (path.length === 2 && path[0] === "features" && required[path[1]!] && next === true) return;
    if (Array.isArray(prior)) {
      if (Array.isArray(next) && prior.every((item, index) => isDeepStrictEqual(item, next[index]))) return;
    } else if (prior !== null && typeof prior === "object") {
      if (next !== null && typeof next === "object" && !Array.isArray(next)) {
        for (const [key, value] of Object.entries(prior)) compare(value, (next as Record<string, unknown>)[key], [...path, key]);
        return;
      }
    } else if (isDeepStrictEqual(prior, next)) return;
    throw new SampleCompanyError(`Sample refresh would replace existing company configuration at ${path.join(".")}. The company upgrade was rolled back; preserve that configuration or review its native setup before retrying.`);
  };
  compare(before, after, []);
}
