import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { buildAllRecognitionSchedules } from "./revenue-recognition.ts";
import { recognitionAccounts } from "./project-recognition.ts";

/**
 * Fixed-price project revenue through the ARM pipeline (source platform-shaped).
 *
 * Each qualifying project — project type recognition policy
 * `percent_complete_cost` with a contract value and a customer — carries ONE
 * revenue contract (revenue_contracts.project_id) with ONE percent_complete
 * performance obligation. This module keeps that subledger in sync with the
 * project's progress; it NEVER posts. Posting happens only in the central
 * recognition run (runRevenueRecognition), so project revenue gets the same
 * period discipline, idempotency, and audit trail as every other obligation.
 *
 * Percent complete is DATA, not an action: the manual override
 * (projects.custom.percentCompleteOverride, 0–100) wins; otherwise cost-to-cost
 * (posted project cost ÷ task budget). A change is a change in estimate — the
 * schedule rebuild plans the cumulative catch-up (either direction)
 * prospectively into the as-of period (ASC 250 / ASC 606 over-time).
 *
 * Account treatment (percentage-of-completion, contract-asset school): the
 * obligation's "deferred" side is the Unbilled receivable control account and
 * the recognized side is Project revenue, so the central run posts
 * DR Unbilled receivable / CR Project revenue, and the project invoice relieves
 * Unbilled receivable (generateInvoiceFromBillingRequest) — revenue is earned
 * over time, billed later, never double-counted. Inert until both control
 * accounts are mapped in Company & Accounting.
 */

export const PROJECT_POC_RULE_CODE = "PROJECT-POC";

export interface ProjectContractStatus {
  projectId: string;
  projectCode: string;
  contractId: string;
  obligationId: string;
  contractValue: string;
  /** 0..100 cumulative target used for the schedule. */
  percentComplete: number;
  /** True when the % came from the manual override, not cost-to-cost. */
  overridden: boolean;
  created: boolean;
}

export interface ProjectRevenueSyncResult {
  synced: ProjectContractStatus[];
  problems: string[];
}

/** Cost-to-cost completion fraction (0..1): actual ÷ budget, clamped. */
export function costToCostFraction(budget: number, actual: number): number {
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  if (!Number.isFinite(actual) || actual <= 0) return 0;
  return Math.min(1, actual / budget);
}

/**
 * Ensure the org's built-in percent-complete rule for project contracts. The
 * rule stays fully editable under Setup → Recognition Rules (accounts left to
 * the obligation, which carries the org control accounts).
 */
async function ensureProjectPocRule(orgId: string, actorId: string | null): Promise<string> {
  const existing = (await db.execute(sql`
    select id from recognition_rules where org_id = ${orgId} and code = ${PROJECT_POC_RULE_CODE} limit 1`)) as unknown as {
    rows: { id: string }[];
  };
  if (existing.rows[0]) return existing.rows[0].id;
  const ins = (await db.execute(sql`
    insert into recognition_rules (org_id, code, name, method, is_active, created_by, updated_by)
    values (${orgId}, ${PROJECT_POC_RULE_CODE}, 'Project percent complete', 'percent_complete', true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update set updated_at = now()
    returning id`)) as unknown as { rows: { id: string }[] };
  return ins.rows[0].id;
}

/**
 * Sync the revenue contract + obligation for every qualifying fixed-price
 * project (or one, when `projectId` is given): ensure the contract/obligation
 * exist, refresh the percent-complete target, backfill any pre-pipeline
 * recognition entries into the schedule (so history is never re-recognized),
 * and rebuild the schedule for the central run to post.
 */
export async function syncProjectRevenueContracts(
  orgId: string,
  actorId: string | null,
  asOfDate: string,
  projectId?: string,
): Promise<ProjectRevenueSyncResult> {
  const result: ProjectRevenueSyncResult = { synced: [], problems: [] };

  const accts = await recognitionAccounts(orgId);
  if (!accts.unbilledReceivable || !accts.projectRevenue) {
    // Inert until mapped — same contract as the rest of project GL recognition.
    return result;
  }

  const projects = (await db.execute(sql`
    select p.id, p.code, p.name, p.customer_id, p.subsidiary_id, p.starts_on,
           coalesce(nullif(p.custom->>'contractValue', '')::numeric, 0)::numeric(19,4) as contract_value,
           nullif(p.custom->>'percentCompleteOverride', '')::numeric as pct_override
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active
       and coalesce(pt.invoicing_profile->>'recognition',
                    case when p.billing_method = 'fixed_price' then 'percent_complete_cost' end) = 'percent_complete_cost'
       ${projectId ? sql`and p.id = ${projectId}` : sql``}
     order by p.code`)) as unknown as {
    rows: {
      id: string; code: string; name: string; customer_id: string | null; subsidiary_id: string | null;
      starts_on: string | null; contract_value: string; pct_override: string | null;
    }[];
  };

  const org = (await db.execute(sql`select base_currency from orgs where id = ${orgId}`)) as unknown as {
    rows: { base_currency: string }[];
  };
  const currency = org.rows[0]?.base_currency ?? "CAD";

  let ruleId: string | null = null;

  for (const p of projects.rows) {
    if (Number(p.contract_value) === 0) continue; // nothing to recognize (yet)
    if (!p.customer_id) {
      result.problems.push(`${p.code}: project has no customer — cannot carry a revenue contract`);
      continue;
    }
    ruleId ??= await ensureProjectPocRule(orgId, actorId);

    // -- percent complete: override (0..100) wins, else cost-to-cost ---------
    let percent: number;
    let overridden = false;
    if (p.pct_override != null && Number.isFinite(Number(p.pct_override))) {
      percent = Math.max(0, Math.min(100, Number(p.pct_override)));
      overridden = true;
    } else {
      const cc = (await db.execute(sql`
        select
          coalesce((select sum(t.estimated_cost) from project_tasks t
                     where t.project_id = ${p.id} and t.org_id = ${orgId}), 0) as budget,
          coalesce((select sum(l.amount) from journal_lines l
                     join journal_entries e on e.id = l.entry_id
                     join accounts a on a.id = l.account_id
                    where l.org_id = ${orgId} and l.project_id = ${p.id} and e.status = 'posted'
                      and a.type in ('expense','cogs','expense_other','expense_deferred')), 0) as actual`)) as unknown as {
        rows: { budget: string; actual: string }[];
      };
      percent = costToCostFraction(Number(cc.rows[0]?.budget ?? 0), Number(cc.rows[0]?.actual ?? 0)) * 100;
    }

    // -- ensure the contract --------------------------------------------------
    const startsOn = p.starts_on ?? asOfDate;
    let created = false;
    const existing = (await db.execute(sql`
      select id from revenue_contracts where org_id = ${orgId} and project_id = ${p.id} limit 1`)) as unknown as {
      rows: { id: string }[];
    };
    let contractId: string;
    if (existing.rows[0]) {
      contractId = existing.rows[0].id;
      await db.execute(sql`
        update revenue_contracts
           set total_transaction_price = ${p.contract_value}, customer_id = ${p.customer_id},
               starts_on = coalesce(starts_on, ${startsOn}), updated_at = now(), updated_by = ${actorId}
         where id = ${contractId}`);
    } else {
      const ins = (await db.execute(sql`
        insert into revenue_contracts
          (org_id, customer_id, project_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
        values (${orgId}, ${p.customer_id}, ${p.id}, ${p.code}, 'active', ${startsOn}, ${currency}, ${p.contract_value}, ${actorId}, ${actorId})
        returning id`)) as unknown as { rows: { id: string }[] };
      contractId = ins.rows[0].id;
      created = true;
    }

    // -- ensure the (single) obligation --------------------------------------
    const existingObl = (await db.execute(sql`
      select id from performance_obligations where org_id = ${orgId} and contract_id = ${contractId} limit 1`)) as unknown as {
      rows: { id: string }[];
    };
    let obligationId: string;
    if (existingObl.rows[0]) {
      obligationId = existingObl.rows[0].id;
      await db.execute(sql`
        update performance_obligations
           set booked_amount = ${p.contract_value}, standalone_selling_price = ${p.contract_value},
               allocated_price = ${p.contract_value}, percent_complete = ${percent.toFixed(4)},
               deferred_account_id = ${accts.unbilledReceivable}, recognized_account_id = ${accts.projectRevenue},
               updated_at = now(), updated_by = ${actorId}
         where id = ${obligationId}`);
    } else {
      const ins = (await db.execute(sql`
        insert into performance_obligations
          (org_id, contract_id, item_id, description, recognition_rule_id,
           booked_amount, standalone_selling_price, allocated_price, percent_complete,
           recognition_starts_on, deferred_account_id, recognized_account_id, status, created_by, updated_by)
        values (${orgId}, ${contractId}, null, ${p.name}, ${ruleId},
                ${p.contract_value}, ${p.contract_value}, ${p.contract_value}, ${percent.toFixed(4)},
                ${startsOn}, ${accts.unbilledReceivable}, ${accts.projectRevenue}, 'open', ${actorId}, ${actorId})
        returning id`)) as unknown as { rows: { id: string }[] };
      obligationId = ins.rows[0].id;

      // Backfill pre-pipeline recognition (the retired per-project button) as
      // POSTED schedule lines pointing at the real journal entries, so the
      // percent-complete rebuild credits history instead of re-recognizing it.
      await backfillHistoricalRecognition(orgId, actorId, p.id, obligationId, accts.projectRevenue);
    }

    await buildAllRecognitionSchedules(obligationId, orgId, actorId, asOfDate);

    result.synced.push({
      projectId: p.id,
      projectCode: p.code,
      contractId,
      obligationId,
      contractValue: p.contract_value,
      percentComplete: Number(percent.toFixed(4)),
      overridden,
      created,
    });
  }

  return result;
}

/**
 * Record already-posted `revenue_recognition` entries for a project (credits to
 * the project revenue account, posted before the contract existed) as posted
 * schedule lines on the obligation's primary-book schedule. The lines point at
 * the real journal entries — the subledger ties to the GL, and rebuilds treat
 * the amounts as recognized-to-date.
 */
async function backfillHistoricalRecognition(
  orgId: string,
  actorId: string | null,
  projectId: string,
  obligationId: string,
  projectRevenueAccountId: string,
): Promise<void> {
  const hist = (await db.execute(sql`
    select e.id, e.period_id, coalesce(-sum(l.amount), 0)::numeric(19,4) as recognized
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
     where e.org_id = ${orgId} and e.status = 'posted' and e.origin = 'revenue_recognition'
       and l.project_id = ${projectId} and l.account_id = ${projectRevenueAccountId}
       and not exists (select 1 from recognition_schedule_lines rl
                        where rl.org_id = ${orgId} and rl.journal_entry_id = e.id)
     group by e.id, e.period_id
    having coalesce(-sum(l.amount), 0) <> 0
     order by min(e.posting_date)`)) as unknown as {
    rows: { id: string; period_id: string; recognized: string }[];
  };
  if (hist.rows.length === 0) return;

  const book = (await db.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`)) as unknown as {
    rows: { id: string }[];
  };
  const bookId = book.rows[0]?.id;
  if (!bookId) return;

  await db.transaction(async (tx) => {
    const sched = (await tx.execute(sql`
      insert into recognition_schedules (org_id, obligation_id, book_id, total_amount, created_by, updated_by)
      select ${orgId}, ${obligationId}, ${bookId}, allocated_price, ${actorId}, ${actorId}
        from performance_obligations where id = ${obligationId}
      on conflict (obligation_id, book_id) do update set updated_at = now()
      returning id`)) as unknown as { rows: { id: string }[] };
    const scheduleId = sched.rows[0].id;
    let seq = 0;
    for (const h of hist.rows) {
      await tx.execute(sql`
        insert into recognition_schedule_lines
          (org_id, schedule_id, period_id, sequence, planned_amount, recognized_amount, journal_entry_id, created_by, updated_by)
        values (${orgId}, ${scheduleId}, ${h.period_id}, ${seq}, ${h.recognized}, ${h.recognized}, ${h.id}, ${actorId}, ${actorId})`);
      seq++;
    }
  });
}
