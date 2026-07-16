/**
 * Seed the default `cost_pool` account-group dimension used by the True Cost
 * report. Idempotent — re-running updates the rules in place. Groups carry
 * auto-classification rules; users can re-pin accounts or edit rules in
 * Admin → Setup → Account Groups.
 */
import { db } from "./db.ts";
import { sql } from "drizzle-orm";

const COST_POOLS = [
  { key: "direct_cost", name: "Direct Cost", color: "#0d9488", sort: 10, match: { accountTypes: ["cogs"] }, catchAll: false },
  { key: "direct_labor", name: "Direct Labor", color: "#0ea5e9", sort: 20, match: { namePattern: "\\b(wage|wages|labour|labor|payroll|salary|salaries|hourly|foreman|crew|journeyman|apprentice)\\b" }, catchAll: false },
  { key: "overhead", name: "Overhead", color: "#8b5cf6", sort: 30, match: { namePattern: "overhead|indirect|rent|lease|utilit|hydro|electric|gas|telephone|internet|deprec|amort|repair|maintenance|supplies|shop|vehicle|fuel|equipment|tools|freight|training|safety|uniform|licens|permit|dues|subscription|software|bank charge|interest" }, catchAll: false },
  { key: "g_and_a", name: "G&A", color: "#f59e0b", sort: 40, match: { namePattern: "admin|administrat|executive|office|professional fee|accounting|legal|management|rrsp|benefit|insurance|human resource" }, catchAll: false },
  { key: "other", name: "Other", color: "#94a3b8", sort: 90, match: {}, catchAll: true },
];

/**
 * Burden categories for the True Cost rate engine (Gantry's category manager
 * maps onto account groups). Classifies OVERHEAD-type expense accounts into
 * rate-composition categories; deliberately NO catch-all — accounts with
 * spend that match no category surface as "Unassigned" on the dashboard,
 * exactly like Gantry's classifier.
 */
const BURDEN_CATEGORIES = [
  { key: "facilities", name: "Facilities", color: "#f59e0b", sort: 10, match: { namePattern: "rent|property tax|building|premises|heat|hydro|utilit|electric power|water|waste|janitor|snow" }, catchAll: false },
  { key: "admin_wages", name: "Admin & Salaries", color: "#3b82f6", sort: 20, match: { namePattern: "office wages|management salar|executive salar|bonus|profit sharing|rrsp|ipp |severance|stat(utory)? holiday.*admin|short term disability|admin.*(wage|salar)" }, catchAll: false },
  { key: "insurance", name: "Insurance", color: "#ef4444", sort: 30, match: { namePattern: "insurance" }, catchAll: false },
  { key: "it_software", name: "IT & Communications", color: "#8b5cf6", sort: 40, match: { namePattern: "software|computer|communications|telephone|internet|website|it services" }, catchAll: false },
  { key: "fleet_equipment", name: "Fleet & Equipment", color: "#10b981", sort: 50, match: { namePattern: "vehicle|truck|fleet|fuel|equipment|deprec|amort|tenant improvement|r&m|repairs" }, catchAll: false },
  { key: "professional", name: "Professional Fees", color: "#06b6d4", sort: 60, match: { namePattern: "accounting|legal|consult|professional fee|audit" }, catchAll: false },
  { key: "people_safety", name: "People & Safety", color: "#ec4899", sort: 70, match: { namePattern: "ppe|safety|training|weld testing|recruit|membership|dues|permit|codes|meals|entertainment|promotional|travel|uniform" }, catchAll: false },
  { key: "financial", name: "Financial", color: "#64748b", sort: 80, match: { namePattern: "bank fee|interest|bad debt|exchange|penalt|provision for income tax" }, catchAll: false },
];

async function main() {
  const org: any = await db.execute(sql`select id from orgs order by created_at limit 1`);
  const orgId = org.rows[0]?.id;
  if (!orgId) throw new Error("no org found");
  for (const [dimension, groups] of [["cost_pool", COST_POOLS], ["burden", BURDEN_CATEGORIES]] as const) {
    for (const p of groups) {
      await db.execute(sql`
        insert into account_groups (org_id, dimension, key, name, color, sort_order, match, is_catch_all)
        values (${orgId}, ${dimension}, ${p.key}, ${p.name}, ${p.color}, ${p.sort}, ${JSON.stringify(p.match)}::jsonb, ${p.catchAll})
        on conflict (org_id, dimension, key) do update
          set name = excluded.name, color = excluded.color, sort_order = excluded.sort_order,
              match = excluded.match, is_catch_all = excluded.is_catch_all, is_active = true, updated_at = now()
      `);
    }
    const c: any = await db.execute(sql`select count(*)::int n from account_groups where dimension=${dimension}`);
    console.log(`${dimension} groups:`, c.rows[0].n);
  }
  process.exit(0);
}
main();
