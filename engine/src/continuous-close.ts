import { sql } from "drizzle-orm";
import { db, schema, withOrg, withOrgContext } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  defaultContinuousCloseDetectors,
  effectiveDetectorMateriality,
  enabledDetectorKeys,
  normalizeContinuousCloseAnalysisSettings,
  normalizeContinuousCloseDetectors,
  type ContinuousCloseAnalysisSettings,
  type ContinuousCloseAgentKey,
  type ContinuousCloseDetectorKey,
  type ContinuousCloseDetectorPolicy,
} from "./continuous-close-config.ts";

export {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  CONTINUOUS_CLOSE_DETECTOR_SPECS,
  defaultContinuousCloseAnalysisSettings,
  defaultContinuousCloseDetectors,
  normalizeContinuousCloseAnalysisSettings,
  normalizeContinuousCloseDetectors,
  type AgentModelTier,
  type ContinuousCloseAnalysisSettings,
  type ContinuousCloseAgentKey,
  type ContinuousCloseDetectorKey,
  type ContinuousCloseDetectorPolicy,
  type ContinuousCloseDetectorSpec,
  type DetectorParameterSpec,
} from "./continuous-close-config.ts";

/**
 * Continuous Close control plane.
 *
 * The evidence controls are deliberately deterministic: SQL and exact money
 * arithmetic establish measured findings. A second, tool-using model layer
 * investigates records, connects drivers, and produces narratives and
 * recommendations, but never decides whether the books balance or posts.
 * Every scan refreshes stable fingerprints, replaces their evidence snapshot,
 * reopens conditions that returned, and auto-resolves conditions that cleared.
 */

export type AgentCadence = "daily" | "weekly";
export type AgentTrigger = "manual" | "scheduler";
export type WorkItemSeverity = "info" | "warning" | "critical";

export const CONTINUOUS_CLOSE_DETECTOR_VERSION = "2026.07.2";

export type ContinuousClosePolicy = {
  id: string | null;
  agentKey: ContinuousCloseAgentKey;
  enabled: boolean;
  automaticRuns: boolean;
  cadence: AgentCadence;
  materialityThreshold: string;
  detectors: ContinuousCloseDetectorPolicy[];
  analysis: ContinuousCloseAnalysisSettings;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: "completed" | "failed" | "skipped" | "running" | null;
};

type Evidence = {
  kind: string;
  sourceType?: string | null;
  sourceId?: string | null;
  data: Record<string, unknown>;
};

type Finding = {
  agentKey: ContinuousCloseAgentKey;
  findingType: string;
  fingerprint: string;
  severity: WorkItemSeverity;
  confidence: string;
  materiality: string;
  subjectType?: string | null;
  subjectId?: string | null;
  summary: Record<string, unknown>;
  evidence: Evidence[];
};

export function isContinuousCloseAgentKey(value: unknown): value is ContinuousCloseAgentKey {
  return typeof value === "string" && (CONTINUOUS_CLOSE_AGENT_KEYS as readonly string[]).includes(value);
}

export function defaultContinuousClosePolicy(agentKey: ContinuousCloseAgentKey): ContinuousClosePolicy {
  return {
    id: null,
    agentKey,
    enabled: false,
    automaticRuns: false,
    cadence: "daily",
    materialityThreshold: "1000.0000",
    detectors: defaultContinuousCloseDetectors(agentKey),
    analysis: normalizeContinuousCloseAnalysisSettings(null),
    lastRunAt: null,
    nextRunAt: null,
    lastRunStatus: null,
  };
}

export function nextContinuousCloseRunAt(cadence: AgentCadence, from = new Date()): Date {
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + (cadence === "weekly" ? 7 : 1));
  return next;
}

export async function getContinuousClosePolicies(orgId: string): Promise<ContinuousClosePolicy[]> {
  const rows = (await db.execute(sql`
    select p.id, p.agent_key, p.enabled, p.automatic_runs, p.cadence,
           p.materiality_threshold, p.detector_settings, p.analysis_settings,
           p.last_run_at, p.next_run_at,
           (select r.status from ai_agent_runs r
             where r.org_id = p.org_id and r.agent_key = p.agent_key
             order by r.started_at desc limit 1) as last_run_status
      from ai_agent_policies p
     where p.org_id = ${orgId}
  `)) as unknown as { rows: Record<string, unknown>[] };
  const byKey = new Map(rows.rows.map((row) => [String(row.agent_key), row]));
  return CONTINUOUS_CLOSE_AGENT_KEYS.map((agentKey) => {
    const row = byKey.get(agentKey);
    if (!row) return defaultContinuousClosePolicy(agentKey);
    return {
      id: String(row.id),
      agentKey,
      enabled: Boolean(row.enabled),
      automaticRuns: Boolean(row.automatic_runs),
      cadence: row.cadence === "weekly" ? "weekly" : "daily",
      materialityThreshold: String(row.materiality_threshold),
      detectors: normalizeContinuousCloseDetectors(agentKey, row.detector_settings),
      analysis: normalizeContinuousCloseAnalysisSettings(row.analysis_settings),
      lastRunAt: row.last_run_at ? new Date(row.last_run_at as string | Date).toISOString() : null,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at as string | Date).toISOString() : null,
      lastRunStatus: (row.last_run_status as ContinuousClosePolicy["lastRunStatus"]) ?? null,
    };
  });
}

function absoluteUnits(value: string): bigint {
  const units = toUnits(value);
  return units < 0n ? -units : units;
}

function moneyAbs(value: string): string {
  return fromUnits(absoluteUnits(value));
}

function dateAgeDays(value: string, now = new Date()): number {
  const date = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - date) / 86_400_000));
}

export function classifyUnmatchedBankActivity(args: {
  materiality: string;
  threshold: string;
  oldestDate: string;
  count: number;
  now?: Date;
  criticalAgeDays?: number;
  criticalItemCount?: number;
  criticalMaterialityMultiple?: number;
}): WorkItemSeverity {
  const age = dateAgeDays(args.oldestDate, args.now);
  const material = absoluteUnits(args.materiality);
  const threshold = absoluteUnits(args.threshold);
  if (age >= (args.criticalAgeDays ?? 30) || material >= threshold * BigInt(args.criticalMaterialityMultiple ?? 5) || args.count >= (args.criticalItemCount ?? 50)) return "critical";
  return "warning";
}

export function classifyBudgetVariance(args: { budget: string; actual: string; accountType: string; threshold: string; minimumVarianceBps?: number; criticalVarianceBps?: number }): {
  include: boolean;
  favorable: boolean;
  variance: string;
  varianceBps: number | null;
  severity: WorkItemSeverity;
} {
  const budget = toUnits(args.budget);
  const actual = toUnits(args.actual);
  const variance = actual - budget;
  const absVariance = variance < 0n ? -variance : variance;
  const absBudget = budget < 0n ? -budget : budget;
  const threshold = absoluteUnits(args.threshold);
  const income = args.accountType === "income" || args.accountType === "income_other";
  const favorable = income ? variance >= 0n : variance <= 0n;
  const varianceBps = absBudget === 0n ? null : Number((absVariance * 10_000n) / absBudget);
  const include = !favorable && absVariance >= threshold && (varianceBps === null || varianceBps >= (args.minimumVarianceBps ?? 1_000));
  const severity: WorkItemSeverity = varianceBps !== null && varianceBps >= (args.criticalVarianceBps ?? 2_500) ? "critical" : "warning";
  return {
    include,
    favorable,
    variance: fromUnits(variance),
    varianceBps,
    severity,
  };
}

export function classifyPeriodPerformance(args: { currentRevenue: string; priorRevenue: string; currentCogs: string; priorCogs: string; threshold: string; minimumRevenueDeclineBps?: number }): {
  revenueDecline: boolean;
  revenueChangeBps: number | null;
  grossMarginDropBps: number | null;
} {
  const currentRevenue = toUnits(args.currentRevenue);
  const priorRevenue = toUnits(args.priorRevenue);
  const threshold = absoluteUnits(args.threshold);
  const decline = priorRevenue - currentRevenue;
  const revenueChangeBps = priorRevenue === 0n ? null : Number(((currentRevenue - priorRevenue) * 10_000n) / (priorRevenue < 0n ? -priorRevenue : priorRevenue));
  const marginBps = (revenue: bigint, cogs: bigint): bigint | null => (revenue === 0n ? null : ((revenue - cogs) * 10_000n) / revenue);
  const currentMargin = marginBps(currentRevenue, toUnits(args.currentCogs));
  const priorMargin = marginBps(priorRevenue, toUnits(args.priorCogs));
  const grossMarginDropBps = currentMargin === null || priorMargin === null ? null : Number(priorMargin - currentMargin);
  return {
    revenueDecline: decline >= threshold && revenueChangeBps !== null && revenueChangeBps <= -(args.minimumRevenueDeclineBps ?? 1_000),
    revenueChangeBps,
    grossMarginDropBps,
  };
}

async function accountingFindings(orgId: string, agentThreshold: string, detectors: ContinuousCloseDetectorPolicy[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));
  const unmatchedPolicy = byKey.get("unmatched_bank_activity");
  if (unmatchedPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(unmatchedPolicy, agentThreshold);
    const unmatched = (await db.execute(sql`
      select a.id as account_id, a.number, a.name, count(*)::int as line_count,
             min(l.posted_on) as oldest_date, sum(abs(l.amount))::text as materiality
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
        join accounts a on a.id = s.account_id and a.org_id = s.org_id
       where l.org_id = ${orgId} and l.match_status = 'unmatched' and l.posted_on <= current_date
       group by a.id, a.number, a.name
    `)) as unknown as {
      rows: {
        account_id: string;
        number: string | null;
        name: string;
        line_count: number;
        oldest_date: string;
        materiality: string;
      }[];
    };

    for (const row of unmatched.rows) {
      const top = (await db.execute(sql`
      select l.id, l.posted_on, l.amount::text, l.description, l.counterparty_ref
        from bank_statement_lines l
        join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
       where l.org_id = ${orgId} and s.account_id = ${row.account_id}
         and l.match_status = 'unmatched' and l.posted_on <= current_date
       order by abs(l.amount) desc, l.posted_on
       limit 10
    `)) as unknown as { rows: Record<string, unknown>[] };
    const materiality = moneyAbs(row.materiality);
    findings.push({
        agentKey: "accounting",
        findingType: "unmatched_bank_activity",
        fingerprint: `unmatched-bank:${row.account_id}`,
        severity: classifyUnmatchedBankActivity({
          materiality,
          threshold,
          oldestDate: row.oldest_date,
          count: Number(row.line_count),
          criticalAgeDays: unmatchedPolicy.parameters.criticalAgeDays,
          criticalItemCount: unmatchedPolicy.parameters.criticalItemCount,
          criticalMaterialityMultiple: unmatchedPolicy.parameters.criticalMaterialityMultiple,
        }),
        confidence: "1.0000",
        materiality,
        subjectType: "account",
      subjectId: row.account_id,
      summary: {
        accountNumber: row.number,
        accountName: row.name,
        count: Number(row.line_count),
        oldestDate: row.oldest_date,
        href: `/banking/${row.account_id}`,
      },
      evidence: top.rows.map((item) => ({
        kind: "bank_transaction",
        sourceType: "bank_statement_line",
        sourceId: String(item.id),
        data: {
          postedOn: item.posted_on,
          amount: item.amount,
          description: item.description,
          counterpartyRef: item.counterparty_ref,
        },
        })),
      });
    }
  }

  const reconciliationPolicy = byKey.get("reconciliation_difference");
  if (reconciliationPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(reconciliationPolicy, agentThreshold);
    const reconciliations = (await db.execute(sql`
      select r.id, r.account_id, r.through_date, r.statement_balance::text,
             a.number, a.name,
           (r.statement_balance - coalesce((
             select sum(jl.amount)
               from journal_lines jl
               join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
              where jl.org_id = r.org_id and jl.account_id = r.account_id
                and (jl.reconciled_at is not null or exists (
                  select 1 from reconciliation_matches m
                   where m.reconciliation_id = r.id and m.journal_line_id = jl.id
                ))
           ), 0))::text as difference
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.org_id = ${orgId} and r.status = 'in_progress'
    `)) as unknown as {
      rows: {
        id: string;
        account_id: string;
        through_date: string;
        statement_balance: string;
        number: string | null;
        name: string;
        difference: string;
      }[];
    };

    for (const row of reconciliations.rows) {
      if (toUnits(row.difference) === 0n) continue;
    const materiality = moneyAbs(row.difference);
    findings.push({
      agentKey: "accounting",
      findingType: "reconciliation_difference",
      fingerprint: `reconciliation-difference:${row.id}`,
      severity: absoluteUnits(materiality) >= absoluteUnits(threshold) ? "critical" : "warning",
      confidence: "1.0000",
      materiality,
      subjectType: "reconciliation",
      subjectId: row.id,
      summary: {
        accountNumber: row.number,
        accountName: row.name,
        throughDate: row.through_date,
        statementBalance: row.statement_balance,
          difference: row.difference,
          href: `/banking/${row.account_id}/reconcile/${row.id}`,
        },
        evidence: [
          {
            kind: "reconciliation",
            sourceType: "reconciliation",
            sourceId: row.id,
            data: {
              statementBalance: row.statement_balance,
              difference: row.difference,
              throughDate: row.through_date,
            },
          },
        ],
      });
    }
  }

  const stalePolicy = byKey.get("stale_accounting_documents");
  if (stalePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(stalePolicy, agentThreshold);
    const staleAfterDays = stalePolicy.parameters.staleAfterDays;
    const stale = (await db.execute(sql`
      select count(*)::int as document_count, min(document_date) as oldest_date,
             coalesce(sum(abs(total)), 0)::text as materiality
        from documents
       where org_id = ${orgId} and status in ('draft','pending_approval')
         and document_date <= current_date - (${staleAfterDays} * interval '1 day')
         and kind in ('vendor_bill','vendor_credit','customer_invoice','customer_credit','expense_report','journal')
    `)) as unknown as {
      rows: {
        document_count: number;
        oldest_date: string | null;
        materiality: string;
      }[];
    };
    const staleRow = stale.rows[0];
    if (staleRow && Number(staleRow.document_count) > 0) {
      const documents = (await db.execute(sql`
        select id, kind, document_number, document_date, status, total::text
          from documents
         where org_id = ${orgId} and status in ('draft','pending_approval')
           and document_date <= current_date - (${staleAfterDays} * interval '1 day')
           and kind in ('vendor_bill','vendor_credit','customer_invoice','customer_credit','expense_report','journal')
         order by document_date, abs(total) desc limit 10
      `)) as unknown as { rows: Record<string, unknown>[] };
    const materiality = moneyAbs(staleRow.materiality);
    findings.push({
        agentKey: "accounting",
        findingType: "stale_accounting_documents",
        fingerprint: "stale-accounting-documents",
        severity: Number(staleRow.document_count) >= stalePolicy.parameters.criticalItemCount || absoluteUnits(materiality) >= absoluteUnits(threshold) * BigInt(stalePolicy.parameters.criticalMaterialityMultiple) ? "critical" : "warning",
        confidence: "1.0000",
        materiality,
        subjectType: "documents",
        summary: {
          count: Number(staleRow.document_count),
          oldestDate: staleRow.oldest_date,
          href: "/close",
        },
        evidence: documents.rows.map((item) => ({
          kind: "document",
          sourceType: "document",
        sourceId: String(item.id),
        data: {
          kind: item.kind,
          documentNumber: item.document_number,
          documentDate: item.document_date,
          status: item.status,
          total: item.total,
        },
        })),
      });
    }
  }

  return findings;
}

async function financeFindings(orgId: string, agentThreshold: string, detectors: ContinuousCloseDetectorPolicy[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));
  const missingBudgetPolicy = byKey.get("missing_approved_budget");
  const budgetVariancePolicy = byKey.get("unfavorable_budget_variance");
  if (missingBudgetPolicy?.enabled || budgetVariancePolicy?.enabled) {
    const scenario = (await db.execute(sql`
      select bs.id, bs.book_id, bs.name, bs.fiscal_year,
             min(p.starts_on) as starts_on, least(current_date, max(p.ends_on)) as ends_on
      from budget_scenarios bs
      join budget_lines bl on bl.scenario_id = bs.id and bl.org_id = bs.org_id
      join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
     where bs.org_id = ${orgId} and bs.kind = 'budget' and bs.status = 'approved'
       and p.starts_on <= current_date
       group by bs.id, bs.book_id, bs.name, bs.fiscal_year, bs.updated_at
       order by bs.fiscal_year desc, bs.updated_at desc
       limit 1
    `)) as unknown as {
      rows: {
        id: string;
        book_id: string;
        name: string;
        fiscal_year: number;
        starts_on: string;
        ends_on: string;
      }[];
    };
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
      const variances = (await db.execute(sql`
      with b as (
        select bl.account_id,
               sum(case when a.type in ('income','income_other') then -bl.amount else bl.amount end) as budget
          from budget_lines bl
          join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
          join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
         where bl.org_id = ${orgId} and bl.scenario_id = ${budget.id}
           and p.starts_on <= ${budget.ends_on} and p.ends_on >= ${budget.starts_on}
         group by bl.account_id
      ), actual as (
        select l.account_id,
               sum(case when a.type in ('income','income_other') then -l.amount else l.amount end) as actual
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status = 'posted'
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${budget.book_id}
           and e.posting_date >= ${budget.starts_on} and e.posting_date <= ${budget.ends_on}
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
      `)) as unknown as {
        rows: {
          id: string;
          number: string | null;
          name: string;
          type: string;
          budget: string;
          actual: string;
        }[];
      };
      for (const row of variances.rows) {
        const classification = classifyBudgetVariance({
          budget: row.budget,
          actual: row.actual,
          accountType: row.type,
          threshold,
          minimumVarianceBps: budgetVariancePolicy.parameters.minimumVariancePercent * 100,
          criticalVarianceBps: budgetVariancePolicy.parameters.criticalVariancePercent * 100,
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
    const periods = (await db.execute(sql`
    select p.id, p.name, p.starts_on, p.ends_on
      from accounting_periods p
      join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
     where p.org_id = ${orgId} and fc.is_default and fc.is_active
       and not p.is_adjustment and p.ends_on < current_date
     order by p.ends_on desc limit 2
    `)) as unknown as {
      rows: { id: string; name: string; starts_on: string; ends_on: string }[];
    };
    if (periods.rows.length === 2) {
      const [current, prior] = periods.rows;
      const metrics = async (period: { starts_on: string; ends_on: string }) => {
      const result = (await db.execute(sql`
        select coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0)::text as revenue,
               coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs,
               coalesce(sum(l.amount) filter (where a.type in ('expense','expense_other','expense_deferred')), 0)::text as opex
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status = 'posted'
          join accounting_books b on b.id = e.book_id and b.org_id = e.org_id and b.is_primary
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${orgId} and e.posting_date >= ${period.starts_on} and e.posting_date <= ${period.ends_on}
        `)) as unknown as {
          rows: { revenue: string; cogs: string; opex: string }[];
        };
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
          severity: performance.revenueChangeBps !== null && performance.revenueChangeBps <= -(revenuePolicy.parameters.criticalDeclinePercent * 100) ? "critical" : "warning",
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
      if (marginPolicy?.enabled && performance.grossMarginDropBps !== null && performance.grossMarginDropBps >= marginPolicy.parameters.minimumDropPoints * 100 && absoluteUnits(currentMetrics.revenue) >= absoluteUnits(marginThreshold)) {
        const currentGross = toUnits(currentMetrics.revenue) - toUnits(currentMetrics.cogs);
        const priorGross = toUnits(priorMetrics.revenue) - toUnits(priorMetrics.cogs);
        findings.push({
          agentKey: "finance",
          findingType: "gross_margin_decline",
          fingerprint: `gross-margin-decline:${current.id}`,
          severity: performance.grossMarginDropBps >= marginPolicy.parameters.criticalDropPoints * 100 ? "critical" : "warning",
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

async function persistFinding(orgId: string, runId: string, finding: Finding): Promise<string> {
  const result = (await db.execute(sql`
    insert into ai_work_items (
      org_id, agent_key, finding_type, detector_version, fingerprint, severity,
      confidence, materiality, subject_type, subject_id, summary,
      last_detected_run_id, created_by, updated_by
    ) values (
      ${orgId}, ${finding.agentKey}, ${finding.findingType}, ${CONTINUOUS_CLOSE_DETECTOR_VERSION},
      ${finding.fingerprint}, ${finding.severity}, ${finding.confidence}, ${finding.materiality},
      ${finding.subjectType ?? null}, ${finding.subjectId ?? null}, ${JSON.stringify(finding.summary)}::jsonb,
      ${runId}, null, null
    )
    on conflict (org_id, agent_key, fingerprint) do update set
      finding_type = excluded.finding_type,
      detector_version = excluded.detector_version,
      severity = excluded.severity,
      confidence = excluded.confidence,
      materiality = excluded.materiality,
      subject_type = excluded.subject_type,
      subject_id = excluded.subject_id,
      summary = excluded.summary,
      last_detected_at = now(),
      last_detected_run_id = excluded.last_detected_run_id,
      status = case when ai_work_items.status = 'resolved' then 'open' else ai_work_items.status end,
      resolved_at = case when ai_work_items.status = 'resolved' then null else ai_work_items.resolved_at end,
      resolved_by = case when ai_work_items.status = 'resolved' then null else ai_work_items.resolved_by end,
      updated_at = now()
    returning id
  `)) as unknown as { rows: { id: string }[] };
  const itemId = result.rows[0]!.id;
  await db.execute(sql`delete from ai_work_item_evidence where org_id = ${orgId} and work_item_id = ${itemId}`);
  if (finding.evidence.length > 0) {
    await db.insert(schema.aiWorkItemEvidence).values(
      finding.evidence.map((evidence) => ({
        orgId,
        workItemId: itemId,
        kind: evidence.kind,
        sourceType: evidence.sourceType ?? null,
        sourceId: evidence.sourceId ?? null,
        data: evidence.data,
      })),
    );
  }
  return itemId;
}

export type ContinuousCloseRunResult = {
  runId: string;
  agentKey: ContinuousCloseAgentKey;
  status: "completed" | "failed" | "skipped";
  detected: number;
  autoResolved: number;
};

export type ContinuousCloseEnrichmentInput = {
  orgId: string;
  runId: string;
  agentKey: ContinuousCloseAgentKey;
  trigger: AgentTrigger;
  findingIds: string[];
  analysis: ContinuousCloseAnalysisSettings;
};

export type ContinuousCloseEnrichmentResult = {
  status: "completed" | "skipped" | "failed";
  analyzedFindings: number;
  /** Structured, evidence-grounded brief persisted with the immutable run. */
  narrative?: Record<string, unknown> | null;
  model?: string | null;
  toolCalls?: number;
  reason?: string;
};

type ContinuousCloseEnricher = (
  input: ContinuousCloseEnrichmentInput,
) => Promise<ContinuousCloseEnrichmentResult>;

type ContinuousCloseRuntime = typeof globalThis & {
  __openbooksContinuousCloseEnricher?: ContinuousCloseEnricher | null;
};

function registeredContinuousCloseEnricher(): ContinuousCloseEnricher | null {
  return (globalThis as ContinuousCloseRuntime).__openbooksContinuousCloseEnricher ?? null;
}

/**
 * The web process registers the shared chatbot tool runtime at boot. Keeping
 * the hook here lets the accounting engine schedule scans without importing
 * Next.js, while manual and scheduled runs use the same governed tools.
 */
export function registerContinuousCloseEnricher(enricher: ContinuousCloseEnricher | null): void {
  // Next's development bundler can instantiate the engine through more than
  // one module identifier (for example the instrumentation and route graphs).
  // Process-global storage keeps the registered runtime shared in that case
  // and also survives hot-reload module replacement.
  (globalThis as ContinuousCloseRuntime).__openbooksContinuousCloseEnricher = enricher;
}

export async function runContinuousCloseAgent(args: { orgId: string; agentKey: ContinuousCloseAgentKey; trigger: AgentTrigger; initiatedBy?: string | null }): Promise<ContinuousCloseRunResult> {
  type PreparedRun =
    | { kind: "terminal"; result: ContinuousCloseRunResult }
    | {
        kind: "ready";
        runId: string;
        detected: number;
        autoResolved: number;
        evaluatedDetectors: ContinuousCloseDetectorKey[];
        findingIds: string[];
        analysis: ContinuousCloseAnalysisSettings;
      };

  const prepared = await withOrg(args.orgId, async (): Promise<PreparedRun> => {
    const lock = (await db.execute(sql`
      select pg_try_advisory_xact_lock(hashtextextended(${`${args.orgId}:${args.agentKey}`}, 0)) as acquired
    `)) as unknown as { rows: { acquired: boolean }[] };
    if (!lock.rows[0]?.acquired) {
      const [skipped] = await db
        .insert(schema.aiAgentRuns)
        .values({
          orgId: args.orgId,
          agentKey: args.agentKey,
          trigger: args.trigger,
          status: "skipped",
          detectorVersion: CONTINUOUS_CLOSE_DETECTOR_VERSION,
          initiatedBy: args.initiatedBy ?? null,
          finishedAt: new Date(),
          stats: { reason: "already_running" },
        })
        .returning({ id: schema.aiAgentRuns.id });
      return { kind: "terminal", result: { runId: skipped!.id, agentKey: args.agentKey, status: "skipped", detected: 0, autoResolved: 0 } };
    }
    // The advisory transaction lock closes the insert race. The durable row
    // keeps a second request from starting while the first run is outside its
    // short detector transaction and using network-bound model tools.
    const active = (await db.execute(sql`
      select id from ai_agent_runs
       where org_id = ${args.orgId} and agent_key = ${args.agentKey}
         and status = 'running' and started_at > now() - interval '15 minutes'
       order by started_at desc limit 1
    `)) as unknown as { rows: { id: string }[] };
    if (active.rows[0]) {
      const [skipped] = await db
        .insert(schema.aiAgentRuns)
        .values({
          orgId: args.orgId,
          agentKey: args.agentKey,
          trigger: args.trigger,
          status: "skipped",
          detectorVersion: CONTINUOUS_CLOSE_DETECTOR_VERSION,
          initiatedBy: args.initiatedBy ?? null,
          finishedAt: new Date(),
          stats: { reason: "already_running", activeRunId: active.rows[0].id },
        })
        .returning({ id: schema.aiAgentRuns.id });
      return { kind: "terminal", result: { runId: skipped!.id, agentKey: args.agentKey, status: "skipped", detected: 0, autoResolved: 0 } };
    }
    const global = (await db.execute(sql`
      select coalesce((settings->'ai'->>'enabled')::boolean, true) as enabled
        from orgs where id = ${args.orgId}
    `)) as unknown as { rows: { enabled: boolean }[] };
    const policy = (await db.execute(sql`
      select enabled, materiality_threshold::text, detector_settings, analysis_settings
        from ai_agent_policies where org_id = ${args.orgId} and agent_key = ${args.agentKey}
    `)) as unknown as {
      rows: {
        enabled: boolean;
        materiality_threshold: string;
        detector_settings: unknown;
        analysis_settings: unknown;
      }[];
    };
    const configured = policy.rows[0];
    const [run] = await db
      .insert(schema.aiAgentRuns)
      .values({
        orgId: args.orgId,
        agentKey: args.agentKey,
        trigger: args.trigger,
        detectorVersion: CONTINUOUS_CLOSE_DETECTOR_VERSION,
        initiatedBy: args.initiatedBy ?? null,
      })
      .returning({ id: schema.aiAgentRuns.id });
    if (!global.rows[0]?.enabled || !configured?.enabled) {
      await db.execute(sql`
        update ai_agent_runs set status = 'skipped', finished_at = now(), stats = '{"reason":"disabled"}'::jsonb
         where id = ${run!.id} and org_id = ${args.orgId}
      `);
      return { kind: "terminal", result: { runId: run!.id, agentKey: args.agentKey, status: "skipped", detected: 0, autoResolved: 0 } };
    }
    try {
      const detectors = normalizeContinuousCloseDetectors(args.agentKey, configured.detector_settings);
      const analysis = normalizeContinuousCloseAnalysisSettings(configured.analysis_settings);
      const evaluatedDetectors = enabledDetectorKeys(detectors);
      const findings = args.agentKey === "accounting" ? await accountingFindings(args.orgId, configured.materiality_threshold, detectors) : await financeFindings(args.orgId, configured.materiality_threshold, detectors);
      const findingIds: string[] = [];
      for (const finding of findings) findingIds.push(await persistFinding(args.orgId, run!.id, finding));
      const resolved =
        evaluatedDetectors.length === 0
          ? { rows: [] as { id: string }[] }
          : ((await db.execute(sql`
            update ai_work_items
               set status = 'resolved', resolved_at = now(), resolved_by = null, updated_at = now()
             where org_id = ${args.orgId} and agent_key = ${args.agentKey}
               and finding_type in (${sql.join(
                 evaluatedDetectors.map((key) => sql`${key}`),
                 sql`, `,
               )})
               and status in ('open','in_review') and last_detected_run_id is distinct from ${run!.id}
            returning id
          `)) as unknown as { rows: { id: string }[] });
      return {
        kind: "ready",
        runId: run!.id,
        detected: findings.length,
        autoResolved: resolved.rows.length,
        evaluatedDetectors,
        findingIds,
        analysis,
      };
    } catch (error) {
      console.error(`[continuous-close] ${args.agentKey} scan failed`, error);
      await db.execute(sql`
        update ai_agent_runs set status = 'failed', finished_at = now(), error_code = 'detector_failed'
         where id = ${run!.id} and org_id = ${args.orgId}
      `);
      return { kind: "terminal", result: { runId: run!.id, agentKey: args.agentKey, status: "failed", detected: 0, autoResolved: 0 } };
    }
  });
  if (prepared.kind === "terminal") return prepared.result;

  let enrichment: ContinuousCloseEnrichmentResult = {
    status: "skipped",
    analyzedFindings: 0,
    reason: registeredContinuousCloseEnricher() ? "all_model_capabilities_disabled" : "tool_runtime_unavailable",
  };
  const modelWorkEnabled = prepared.analysis.rootCauseAnalysis || prepared.analysis.recommendations || prepared.analysis.narrative;
  const enricher = registeredContinuousCloseEnricher();
  if (enricher && modelWorkEnabled) {
    try {
      enrichment = await withOrgContext(args.orgId, () => enricher({
        orgId: args.orgId,
        runId: prepared.runId,
        agentKey: args.agentKey,
        trigger: args.trigger,
        findingIds: prepared.findingIds,
        analysis: prepared.analysis,
      }));
    } catch (error) {
      console.error(`[continuous-close] ${args.agentKey} enrichment failed`, error);
      enrichment = {
        status: "failed",
        analyzedFindings: 0,
        reason: error instanceof Error && error.message === "continuous_close_agent_timeout"
          ? "enrichment_timeout"
          : error instanceof Error && error.message.startsWith("continuous_close_evidence_validation:")
            ? "evidence_validation_failed"
            : "enrichment_failed",
      };
    }
  }
  const stats = {
    detected: prepared.detected,
    autoResolved: prepared.autoResolved,
    evaluatedDetectors: prepared.evaluatedDetectors,
    enrichment,
  };
  return withOrg(args.orgId, async () => {
    await db.execute(sql`
      update ai_agent_runs set status = 'completed', finished_at = now(), stats = ${JSON.stringify(stats)}::jsonb
       where id = ${prepared.runId} and org_id = ${args.orgId}
    `);
    await db.execute(sql`
      update ai_agent_policies set last_run_at = now(), updated_at = now()
       where org_id = ${args.orgId} and agent_key = ${args.agentKey}
    `);
    return {
      runId: prepared.runId,
      agentKey: args.agentKey,
      status: "completed",
      ...stats,
    };
  });
}

/** Claim and execute every tenant policy whose automatic scan is due. */
export async function runDueContinuousCloseAgents(now = new Date()): Promise<void> {
  const due = (await db.execute(sql`
    select p.id, p.org_id, p.agent_key, p.cadence, p.next_run_at
      from ai_agent_policies p
      join orgs o on o.id = p.org_id
     where p.enabled and p.automatic_runs and p.next_run_at <= ${now}
       and coalesce((o.settings->'ai'->>'enabled')::boolean, true)
     order by p.next_run_at
  `)) as unknown as {
    rows: {
      id: string;
      org_id: string;
      agent_key: ContinuousCloseAgentKey;
      cadence: AgentCadence;
      next_run_at: Date;
    }[];
  };
  for (const policy of due.rows) {
    const next = nextContinuousCloseRunAt(policy.cadence, now);
    const claim = (await db.execute(sql`
      update ai_agent_policies set next_run_at = ${next}, updated_at = now()
       where id = ${policy.id} and next_run_at = ${policy.next_run_at}
      returning id
    `)) as unknown as { rows: { id: string }[] };
    if (claim.rows.length === 0) continue;
    await runContinuousCloseAgent({
      orgId: policy.org_id,
      agentKey: policy.agent_key,
      trigger: "scheduler",
    });
  }
}
