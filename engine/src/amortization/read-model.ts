/** Read model for one schedule: header, balances, plan versus posted by period, and history. */
import { sql } from "drizzle-orm";
import { fromUnits } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import {
  livePlanLines,
  loadSchedule,
  scheduleBalance,
  type StoredSchedule,
} from "./schedule-store.ts";

export interface ScheduleListRow {
  id: string;
  schedule_number: string;
  status: string;
  source_kind: string;
  source_document_id: string | null;
  document_number: string | null;
  template_code: string;
  subsidiary_name: string | null;
  currency: string;
  total_amount: string;
  amortized: string;
  remaining: string;
  next_period: string | null;
}

/** The schedule list's native read model, shared by the workspace and API tools. */
export async function listScheduleRows(
  runner: SqlExecutor,
  orgId: string,
  options: {
    status?: "open" | "draft" | "active" | "on_hold" | "completed" | "cancelled";
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    limit?: number;
  },
): Promise<ScheduleListRow[]> {
  const statusClause =
    options.status === "open"
      ? sql`and s.status in ('draft', 'active', 'on_hold')`
      : options.status
        ? sql`and s.status = ${options.status}`
        : sql``;
  const scopeClause =
    options.allowedSubsidiaryIds === null
      ? sql``
      : sql`and s.subsidiary_id = any(${`{${[...options.allowedSubsidiaryIds].join(",")}}`}::uuid[])`;
  return runner.execute<ScheduleListRow>(
    sql`
    select s.id, s.schedule_number, s.status, s.source_kind, s.source_document_id, d.document_number,
           t.code as template_code, sub.name as subsidiary_name, s.currency, s.total_amount::text as total_amount,
           (s.opening_amortized_amount - s.reversed_amount + coalesce(p.posted, 0))::text as amortized,
           (case when s.status = 'cancelled' then 0
                 else s.total_amount - s.opening_amortized_amount + s.reversed_amount - coalesce(p.posted, 0) end)::text as remaining,
           n.next_period::text as next_period
      from expense_amortization_schedules s
      join expense_amortization_templates t on t.org_id = s.org_id and t.id = s.template_id
      left join subsidiaries sub on sub.org_id = s.org_id and sub.id = s.subsidiary_id
      left join documents d on d.org_id = s.org_id and d.id = s.source_document_id
      left join lateral (
        select sum(l.planned_amount) as posted from expense_amortization_schedule_lines l
         where l.org_id = s.org_id and l.schedule_id = s.id and l.status = 'posted'
      ) p on true
      left join lateral (
        select min(l.period_start) as next_period from expense_amortization_schedule_lines l
         where l.org_id = s.org_id and l.schedule_id = s.id and l.status = 'planned'
      ) n on true
     where s.org_id = ${orgId} ${statusClause} ${scopeClause}
     order by s.schedule_number desc
     limit ${Math.min(Math.max(options.limit ?? 2000, 1), 2000)}
  `,
    "objects",
  );
}

export interface ScheduleDetail {
  schedule: Omit<StoredSchedule, "totalAmount" | "openingAmortized" | "reversed"> & {
    totalAmount: string;
    openingAmortized: string;
    reversed: string;
    templateCode: string;
    templateName: string;
    subsidiaryName: string | null;
    deferralAccount: string;
    destinationAccount: string;
    source: {
      kind: string;
      documentId: string;
      documentNumber: string | null;
      lineNumber: number | null;
    } | null;
  };
  balance: { amortized: string; remaining: string; planned: string; posted: string };
  periods: {
    periodStart: string;
    planned: string;
    posted: string | null;
    status: "planned" | "posted";
    account: string;
    journalEntryId: string | null;
  }[];
  history: {
    id: string;
    kind: string;
    reason: string;
    effectiveOn: string;
    effectivePeriodOn: string | null;
    balanceDelta: string;
    journalEntryId: string | null;
    actorName: string | null;
    createdAt: string;
  }[];
  supersededPlans: { planRevision: number; periodStart: string; planned: string; status: string }[];
}

export async function loadScheduleDetail(
  runner: SqlExecutor,
  orgId: string,
  scheduleId: string,
): Promise<ScheduleDetail> {
  const schedule = await loadSchedule(runner, orgId, scheduleId);
  const names = (
    await runner.execute<{
      template_code: string;
      template_name: string;
      subsidiary_name: string | null;
      deferral_account: string;
      destination_account: string;
      document_number: string | null;
      document_kind: string | null;
      line_number: number | null;
    }>(
      sql`
    select t.code as template_code, t.name as template_name, sub.name as subsidiary_name,
           concat_ws(' · ', da.number, da.name) as deferral_account,
           concat_ws(' · ', xa.number, xa.name) as destination_account,
           d.document_number, d.kind as document_kind, dl.line_number
      from expense_amortization_schedules s
      join expense_amortization_templates t on t.org_id = s.org_id and t.id = s.template_id
      left join subsidiaries sub on sub.org_id = s.org_id and sub.id = s.subsidiary_id
      join accounts da on da.org_id = s.org_id and da.id = s.deferral_account_id
      join accounts xa on xa.org_id = s.org_id and xa.id = s.destination_account_id
      left join documents d on d.org_id = s.org_id and d.id = s.source_document_id
      left join document_lines dl on dl.org_id = s.org_id and dl.id = s.source_line_id
     where s.org_id = ${orgId} and s.id = ${scheduleId}`,
      "objects",
    )
  )[0]!;
  const lines = await livePlanLines(runner, orgId, scheduleId);
  const balance = scheduleBalance(schedule, lines);
  const accountNames = new Map(
    (
      await runner.execute<{ id: string; label: string }>(
        sql`
      select a.id, concat_ws(' · ', a.number, a.name) as label
        from accounts a
       where a.org_id = ${orgId}
         and a.id in (select destination_account_id from expense_amortization_schedule_lines
                       where org_id = ${orgId} and schedule_id = ${scheduleId})`,
        "objects",
      )
    ).map((row) => [row.id, row.label]),
  );
  const history = await runner.execute<{
    id: string;
    kind: string;
    reason: string;
    effective_on: string;
    effective_period_on: string | null;
    balance_delta: string;
    journal_entry_id: string | null;
    actor_name: string | null;
    created_at: string;
  }>(
    sql`
    select e.id, e.kind, e.reason, e.effective_on::text as effective_on,
           e.effective_period_on::text as effective_period_on, e.balance_delta::text as balance_delta,
           e.journal_entry_id, u.name as actor_name, e.created_at::text as created_at
      from expense_amortization_schedule_events e
      left join users u on u.org_id = e.org_id and u.id = e.created_by
     where e.org_id = ${orgId} and e.schedule_id = ${scheduleId}
     order by e.created_at, e.id`,
    "objects",
  );
  const superseded = await runner.execute<{
    plan_revision: number;
    period_start: string;
    planned_amount: string;
    status: string;
  }>(
    sql`
    select plan_revision, period_start::text as period_start, planned_amount::text as planned_amount, status
      from expense_amortization_schedule_lines
     where org_id = ${orgId} and schedule_id = ${scheduleId} and status in ('superseded', 'cancelled')
     order by plan_revision, period_start`,
    "objects",
  );
  return {
    schedule: {
      ...schedule,
      totalAmount: fromUnits(schedule.totalAmount),
      openingAmortized: fromUnits(schedule.openingAmortized),
      reversed: fromUnits(schedule.reversed),
      templateCode: names.template_code,
      templateName: names.template_name,
      subsidiaryName: names.subsidiary_name,
      deferralAccount: names.deferral_account,
      destinationAccount: names.destination_account,
      source: schedule.sourceDocumentId
        ? {
            kind: names.document_kind ?? schedule.sourceKind,
            documentId: schedule.sourceDocumentId,
            documentNumber: names.document_number,
            lineNumber: names.line_number,
          }
        : null,
    },
    balance: {
      amortized: fromUnits(balance.amortized),
      remaining: fromUnits(balance.remaining),
      planned: fromUnits(balance.planned),
      posted: fromUnits(balance.posted),
    },
    periods: lines.map((line) => ({
      periodStart: line.periodStart,
      planned: fromUnits(line.plannedAmount),
      posted: line.status === "posted" ? fromUnits(line.plannedAmount) : null,
      status: line.status,
      account: accountNames.get(line.destinationAccountId) ?? line.destinationAccountId,
      journalEntryId: line.journalEntryId,
    })),
    history: history.map((row) => ({
      id: row.id,
      kind: row.kind,
      reason: row.reason,
      effectiveOn: row.effective_on,
      effectivePeriodOn: row.effective_period_on,
      balanceDelta: row.balance_delta,
      journalEntryId: row.journal_entry_id,
      actorName: row.actor_name,
      createdAt: row.created_at,
    })),
    supersededPlans: superseded.map((row) => ({
      planRevision: row.plan_revision,
      periodStart: row.period_start,
      planned: row.planned_amount,
      status: row.status,
    })),
  };
}
