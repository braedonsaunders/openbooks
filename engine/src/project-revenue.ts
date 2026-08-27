import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp, formatMoney, mulRatio, normalizeMoney, toUnits } from "./money.ts";
import { canonicalDecimal } from "./exact-decimal.ts";
import { buildAllRecognitionSchedulesInTransaction, revenueRecognitionFeatureEnabled } from "./revenue-recognition.ts";
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
  percentComplete: string;
  /** True when the % came from the manual override, not cost-to-cost. */
  overridden: boolean;
  created: boolean;
}

export interface ProjectRevenueSyncResult {
  synced: ProjectContractStatus[];
  problems: string[];
}

/** Cost-to-cost completion fraction (0..1), exact and clamped. */
export function costToCostFraction(budget: string, actual: string): string {
  const percent = costToCostPercent(budget, actual);
  return mulRatio("1", toUnits(percent), toUnits("100"));
}

/** Exact cumulative completion percentage at ledger precision. */
export function costToCostPercent(budget: string, actual: string): string {
  const exactBudget = normalizeMoney(budget);
  const exactActual = normalizeMoney(actual);
  if (cmp(exactBudget, "0") <= 0 || cmp(exactActual, "0") <= 0) return "0.0000";
  if (cmp(exactActual, exactBudget) >= 0) return "100.0000";
  return mulRatio("100", toUnits(exactActual), toUnits(exactBudget));
}

/**
 * Ensure the org's built-in percent-complete rule for project contracts. The
 * rule stays fully editable under Setup → Recognition Rules (accounts left to
 * the obligation, which carries the org control accounts).
 */
async function ensureProjectPocRule(orgId: string, actorId: string | null, runner: Pick<typeof db, "execute"> = db): Promise<string> {
  const existing = (await runner.execute<{ id: string }>(sql`
    select id from recognition_rules where org_id = ${orgId} and code = ${PROJECT_POC_RULE_CODE} limit 1`));
  if (existing.rows[0]) return existing.rows[0].id;
  const ins = (await runner.execute<{ id: string }>(sql`
    insert into recognition_rules (org_id, code, name, method, is_active, created_by, updated_by)
    values (${orgId}, ${PROJECT_POC_RULE_CODE}, 'Project percent complete', 'percent_complete', true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update set updated_at = now()
    where recognition_rules.org_id = ${orgId}
    returning id`));
  return ins.rows[0]!.id;
}

/**
 * Sync the revenue contract + obligation for every qualifying fixed-price
 * project (or one, when `projectId` is given): ensure the contract/obligation
 * exist, refresh the percent-complete target, and rebuild the schedule for the
 * central run to post. Historical ledger adoption is deliberately not part of
 * this runtime path: imported opening positions must enter through an explicit,
 * reviewed migration before project contracts are activated.
 */
export async function syncProjectRevenueContracts(
  orgId: string,
  actorId: string | null,
  asOfDate: string,
  projectId?: string,
): Promise<ProjectRevenueSyncResult> {
  return db.transaction(async (tx) =>
    syncProjectRevenueContractsInTransaction(tx, orgId, actorId, asOfDate, projectId),
  );
}

/**
 * Transaction-bearing core of syncProjectRevenueContracts. The WHOLE sync for a
 * project — the contract, its single obligation, and the multi-book schedule
 * rebuild — runs inside one transaction (`tx`), so a percent-complete override
 * cannot leave a mixed state (new displayed override/contract price with an old
 * obligation or partial book schedules). Every book's schedule agrees on one
 * source percent/contract value or the entire sync rolls back.
 */
export async function syncProjectRevenueContractsInTransaction(
  tx: Pick<typeof db, "execute" | "transaction">,
  orgId: string,
  actorId: string | null,
  asOfDate: string,
  projectId?: string,
): Promise<ProjectRevenueSyncResult> {
  const result: ProjectRevenueSyncResult = { synced: [], problems: [] };
  if (!(await revenueRecognitionFeatureEnabled(tx, orgId))) return result;

  const accts = await recognitionAccounts(orgId, tx);
  if (!accts.unbilledReceivable || !accts.projectRevenue) {
    // Inert until mapped — same contract as the rest of project GL recognition.
    return result;
  }

  const projects = (await tx.execute<{
      id: string; code: string; name: string; customer_id: string | null; subsidiary_id: string | null;
      starts_on: string | null; contract_value: string; pct_override: string | null; functional_currency: string | null;
    }>(sql`
    select p.id, p.code, p.name, p.customer_id, p.subsidiary_id, p.starts_on,
           coalesce(p.contract_value, 0)::numeric(19,4) as contract_value,
           nullif(p.custom->>'percentCompleteOverride', '')::numeric as pct_override,
           coalesce(s.base_currency, root.base_currency) as functional_currency
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
      left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id
      left join lateral (
        select base_currency from subsidiaries
         where org_id = p.org_id and parent_id is null and is_active and not is_elimination
         limit 1
      ) root on true
     where p.org_id = ${orgId} and p.is_active
       and pt.invoicing_profile->>'recognition' = 'percent_complete_cost'
       ${projectId ? sql`and p.id = ${projectId}` : sql``}
     order by p.code`));

  let ruleId: string | null = null;

  for (const p of projects.rows) {
    if (cmp(p.contract_value, "0") === 0) continue; // nothing to recognize (yet)
    if (!p.customer_id) {
      result.problems.push(`${p.code}: project has no customer — cannot carry a revenue contract`);
      continue;
    }
    if (!p.functional_currency) {
      result.problems.push(`${p.code}: project has no authoritative functional currency`);
      continue;
    }
    ruleId ??= await ensureProjectPocRule(orgId, actorId, tx);

    // -- percent complete: override (0..100) wins, else cost-to-cost ---------
    let percent: string;
    let overridden = false;
    if (p.pct_override != null) {
      const exact = canonicalDecimal(p.pct_override, 4);
      if (exact === null) {
        result.problems.push(`${p.code}: percent-complete override must be an exact decimal`);
        continue;
      }
      let override: string;
      try {
        override = normalizeMoney(exact);
      } catch {
        result.problems.push(`${p.code}: percent-complete override must be an exact decimal`);
        continue;
      }
      percent = cmp(override, "0") < 0 ? "0.0000" : cmp(override, "100") > 0 ? "100.0000" : override;
      overridden = true;
    } else {
      const cc = (await tx.execute<{ budget: string; actual: string }>(sql`
        select
          coalesce((select sum(t.estimated_cost) from project_tasks t
                     where t.project_id = ${p.id} and t.org_id = ${orgId}), 0) as budget,
          coalesce((select sum(l.amount) from journal_lines l
                    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
                    join accounts a on a.id = l.account_id and a.org_id = l.org_id
                   where l.org_id = ${orgId} and l.project_id = ${p.id} and e.status in ('posted', 'reversed')
                     and a.type in ('expense','cogs','expense_other','expense_deferred')), 0) as actual`));
      percent = costToCostPercent(cc.rows[0]?.budget ?? "0", cc.rows[0]?.actual ?? "0");
    }

    // -- ensure the contract --------------------------------------------------
    const startsOn = p.starts_on ?? asOfDate;
    let created = false;
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from revenue_contracts where org_id = ${orgId} and project_id = ${p.id} limit 1`));
    let contractId: string;
    if (existing.rows[0]) {
      contractId = existing.rows[0].id;
      await tx.execute(sql`
        update revenue_contracts
           set total_transaction_price = ${p.contract_value}, customer_id = ${p.customer_id},
               starts_on = coalesce(starts_on, ${startsOn}), updated_at = now(), updated_by = ${actorId}
         where id = ${contractId} and org_id = ${orgId}`);
    } else {
      const ins = (await tx.execute<{ id: string }>(sql`
        insert into revenue_contracts
          (org_id, customer_id, project_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
        values (${orgId}, ${p.customer_id}, ${p.id}, ${p.code}, 'active', ${startsOn}, ${p.functional_currency}, ${p.contract_value}, ${actorId}, ${actorId})
        returning id`));
      contractId = ins.rows[0]!.id;
      created = true;
    }

    // -- ensure the (single) obligation --------------------------------------
    const existingObl = (await tx.execute<{ id: string }>(sql`
      select id from performance_obligations where org_id = ${orgId} and contract_id = ${contractId} limit 1`));
    let obligationId: string;
    if (existingObl.rows[0]) {
      obligationId = existingObl.rows[0].id;
      await tx.execute(sql`
        update performance_obligations
           set booked_amount = ${p.contract_value}, standalone_selling_price = ${p.contract_value},
               allocated_price = ${p.contract_value}, percent_complete = ${percent},
               deferred_account_id = ${accts.unbilledReceivable}, recognized_account_id = ${accts.projectRevenue},
               updated_at = now(), updated_by = ${actorId}
         where id = ${obligationId} and org_id = ${orgId}`);
    } else {
      const ins = (await tx.execute<{ id: string }>(sql`
        insert into performance_obligations
          (org_id, contract_id, item_id, description, recognition_rule_id,
           booked_amount, standalone_selling_price, allocated_price, percent_complete,
           recognition_starts_on, deferred_account_id, recognized_account_id, status, created_by, updated_by)
        values (${orgId}, ${contractId}, null, ${p.name}, ${ruleId},
                ${p.contract_value}, ${p.contract_value}, ${p.contract_value}, ${percent},
                ${startsOn}, ${accts.unbilledReceivable}, ${accts.projectRevenue}, 'open', ${actorId}, ${actorId})
        returning id`));
      obligationId = ins.rows[0]!.id;
    }

    await buildAllRecognitionSchedulesInTransaction(tx, obligationId, orgId, actorId, asOfDate);

    result.synced.push({
      projectId: p.id,
      projectCode: p.code,
      contractId,
      obligationId,
      contractValue: p.contract_value,
      percentComplete: formatMoney(percent, 4),
      overridden,
      created,
    });
  }

  return result;
}
