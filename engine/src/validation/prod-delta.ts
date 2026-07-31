/**
 * What has been corrected in the validation sandbox but NOT in production.
 *
 * Every remediation harness refuses to run outside a sandbox, which is the right
 * default — but it means a fix proven there has changed nothing for the tenant
 * actually using the product. This reports the gap per correction so the decision
 * to carry each one across is made on numbers rather than memory.
 *
 * Read-only. It never writes.
 *
 * Usage: npx tsx --conditions=react-server src/validation/prod-delta.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";

const PROD = process.env.PROD_ORG ?? (process.env.PROD_ORG ?? (() => { throw new Error("PROD_ORG is required"); })());
const SBX = process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })();

async function retry<T>(fn: () => Promise<T>, n = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

const both = async (label: string, build: (org: string) => any, note = "") => {
  const p = ((await retry(() => db.execute(build(PROD)))) as any).rows[0]?.n ?? 0;
  const s = ((await retry(() => db.execute(build(SBX)))) as any).rows[0]?.n ?? 0;
  const flag = Number(p) === 0 && Number(s) > 0 ? "NOT IN PROD" : Number(p) < Number(s) ? "behind" : "ok";
  console.log(`  ${label.padEnd(38)} prod ${String(p).padStart(9)}   sandbox ${String(s).padStart(9)}   ${flag}${note ? "  " + note : ""}`);
};

(async () => {
  console.log("Corrections proven in the sandbox, measured against production\n");

  console.log("JOB-LINE DATA (backfilled from the source system)");
  await both("billable cost lines", (o) => sql`
    select count(*)::int n from document_lines where org_id = ${o} and is_billable and project_id is not null`);
  await both("cost lines linked to a field ticket", (o) => sql`
    select count(*)::int n from document_lines where org_id = ${o} and field_ticket_id is not null`);
  await both("lines carrying a markup percent", (o) => sql`
    select count(*)::int n from document_lines where org_id = ${o} and markup_percent is not null`);
  await both("lines carrying their source line id", (o) => sql`
    select count(*)::int n from document_lines where org_id = ${o} and custom->>'sourceLineRef' is not null`);
  await both("field tickets", (o) => sql`
    select count(*)::int n from documents where org_id = ${o} and kind = 'field_ticket'`);

  console.log("\nRATE CARDS");
  await both("projects linked to their own rate card", (o) => sql`
    select count(distinct project_id)::int n from item_rate_book_assignments
     where org_id = ${o} and project_id is not null`);
  await both("percent adjustments stored as a FRACTION", (o) => sql`
    select count(*)::int n from labor_rate_adjustments
     where org_id = ${o} and calculation = 'percent' and value > 0 and value < 1`, "(should be 0 — 15% is 15, not 0.15)");
  await both("surcharges targeted at billable time", (o) => sql`
    select count(*)::int n from labor_rate_adjustment_targets where org_id = ${o} and target_type = 'labor'`);

  console.log("\nPROJECT TYPES AND INVOICING CONFIG");
  await both("types with sales_order as a cost source", (o) => sql`
    select count(*)::int n from project_types
     where org_id = ${o} and invoicing_profile->'costSourceKinds' ? 'sales_order'`);
  await both("types with a ticket cost scope set", (o) => sql`
    select count(*)::int n from project_types where org_id = ${o} and invoicing_profile ? 'ticketCostScope'`);
  await both("types with per-item line grouping", (o) => sql`
    select count(*)::int n from project_types
     where org_id = ${o} and invoicing_profile->>'lineGrouping' = 'per_item'`);
  await both("types with a rate-card lapse policy", (o) => sql`
    select count(*)::int n from project_types where org_id = ${o} and invoicing_profile ? 'rateCardLapse'`);

  console.log("\nSCHEMA (a column missing in prod means the migration has not been applied)");
  for (const [table, column] of [["document_lines", "markup_percent"], ["parties", "invoicing_profile"], ["projects", "invoicing_profile"], ["labor_rate_adjustments", "item_id"]]) {
    const r = ((await retry(() => db.execute(sql`
      select count(*)::int n from information_schema.columns
       where table_name = ${table} and column_name = ${column}`))) as any).rows[0];
    console.log(`  ${`${table}.${column}`.padEnd(38)} ${Number(r.n) ? "present" : "MISSING"}`);
  }
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 250));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
