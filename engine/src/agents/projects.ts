import { sql } from "drizzle-orm";
import { add, cmp } from "../money/money.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "./continuous-close-config.ts";
import { db } from "../platform/db.ts";
import { classifyForensicItem, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Project-margin pack: the SAME ranking row the project margin report ranks
 * (web/lib/project-ranking.ts `rankProjects` with default args — org-wide,
 * activity-filtered), plus the WIP billing service's own unbilled-work
 * predicates (web/lib/wip-billing.ts) aged past a cutoff. Findings link the
 * projects cockpit for review. A margin that flips sign reads the previously
 * persisted margin off the stable fingerprint, so the card can say so.
 * Proposes nothing executable: no prebill-creation tool exists, so — like the
 * collections and payables packs — the finding is the review card. Never
 * writes.
 */
export const PROJECTS_DETECTOR_KEYS = [
  "project_negative_margin",
  "project_budget_overrun",
  "project_stale_unbilled",
] as const;

const PROJECTS_HREF = "/projects";

/** Cost and revenue account-type sets, transcribed from project-ranking.ts. */
const COST_TYPES = ["expense", "cogs", "expense_other", "expense_deferred"];
const REVENUE_TYPES = ["income", "income_other"];

type ProjectFinancials = {
  id: string;
  code: string | null;
  name: string;
  status: string | null;
  customer: string | null;
  contractValue: string;
  costBudget: string;
  cost: string;
  revenue: string;
  margin: string;
  committed: string;
};

/**
 * The ranking query's read graph, org-wide (the engine runs without a
 * subsidiary context, like every sibling pack): primary-book posted and
 * reversed lines classified by account-type sets, the approved task budgets,
 * and the approved-PO unbilled commitments. No status, search, or paging
 * predicates — the report's defaults.
 */
async function rankProjectFinancials(orgId: string): Promise<ProjectFinancials[]> {
  const costSet = sql`(${sql.join(COST_TYPES.map((t) => sql`${t}`), sql`, `)})`;
  const revenueSet = sql`(${sql.join(REVENUE_TYPES.map((t) => sql`${t}`), sql`, `)})`;
  const res = await db.execute<Record<string, unknown>>(sql`
    with book as (
      select b.id from accounting_books b
       where b.org_id = ${orgId} and b.is_primary and b.is_active and b.posts_gl
       limit 1
    ),
    scoped as (
      select p.id, p.code, p.name, p.status, coalesce(p.contract_value, 0) as contract_value,
             c.display_name as customer
        from projects p
        left join parties c on c.id = p.customer_id and c.org_id = p.org_id
       where p.org_id = ${orgId}
    ),
    cost_accounts as (
      select id from accounts where org_id = ${orgId} and type in ${costSet}
    ),
    revenue_accounts as (
      select id from accounts where org_id = ${orgId} and type in ${revenueSet}
    ),
    actuals as (
      select l.project_id,
             coalesce(sum(l.amount) filter (where l.account_id in (select id from cost_accounts)), 0) as cost,
             coalesce(-sum(l.amount) filter (where l.account_id in (select id from revenue_accounts)), 0) as revenue
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = ${orgId}
         and l.project_id in (select id from scoped)
         and e.status in ('posted', 'reversed')
         and e.book_id = (select id from book)
       group by l.project_id
    ),
    budget as (
      select t.project_id, coalesce(sum(t.estimated_cost), 0) as cost_budget
        from project_tasks t
       where t.org_id = ${orgId} and t.project_id in (select id from scoped)
       group by t.project_id
    ),
    committed as (
      select coalesce(dl.project_id, d.project_id) as project_id,
             coalesce(sum(round((dl.quantity - dl.quantity_billed) * dl.unit_price * d.fx_rate, 4)), 0) as committed_cost
        from document_lines dl
        join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and d.status = 'approved' and d.kind = 'purchase_order'
         and dl.quantity > dl.quantity_billed
         and coalesce(dl.project_id, d.project_id) in (select id from scoped)
       group by 1
    )
    select s.id::text as id, s.code, s.name, s.status, s.customer,
           s.contract_value::text as contract_value,
           coalesce(b.cost_budget, 0)::text as cost_budget,
           coalesce(a.cost, 0)::text as cost,
           coalesce(a.revenue, 0)::text as revenue,
           (coalesce(a.revenue, 0) - coalesce(a.cost, 0))::text as margin,
           coalesce(cm.committed_cost, 0)::text as committed
      from scoped s
      left join actuals a on a.project_id = s.id
      left join budget b on b.project_id = s.id
      left join committed cm on cm.project_id = s.id
     where coalesce(a.cost, 0) <> 0 or coalesce(a.revenue, 0) <> 0
     order by s.code, s.name, s.id
  `);
  return res.rows.map((row) => ({
    id: String(row.id),
    code: (row.code as string | null) ?? null,
    name: String(row.name),
    status: (row.status as string | null) ?? null,
    customer: (row.customer as string | null) ?? null,
    contractValue: String(row.contract_value),
    costBudget: String(row.cost_budget),
    cost: String(row.cost),
    revenue: String(row.revenue),
    margin: String(row.margin),
    committed: String(row.committed),
  }));
}

/** The margin this fingerprint carried the last time a run persisted it, if any. */
async function priorPersistedMargin(orgId: string, fingerprint: string): Promise<string | null> {
  const res = await db.execute<{ margin: string | null }>(sql`
    select summary->>'margin' as margin
      from ai_work_items
     where org_id = ${orgId} and agent_key = 'projects' and fingerprint = ${fingerprint}
     order by last_detected_at desc
     limit 1
  `);
  return res.rows[0]?.margin ?? null;
}

type StaleUnbilledRow = {
  id: string;
  agedTime: string;
  agedDocuments: string;
  agedTotal: string;
  oldestDate: string | null;
};

/**
 * Unbilled work aged past the cutoff, reusing the WIP billing service's own
 * eligibility predicates (approved + billable + uninvoiced time at bill rate
 * with the item default-rate fallback; billable uninvoiced document lines at
 * the service's bill-amount cascade) minus the holds and open-prebill
 * reservations the service excludes. A cutoff replaces the service's billing
 * window: only work older than `unbilledDays` counts as stale.
 */
async function staleUnbilledByProject(orgId: string, cutoff: string): Promise<StaleUnbilledRow[]> {
  const res = await db.execute<Record<string, unknown>>(sql`
    with aged_time as (
      select te.project_id,
             round(te.hours * coalesce(te.bill_rate, item.default_rate, 0), 4) as bill_amount,
             te.worked_on as source_date
        from time_entries te
        left join items item on item.org_id = te.org_id and item.id = te.item_id
       where te.org_id = ${orgId}
         and te.project_id is not null
         and te.status = 'approved'
         and te.is_billable
         and te.billing_status = 'unbilled'
         and te.worked_on <= ${cutoff}
         and not exists (
               select 1 from wip_holds hold
                where hold.org_id = ${orgId}
                  and hold.source_type = 'time_entry'
                  and hold.source_id = te.id
                  and hold.released_at is null
             )
         and not exists (
               select 1
                 from wip_prebill_lines reserved
                 join wip_prebills worksheet
                   on worksheet.org_id = reserved.org_id and worksheet.id = reserved.prebill_id
                where reserved.org_id = ${orgId}
                  and reserved.source_type = 'time_entry'
                  and reserved.time_entry_id = te.id
                  and worksheet.status in ('draft', 'review', 'approved')
             )
    ),
    aged_documents as (
      select coalesce(line.project_id, doc.project_id) as project_id,
             (case
                when doc.kind = 'project_charge' then coalesce(line.bill_amount, 0)
                when line.bill_amount is not null then case when doc.kind in ('vendor_credit', 'card_refund') then -line.bill_amount else line.bill_amount end
                when line.markup_percent is not null then round((case when doc.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * (1 + line.markup_percent / 100), 4)
                else round((case when doc.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * coalesce(nullif(line.cost_multiplier, 0), 1), 4)
              end) as bill_amount,
             doc.document_date as source_date
        from document_lines line
        join documents doc on doc.org_id = line.org_id and doc.id = line.document_id
       where line.org_id = ${orgId}
         and coalesce(line.project_id, doc.project_id) is not null
         and line.is_billable
         and line.billed_by_line_id is null
         and doc.document_date <= ${cutoff}
         and not exists (
               select 1 from wip_holds hold
                where hold.org_id = ${orgId}
                  and hold.source_type = 'document_line'
                  and hold.source_id = line.id
                  and hold.released_at is null
             )
         and not exists (
               select 1
                 from wip_prebill_lines reserved
                 join wip_prebills worksheet
                   on worksheet.org_id = reserved.org_id and worksheet.id = reserved.prebill_id
                where reserved.org_id = ${orgId}
                  and reserved.source_type = 'document_line'
                  and reserved.document_line_id = line.id
                  and worksheet.status in ('draft', 'review', 'approved')
             )
    ),
    combined as (
      select project_id, bill_amount, source_date, 'time'::text as source from aged_time
      union all
      select project_id, bill_amount, source_date, 'document'::text as source from aged_documents
    )
    select p.id::text as id,
           coalesce(sum(c.bill_amount) filter (where c.source = 'time'), 0)::text as aged_time,
           coalesce(sum(c.bill_amount) filter (where c.source = 'document'), 0)::text as aged_documents,
           coalesce(sum(c.bill_amount), 0)::text as aged_total,
           min(c.source_date)::text as oldest_date
      from projects p
      left join combined c on c.project_id = p.id
     where p.org_id = ${orgId}
     group by p.id
    having coalesce(sum(c.bill_amount), 0) <> 0
     order by p.id
  `);
  return res.rows.map((row) => ({
    id: String(row.id),
    agedTime: String(row.aged_time),
    agedDocuments: String(row.aged_documents),
    agedTotal: String(row.aged_total),
    oldestDate: (row.oldest_date as string | null) ?? null,
  }));
}

function projectHref(projectId: string): string {
  return `${PROJECTS_HREF}?project=${projectId}`;
}

export async function projectsFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  const today = await businessToday(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  const marginPolicy = byKey.get("project_negative_margin");
  const overrunPolicy = byKey.get("project_budget_overrun");
  if (marginPolicy?.enabled || overrunPolicy?.enabled) {
    const rows = await rankProjectFinancials(orgId);
    if (marginPolicy?.enabled) {
      const threshold = effectiveDetectorMateriality(marginPolicy, agentThreshold);
      for (const row of rows) {
        // The report's own negative-margin predicate, under the floor.
        if (cmp(row.margin, "0") >= 0 || cmp(moneyAbs(row.margin), threshold) < 0) continue;
        const fingerprint = `project-negative-margin:${row.id}`;
        const priorMargin = await priorPersistedMargin(orgId, fingerprint);
        const crossed = priorMargin !== null && cmp(priorMargin, "0") >= 0;
        findings.push({
          agentKey: "projects",
          findingType: "project_negative_margin",
          fingerprint,
          severity: classifyForensicItem({
            materiality: moneyAbs(row.margin),
            threshold,
            criticalMaterialityMultiple: marginPolicy.parameters.criticalMaterialityMultiple,
          }),
          confidence: "1.0000",
          materiality: moneyAbs(row.margin),
          subjectType: "project",
          subjectId: row.id,
          summary: {
            projectId: row.id,
            code: row.code,
            name: row.name,
            status: row.status,
            customer: row.customer,
            revenue: row.revenue,
            cost: row.cost,
            committed: row.committed,
            margin: row.margin,
            priorMargin,
            crossedIntoNegative: crossed,
            contractValue: row.contractValue,
            href: projectHref(row.id),
          },
          evidence: [
            {
              kind: "project_margin",
              sourceType: "project",
              sourceId: row.id,
              data: {
                revenue: row.revenue,
                cost: row.cost,
                committed: row.committed,
                margin: row.margin,
                priorMargin,
                crossedIntoNegative: crossed,
                measuredAt: today,
              },
            },
          ],
        });
      }
    }
    if (overrunPolicy?.enabled) {
      const threshold = effectiveDetectorMateriality(overrunPolicy, agentThreshold);
      for (const row of rows) {
        // The report's own over-budget predicate (cost + committed past the
        // approved task budget), under the floor on the overrun amount.
        if (cmp(row.costBudget, "0") <= 0) continue;
        const overrun = add(add(row.cost, row.committed), `-${row.costBudget}`);
        if (cmp(overrun, "0") <= 0 || cmp(overrun, threshold) < 0) continue;
        findings.push({
          agentKey: "projects",
          findingType: "project_budget_overrun",
          fingerprint: `project-budget-overrun:${row.id}`,
          severity: classifyForensicItem({
            materiality: overrun,
            threshold,
            criticalMaterialityMultiple: overrunPolicy.parameters.criticalMaterialityMultiple,
          }),
          confidence: "1.0000",
          materiality: overrun,
          subjectType: "project",
          subjectId: row.id,
          summary: {
            projectId: row.id,
            code: row.code,
            name: row.name,
            status: row.status,
            customer: row.customer,
            cost: row.cost,
            committed: row.committed,
            budget: row.costBudget,
            overrun,
            contractValue: row.contractValue,
            href: projectHref(row.id),
          },
          evidence: [
            {
              kind: "project_budget",
              sourceType: "project",
              sourceId: row.id,
              data: {
                cost: row.cost,
                committed: row.committed,
                budget: row.costBudget,
                overrun,
                measuredAt: today,
              },
            },
          ],
        });
      }
    }
  }

  const unbilledPolicy = byKey.get("project_stale_unbilled");
  if (unbilledPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(unbilledPolicy, agentThreshold);
    const cutoff = addCalendarDays(today, -unbilledPolicy.parameters.unbilledDays!);
    const rows = await staleUnbilledByProject(orgId, cutoff);
    const names = new Map<string, { code: string | null; name: string }>();
    if (rows.length > 0) {
      const nameRes = await db.execute<Record<string, unknown>>(sql`
        select id::text as id, code, name from projects
         where org_id = ${orgId} and id in (${sql.join(rows.map((row) => sql`${row.id}::uuid`), sql`, `)})
      `);
      for (const row of nameRes.rows) {
        names.set(String(row.id), {
          code: (row.code as string | null) ?? null,
          name: String(row.name),
        });
      }
    }
    for (const row of rows) {
      if (cmp(row.agedTotal, threshold) < 0) continue;
      const meta = names.get(row.id);
      findings.push({
        agentKey: "projects",
        findingType: "project_stale_unbilled",
        fingerprint: `project-stale-unbilled:${row.id}`,
        severity: classifyForensicItem({
          materiality: row.agedTotal,
          threshold,
          criticalMaterialityMultiple: unbilledPolicy.parameters.criticalMaterialityMultiple,
        }),
        confidence: "1.0000",
        materiality: row.agedTotal,
        subjectType: "project",
        subjectId: row.id,
        summary: {
          projectId: row.id,
          code: meta?.code ?? null,
          name: meta?.name ?? null,
          agedTotal: row.agedTotal,
          agedTime: row.agedTime,
          agedDocuments: row.agedDocuments,
          oldestDate: row.oldestDate,
          unbilledDays: unbilledPolicy.parameters.unbilledDays,
          cutoff,
          href: projectHref(row.id),
        },
        evidence: [
          {
            kind: "project_unbilled",
            sourceType: "project",
            sourceId: row.id,
            data: {
              agedTime: row.agedTime,
              agedDocuments: row.agedDocuments,
              agedTotal: row.agedTotal,
              oldestDate: row.oldestDate,
              cutoff,
              measuredAt: today,
            },
          },
        ],
      });
    }
  }

  return findings;
}
