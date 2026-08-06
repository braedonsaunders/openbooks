import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { seedPayrollComponents } from "../payroll-run.ts";
import { setPackSlotAccount } from "../payroll/packs.ts";

/**
 * One-off dev provisioning: give the Hearthstone review tenant the WCB/EHT
 * employer-tax setup so pay runs show real accruals — WSIB rate class on all
 * active employees, Ontario EHT at 1.95% (exemption allocated to an
 * associated employer, so $0 here), and distinct payable accounts.
 *
 *   npx tsx engine/src/validation/hearthstone-employer-taxes.ts
 */

const ORG = "9c484d30-6e69-489d-af9b-59e44aa59f82";

async function actor(): Promise<string> {
  const r = (await db.execute(sql`
    select id from users where org_id = ${ORG} and is_active order by created_at limit 1
  `)) as unknown as { rows: { id: string }[] };
  if (!r.rows[0]) throw new Error("no member user found for Hearthstone");
  return r.rows[0].id;
}

async function ensureAccount(number: string, name: string): Promise<string> {
  const existing = (await db.execute(sql`
    select id from accounts where org_id = ${ORG} and number = ${number}
  `)) as unknown as { rows: { id: string }[] };
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${ORG}, ${number}, ${name}, 'liability_current_other', false, true, false,
            false, '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

const actorId = await actor();

// New statutory components (idempotent — on conflict do nothing).
await seedPayrollComponents(ORG, actorId, "CA");

const wsibPayable = await ensureAccount("2265", "WSIB Payable");
const ehtPayable = await ensureAccount("2266", "EHT Payable");
await setPackSlotAccount(ORG, actorId, "CA", "wcb", wsibPayable);
await setPackSlotAccount(ORG, actorId, "CA", "eht", ehtPayable);

// WSIB rate class for a property-management operation; 2026-style insurable max.
const groupRow = (await db.execute(sql`
  select id from worker_comp_groups where org_id = ${ORG} and code = 'WSIB-PM'
`)) as unknown as { rows: { id: string }[] };
let groupId = groupRow.rows[0]?.id;
if (!groupId) {
  groupId = randomUUID();
  await db.execute(sql`
    insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
    values (${groupId}, ${ORG}, 'WSIB-PM', 'Property management & building maintenance', '1.85', '117130', true)`);
} else {
  await db.execute(sql`
    update worker_comp_groups set rate_percent = '1.85', max_assessable = '117130', is_active = true
     where id = ${groupId}`);
}
await db.execute(sql`
  update employee_roles set worker_comp_group_id = ${groupId}
   where org_id = ${ORG} and is_active`);

// Ontario EHT on: exemption assigned to an associated employer → $0 here, so
// the accrual is visible from the first run.
await db.execute(sql`
  update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll,ca}',
    ${JSON.stringify({ eht: { enabled: true, rate: "1.95", annualExemption: "0" } })}::jsonb)
   where id = ${ORG}`);

const check = (await db.execute(sql`
  select (select count(*) from employee_roles where org_id = ${ORG} and worker_comp_group_id = ${groupId}) as linked,
         (select count(*) from pay_components where org_id = ${ORG} and code in ('WCB','EHT')) as components
`)) as unknown as { rows: { linked: string; components: string }[] };
console.log("hearthstone employer taxes:", check.rows[0]);
process.exit(0);
