import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "./continuous-close-config.ts";
import {
  absoluteUnits,
  classifyBudgetVariance,
  classifyPeriodPerformance,
  moneyAbs,
} from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Finance pack — budget and period-performance controls. Byte-identical
 * behaviour to the original control-plane implementation; only the location
 * changed so every agent pack shares the registry in registry.ts.
 */
export async function financeFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  const today = await businessToday(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));
  const missingBudgetPolicy = byKey.get("missing_approved_budget");
  const budgetVariancePolicy = byKey.get("unfavorable_budget_variance");
  if (missingBudgetPolicy?.enabled || budgetVariancePolicy?.enabled) {
    const scenario = (await db.execute<{
        id: string;
        book_id: string;
        name: string;
        fiscal_year: number;
        starts_on: string;
        ends_on: string;
      }>(sql`
      select bs.id, bs.book_id, bs.name, bs.fiscal_year,
             min(p.starts_on) as starts_on, least(${today}::date, max(p.ends_on)) as ends_on
      from budget_scenarios bs
      join budget_lines bl on bl.scenario_id = bs.id and bl.org_id = bs.org_id
      join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
     where bs.org_id = ${orgId} and bs.kind = 'budget' and bs.status = 'approved'
       and p.starts_on <= ${today}
       group by bs.id, bs.book_id, bs.name, bs.fiscal_year, bs.updated_at
       order by bs.fiscal_year desc, bs.updated_at desc
       limit 1
    `));
    const budget = scenario.rows[0];
    if (!budget && missingBudgetPolicy?.enabled) {
      findings.push({
        agentKey: "finance",
        findingType: "missing_approved_budget",
      fingerprint: "missing-approved-budget",
      severity: "info",
      confidence: "1.0000",
      materiality: "0.0000",
      subjectType: "budget",
        summary: { href: "/budgets" },
        evidence: [],
      });
    } else if (budget && budgetVariancePolicy?.enabled) {
      const threshold = effectiveDetectorMateriality(budgetVariancePolicy, agentThreshold);
      const variances = (await db.execute<{
          id: string;
          number: string | null;
          name: string;
          type: string;
          budget: string;
          actual: string;
        }>(sql`
      with selected_periods as (
        select p.id
          from accounting_periods p
         where p.org_id = ${orgId}
           and p.starts_on <= ${budget.ends_on}
           and p.ends_on >= ${budget.starts_on}
      ), b as (
        select bl.account_id,
               sum(case when a.type in ('income','income_other') then -bl.amount else bl.amount end) as budget
          from budget_lines bl
          join selected_periods p on p.id = bl.period_id
          join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
         where bl.org_id = ${orgId} and bl.scenario_id = ${budget.id}
         group by bl.account_id
      ), actual as (
        select l.account_id,
               sum(case when a.type in ('income','income_other') then -l.amount else l.amount end) as actual
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${budget.book_id}
           and e.period_id in (select id from selected_periods)
         group by l.account_id
      )
      select a.id, a.number, a.name, a.type,
             coalesce(b.budget, 0)::text as budget, coalesce(actual.actual, 0)::text as actual
        from accounts a
        left join b on b.account_id = a.id
        left join actual on actual.account_id = a.id
       where a.org_id = ${orgId}
         and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
         and (b.account_id is not null or actual.account_id is not null)
      `));
      for (const row of variances.rows) {
        const classification = classifyBudgetVariance({
          budget: row.budget,
          actual: row.actual,
          accountType: row.type,
          threshold,
          minimumVarianceBps: budgetVariancePolicy.parameters.minimumVariancePercent! * 100,
          criticalVarianceBps: budgetVariancePolicy.parameters.criticalVariancePercent! * 100,
        });
        if (!classification.include) continue;
        findings.push({
          agentKey: "finance",
        findingType: "unfavorable_budget_variance",
        fingerprint: `budget-variance:${budget.id}:${row.id}`,
        severity: classification.severity,
        confidence: "1.0000",
        materiality: moneyAbs(classification.variance),
        subjectType: "account",
        subjectId: row.id,
        summary: {
          accountNumber: row.number,
          accountName: row.name,
          accountType: row.type,
          scenarioId: budget.id,
          scenarioName: budget.name,
          fiscalYear: Number(budget.fiscal_year),
          from: budget.starts_on,
          to: budget.ends_on,
          budget: row.budget,
          actual: row.actual,
          variance: classification.variance,
            varianceBps: classification.varianceBps,
            href: `/budgets?budget=${budget.id}`,
          },
          evidence: [
            {
              kind: "budget_variance",
              sourceType: "budget_scenario",
              sourceId: budget.id,
              data: {
                budget: row.budget,
                actual: row.actual,
                variance: classification.variance,
                varianceBps: classification.varianceBps,
              },
            },
          ],
        });
      }
    }
  }

  const revenuePolicy = byKey.get("period_revenue_decline");
  const marginPolicy = byKey.get("gross_margin_decline");
  if (revenuePolicy?.enabled || marginPolicy?.enabled) {
    const periods = (await db.execute<{ id: string; name: string; starts_on: string; ends_on: string }>(sql`
    select p.id, p.name, p.starts_on, p.ends_on
      from accounting_periods p
      join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
     where p.org_id = ${orgId} and fc.is_default and fc.is_active
       and not p.is_adjustment and p.ends_on < ${today}
     order by p.ends_on desc limit 2
    `));
    if (periods.rows.length === 2) {
      const current = periods.rows[0]!;
      const prior = periods.rows[1]!;
      const metrics = async (period: { id: string }) => {
      const result = (await db.execute<{ revenue: string; cogs: string; opex: string }>(sql`
        select coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0)::text as revenue,
               coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs,
               coalesce(sum(l.amount) filter (where a.type in ('expense','expense_other','expense_deferred')), 0)::text as opex
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
          join accounting_books b on b.id = e.book_id and b.org_id = e.org_id and b.is_primary
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${orgId} and e.period_id = ${period.id}
        `));
        return result.rows[0] ?? { revenue: "0", cogs: "0", opex: "0" };
      };
      const [currentMetrics, priorMetrics] = await Promise.all([metrics(current), metrics(prior)]);
      const revenueThreshold = revenuePolicy?.enabled ? effectiveDetectorMateriality(revenuePolicy, agentThreshold) : agentThreshold;
      const performance = classifyPeriodPerformance({
        currentRevenue: currentMetrics.revenue,
        priorRevenue: priorMetrics.revenue,
        currentCogs: currentMetrics.cogs,
        priorCogs: priorMetrics.cogs,
        threshold: revenueThreshold,
        minimumRevenueDeclineBps: revenuePolicy?.parameters.minimumDeclinePercent !== undefined ? revenuePolicy.parameters.minimumDeclinePercent * 100 : undefined,
      });
      const comparison = {
        currentPeriod: current.name,
      priorPeriod: prior.name,
      currentRevenue: currentMetrics.revenue,
      priorRevenue: priorMetrics.revenue,
      currentCogs: currentMetrics.cogs,
      priorCogs: priorMetrics.cogs,
        revenueChangeBps: performance.revenueChangeBps,
        grossMarginDropBps: performance.grossMarginDropBps,
      };
      if (revenuePolicy?.enabled && performance.revenueDecline) {
        findings.push({
          agentKey: "finance",
          findingType: "period_revenue_decline",
          fingerprint: `period-revenue-decline:${current.id}`,
          severity: performance.revenueChangeBps !== null && performance.revenueChangeBps <= -(revenuePolicy.parameters.criticalDeclinePercent! * 100) ? "critical" : "warning",
          confidence: "1.0000",
          materiality: moneyAbs(fromUnits(toUnits(priorMetrics.revenue) - toUnits(currentMetrics.revenue))),
          subjectType: "accounting_period",
          subjectId: current.id,
          summary: {
            ...comparison,
            href: `/reports/pnl?from=${current.starts_on}&to=${current.ends_on}`,
          },
          evidence: [
            {
              kind: "period_comparison",
              sourceType: "accounting_period",
              sourceId: current.id,
              data: comparison,
            },
          ],
        });
      }
      const marginThreshold = marginPolicy?.enabled ? effectiveDetectorMateriality(marginPolicy, agentThreshold) : agentThreshold;
      if (marginPolicy?.enabled && performance.grossMarginDropBps !== null && performance.grossMarginDropBps >= marginPolicy.parameters.minimumDropPoints! * 100 && absoluteUnits(currentMetrics.revenue) >= absoluteUnits(marginThreshold)) {
        const currentGross = toUnits(currentMetrics.revenue) - toUnits(currentMetrics.cogs);
        const priorGross = toUnits(priorMetrics.revenue) - toUnits(priorMetrics.cogs);
        findings.push({
          agentKey: "finance",
          findingType: "gross_margin_decline",
          fingerprint: `gross-margin-decline:${current.id}`,
          severity: performance.grossMarginDropBps >= marginPolicy.parameters.criticalDropPoints! * 100 ? "critical" : "warning",
          confidence: "1.0000",
          materiality: fromUnits(priorGross > currentGross ? priorGross - currentGross : 0n),
          subjectType: "accounting_period",
          subjectId: current.id,
          summary: {
            ...comparison,
            href: `/reports/pnl?from=${current.starts_on}&to=${current.ends_on}`,
          },
          evidence: [
            {
              kind: "period_comparison",
              sourceType: "accounting_period",
              sourceId: current.id,
              data: comparison,
            },
          ],
        });
      }
    }
  }

  return findings;
}
