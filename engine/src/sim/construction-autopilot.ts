import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { addDays, dayOfMonth } from "./manifest.ts";
import { logCrewDay, postLaborForProject, billTimeAndMaterials } from "./ops-tm.ts";
import { runProgressBilling, billFixedPrice, releaseProjectRetainage } from "./ops-construction.ts";
import type { SimOrg } from "./world.ts";

/**
 * The deterministic "PM autopilot" for a construction company — the mechanical
 * stand-in for what the Project Manager persona does each month across a job
 * portfolio of every billing method:
 *   • T&M / NTE jobs: log crew field tickets, cost the labor, bill the time (NTE
 *     stops at its contract cap);
 *   • schedule_of_values jobs: monthly AIA progress draw with retainage, released
 *     near the end;
 *   • fixed_price jobs: monthly milestone invoice up to the contract.
 * Runs once mid-month. Skips auto-engagement projects (those are billed by the
 * services month-end path), so it only drives PM-created construction jobs.
 */

interface Job {
  id: string;
  key: string;
  contract: string;
  sov_total: string;
  billed: string;
}

export async function autopilotConstruction(world: SimOrg, today: string): Promise<{ actions: number }> {
  // Only a company with a field crew runs jobs; and only mid-month.
  if (world.employees.length === 0 || dayOfMonth(today) !== 15) return { actions: 0 };

  const engagementIds = new Set(world.engagements.map((e) => e.id));
  const rows = (await db.execute(sql`
    select p.id, coalesce(pt.key, 'time_and_materials') as key, coalesce(p.contract_value, 0)::text as contract,
           coalesce((select sum(s.scheduled_value) from sov_lines s where s.project_id = p.id), 0)::text as sov_total,
           coalesce((select sum(d.total) from documents d
                      where d.org_id = p.org_id and d.kind = 'customer_invoice' and d.status = 'posted'
                        and (d.custom->'sim'->>'projectId' = p.id::text
                             or exists (select 1 from document_lines dl where dl.document_id = d.id and dl.project_id = p.id))), 0)::text as billed
      from projects p left join project_types pt on pt.id = p.project_type_id
     where p.org_id = ${world.orgId} and p.status = 'active'`)) as unknown as { rows: Job[] };

  let actions = 0;
  for (const j of rows.rows.filter((r) => !engagementIds.has(r.id))) {
    const contract = Number(j.contract);
    const billed = Number(j.billed);
    try {
      if (j.key === "time_and_materials" || j.key === "not_to_exceed") {
        // NTE: stop billing new work once near the ceiling.
        if (j.key === "not_to_exceed" && contract > 0 && billed >= contract * 0.95) continue;
        await logCrewDay(world, { projectId: j.id, workedOn: addDays(today, -9), hours: "8" });
        await logCrewDay(world, { projectId: j.id, workedOn: addDays(today, -2), hours: "8" });
        await postLaborForProject(world, j.id);
        const r = await billTimeAndMaterials(world, j.id, today);
        if (r) actions++;
      } else if (j.key === "schedule_of_values") {
        const sov = Number(j.sov_total);
        if (sov > 0 && billed < sov * 0.9) {
          await runProgressBilling(world, j.id, today, "0.1", world.actors.arClerk, world.actors.controller);
          actions++;
        } else if (sov > 0 && billed >= sov * 0.9) {
          // Substantially complete → release withheld retainage (once).
          const ret = (await db.execute(sql`
            select coalesce(sum(l.amount), 0)::text as bal from journal_lines l
              join journal_entries e on e.id = l.entry_id and e.status = 'posted'
             where l.org_id = ${world.orgId} and l.account_id = ${world.accounts.retainageReceivable}`)) as unknown as { rows: { bal: string }[] };
          const retBal = Number(ret.rows[0]?.bal ?? "0");
          if (retBal > 1) {
            await releaseProjectRetainage(world, j.id, today, retBal.toFixed(2), world.actors.controller);
            actions++;
          }
        }
      } else if (j.key === "fixed_price") {
        if (contract > 0 && billed < contract * 0.98) {
          const amt = Math.min(contract / 8, contract - billed);
          if (amt > 0.005) {
            await billFixedPrice(world, j.id, amt.toFixed(2), today, "Monthly progress milestone");
            actions++;
          }
        }
      }
    } catch {
      // Expected business-rule rejections (NTE ceiling, over-contract, nothing to
      // bill) must not abort the other jobs' billing. The day-end invariant oracle
      // still gates correctness, so a real defect (unbalanced books) halts the run.
    }
  }
  return { actions };
}
