import {
  assertRoeReportingCurrency,
  selectRoeEvent,
  roeEventPayrollIdentity,
} from "./canada/roe-event-source.ts";
import type { RoePriorPeriod } from "./roe-history.ts";
import { roeQualifiedLineAllocations, type RoeRetainedLine } from "./roe-line-allocation.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp } from "../money/money.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { at, iso, DAY } from "./run-calendar.ts";
import { PayrollError } from "./error.ts";
import { retainedPayPeriodProblem } from "./retained-period-calendar.ts";
import { requirePayrollFeature } from "./feature-gate.ts";

export const ROE_REPORTING_COUNTS: Record<string, { hours: number; earnings: number }> = {
  weekly: { hours: 53, earnings: 27 },
  biweekly: { hours: 27, earnings: 14 },
  semi_monthly: { hours: 25, earnings: 13 },
  monthly: { hours: 13, earnings: 7 },
};
export type RoeReportingPeriod = {
  payDate: string | null;
  periodStart: string;
  periodEnd: string;
  insurableEarnings: string;
  insurableHours: string;
};
export type RoeWindowContext = {
  orgId: string;
  employeeId: string;
  name: string;
  employmentId: string;
  subsidiaryId: string;
  scheduleId: string;
  frequency: string;
  filingAccountId: string | null;
  event: {
    id: string;
    employment_id: string;
    subsidiary_id: string;
    first_day_worked: string;
    interruption_on: string;
    last_insurable_earnings_on: string;
    salary_continuance_end_on: string | null;
    source_reference: string;
  };
};
export type RoeCalendarPeriod = {
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
  historicalEvidenceId?: string;
  documentId: string | null;
  runType: "regular" | "termination" | "historical";
  explicitlyExcluded: boolean;
};
export type RoeWindowStub = {
  id: string;
  documentId: string;
  subsidiaryId: string | null;
  employmentId: string | null;
  filingAccountId: string | null;
  currency: string;
  hoursBasisQualified: boolean;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  insurableEarnings: string;
  insurableHours: string;
  earnedFrom: string | null;
  earnedTo: string | null;
  earnedDatesComplete: boolean;
  allocationKey?: string;
  reportPeriodStart?: string;
  reportPeriodEnd?: string;
  reportingEvidenceIds?: string[];
  separationEventId?: string;
};

/** The employer's confirmed employment spell is the boundary for every ROE read. */
export async function roeWindowContext(
  orgId: string,
  employeeId: string,
  eventId?: string | null,
): Promise<RoeWindowContext> {
  await requirePayrollFeature(db, orgId);
  const event = await selectRoeEvent(orgId, employeeId, eventId);
  const subject = await db.execute<{ name: string }>(
    sql`select p.display_name as name from parties p
   join worker_employments e on e.org_id=p.org_id and e.worker_party_id=p.id and e.id=${event.employmentId}
   where p.org_id=${orgId} and p.id=${employeeId} and e.employer_subsidiary_id=${event.subsidiaryId}`,
    "objects",
  );
  if (subject.length !== 1)
    throw new PayrollError(
      "The selected separation event does not belong to this native employee and employer",
    );
  const name = subject[0]!.name;
  if (
    !["confirmed", "issued"].includes(event.status) ||
    !event.firstDayWorked ||
    !event.sourceReference?.trim()
  )
    throw new PayrollError(
      `${name} has no confirmed original employment-spell and separation facts for this event`,
    );
  const dates = [
    event.firstDayWorked,
    event.lastInsurableEarningsOn,
    event.interruptionOn,
    ...(event.salaryContinuanceEndOn ? [event.salaryContinuanceEndOn] : []),
  ];
  if (!dates.every(isIsoCalendarDate) || event.firstDayWorked > event.lastInsurableEarningsOn)
    throw new PayrollError("The selected event has incomplete or invalid original earned dates");
  const identity = await roeEventPayrollIdentity(orgId, event);
  if (!ROE_REPORTING_COUNTS[identity.frequency])
    throw new PayrollError(
      "The selected event needs a supported source-qualified ROE pay-period type",
    );
  return {
    orgId,
    employeeId,
    name,
    employmentId: event.employmentId,
    subsidiaryId: event.subsidiaryId,
    scheduleId: identity.scheduleId,
    frequency: identity.frequency,
    filingAccountId: identity.filingAccountId,
    event: {
      id: event.id,
      employment_id: event.employmentId,
      subsidiary_id: event.subsidiaryId,
      first_day_worked: event.firstDayWorked,
      interruption_on: event.interruptionOn,
      last_insurable_earnings_on: event.lastInsurableEarningsOn,
      salary_continuance_end_on: event.salaryContinuanceEndOn,
      source_reference: event.sourceReference,
    },
  };
}

export function assembleRoeReportingWindow(
  context: RoeWindowContext,
  calendar: readonly RoeCalendarPeriod[],
  stubs: readonly RoeWindowStub[],
  historicalPeriods: readonly RoePriorPeriod[] = [],
): {
  periods: RoeReportingPeriod[];
  totalInsurableEarnings: string;
  totalInsurableHours: string;
  sourceDocuments: RoeWindowStub[];
  calendarDocuments: string[];
  historicalPeriods: RoePriorPeriod[];
} {
  const counts = ROE_REPORTING_COUNTS[context.frequency];
  if (!counts) throw new PayrollError("Unsupported ROE reporting frequency");
  const cutoff =
    context.event.salary_continuance_end_on ?? context.event.last_insurable_earnings_on;
  const final = calendar.filter((p) => p.periodStart <= cutoff && p.periodEnd >= cutoff);
  const distinctFinal = new Set(final.map((p) => p.periodStart + ":" + p.periodEnd));
  if (distinctFinal.size !== 1)
    throw new PayrollError(
      `${context.name} needs one unambiguous committed scheduled pay period containing the last day for which paid ${cutoff}`,
    );
  const finalEnd = final[0]!.periodEnd;
  const unique = new Map<string, RoeCalendarPeriod>();
  for (const p of calendar) {
    if (
      !isIsoCalendarDate(p.periodStart) ||
      !isIsoCalendarDate(p.periodEnd) ||
      p.periodStart > p.periodEnd
    )
      throw new PayrollError("Invalid retained ROE service-period dates");
    const periodProblem = retainedPayPeriodProblem(context.frequency, p.periodStart, p.periodEnd);
    if (periodProblem) throw new PayrollError(periodProblem);
    if (p.periodEnd > finalEnd || p.periodEnd < context.event.first_day_worked) continue;
    const key = p.periodStart + ":" + p.periodEnd;
    const prior = unique.get(key);
    if (prior) {
      if (prior.runType === "historical" || p.runType === "historical")
        throw new PayrollError(
          "Imported reporting evidence overlaps native payroll — preserve the sources and reconcile the duplicate period before filing",
        );
      if (prior.runType === p.runType)
        throw new PayrollError(
          "Multiple committed runs of the same type describe the same ROE service period — reconcile their native calendar identity",
        );
      // A final-pay run may share the scheduled period of the regular run.
      // It contributes earnings without occupying another reporting position.
      if (p.runType === "regular") unique.set(key, p);
    } else unique.set(key, p);
  }
  const selected = [...unique.values()]
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, counts.hours);
  if (!selected.length)
    throw new PayrollError("No retained ROE service periods cover this employment spell");
  for (let i = 1; i < selected.length; i++) {
    if (iso(new Date(at(selected[i]!.periodEnd).getTime() + DAY)) !== selected[i - 1]!.periodStart)
      throw new PayrollError(
        `${context.name} has a gap or overlap in committed ROE service-period coverage — qualify the missing period, including any nil period, before filing`,
      );
  }
  if (
    selected.length < counts.hours &&
    selected.at(-1)!.periodStart > context.event.first_day_worked
  )
    throw new PayrollError(
      `${context.name} lacks the earlier committed payroll coverage required for the ROE employment spell — import the original period evidence before filing`,
    );
  const imported = historicalPeriods.filter((p) =>
    selected.some((period) => period.historicalEvidenceId === p.id),
  );
  const buckets = selected.map((p) => {
    const prior = imported.find((prior) => prior.id === p.historicalEvidenceId);
    if (p.historicalEvidenceId && !prior)
      throw new PayrollError(
        "Historical reporting calendar identity has no qualified original period evidence",
      );
    if (
      prior &&
      (prior.employmentId !== context.employmentId ||
        prior.subsidiaryId !== context.subsidiaryId ||
        prior.frequency !== context.frequency ||
        prior.payScheduleId !== context.scheduleId ||
        prior.periodStart !== p.periodStart ||
        prior.periodEnd !== p.periodEnd ||
        prior.payDate !== p.payDate ||
        prior.nilPeriod !== p.explicitlyExcluded ||
        (prior.earnedFrom !== null && prior.earnedFrom < context.event.first_day_worked) ||
        (prior.earnedTo !== null && prior.earnedTo > cutoff))
    )
      throw new PayrollError(
        "Historical reporting evidence conflicts with the confirmed employment spell or earned cutoff",
      );
    // A scheduled run date is not evidence that this employee received pay.
    // Native periods acquire the actual date from their retained paid stubs.
    return {
      ...p,
      payDate: prior?.payDate ?? null,
      insurableEarnings: prior?.insurableEarnings ?? "0",
      insurableHours: prior?.insurableHours ?? "0",
      stubs: [] as RoeWindowStub[],
    };
  });
  const included: RoeWindowStub[] = [];
  const seenStubs = new Set<string>();
  const first = buckets.at(-1)!.periodStart;
  for (const stub of stubs) {
    const allocationId = stub.id + ":" + (stub.allocationKey ?? "whole");
    if (seenStubs.has(allocationId))
      throw new PayrollError("Duplicate retained ROE stub allocation evidence");
    seenStubs.add(allocationId);
    const earnedFrom = stub.earnedDatesComplete ? stub.earnedFrom : stub.periodStart;
    const earnedTo = stub.earnedDatesComplete ? stub.earnedTo : stub.periodEnd;
    if (stub.separationEventId !== undefined) {
      if (
        stub.separationEventId !== context.event.id ||
        stub.reportPeriodStart !== buckets[0]!.periodStart ||
        stub.reportPeriodEnd !== buckets[0]!.periodEnd ||
        cmp(stub.insurableHours, "0") !== 0 ||
        cmp(stub.insurableEarnings, "0") <= 0 ||
        !stub.reportingEvidenceIds?.length
      )
        throw new PayrollError(
          "Separation cash needs its exact selected event and source-qualified final reporting allocation",
        );
    } else {
      if (
        !earnedFrom ||
        !earnedTo ||
        !isIsoCalendarDate(earnedFrom) ||
        !isIsoCalendarDate(earnedTo) ||
        earnedFrom > earnedTo
      )
        throw new PayrollError("ROE earning-source dates are incomplete or invalid");
      if ((stub.reportPeriodEnd ?? earnedTo) < first) continue;
      if (stub.earnedDatesComplete && earnedFrom < context.event.first_day_worked)
        throw new PayrollError(
          `${context.name} has retained earnings before the confirmed first day worked — reconcile the employment-spell source before filing`,
        );
      if (earnedTo > cutoff && earnedFrom <= finalEnd)
        throw new PayrollError(
          `${context.name} has earning evidence after the confirmed insurable or continuance cutoff — qualify the original service allocation before filing`,
        );
      if (earnedFrom > finalEnd)
        throw new PayrollError(
          `${context.name} has a later payment without qualified ROE service-period or separation-payment allocation`,
        );
    }
    if (stub.employmentId !== context.employmentId || stub.subsidiaryId !== context.subsidiaryId)
      throw new PayrollError(
        `${context.name} has unknown or conflicting retained payroll employment or legal-employer attribution`,
      );
    assertRoeReportingCurrency(stub.currency, context.name);
    if (!stub.hoursBasisQualified)
      throw new PayrollError(
        `${context.name} needs retained insurable-hour attribution for mixed, undated salary or correcting earnings before filing the ROE`,
      );
    const matching = buckets.filter((p) =>
      stub.reportPeriodStart !== undefined
        ? p.periodStart === stub.reportPeriodStart && p.periodEnd === stub.reportPeriodEnd
        : earnedFrom !== null &&
          earnedTo !== null &&
          earnedFrom >= p.periodStart &&
          earnedTo <= p.periodEnd,
    );
    if (matching.length !== 1)
      throw new PayrollError(
        `${context.name} has an earning run spanning multiple ROE service periods — qualify its insurable allocation before filing`,
      );
    const bucket = matching[0]!;
    bucket.insurableEarnings = add(bucket.insurableEarnings, stub.insurableEarnings);
    bucket.insurableHours = add(bucket.insurableHours, stub.insurableHours);
    if (bucket.payDate === null || stub.payDate > bucket.payDate) bucket.payDate = stub.payDate;
    bucket.stubs.push(stub);
    included.push(stub);
  }
  for (const p of buckets) {
    if (!p.stubs.length && !p.explicitlyExcluded && !p.historicalEvidenceId)
      throw new PayrollError(
        `${context.name} has no retained pay or explicit no-pay scope for ${p.periodEnd} — qualify the nil period before filing`,
      );
    if (cmp(p.insurableEarnings, "0") < 0 || cmp(p.insurableHours, "0") < 0)
      throw new PayrollError(
        `${context.name} has a negative net ROE period requiring a governed source correction`,
      );
  }
  const periods = buckets.map(
    ({ payDate, periodStart, periodEnd, insurableEarnings, insurableHours }) => ({
      payDate,
      periodStart,
      periodEnd,
      insurableEarnings,
      insurableHours,
    }),
  );
  return {
    periods,
    totalInsurableHours: periods.reduce((n, p) => add(n, p.insurableHours), "0"),
    totalInsurableEarnings: periods
      .slice(0, counts.earnings)
      .reduce((n, p) => add(n, p.insurableEarnings), "0"),
    sourceDocuments: [...new Map(included.map((stub) => [stub.id, stub])).values()],
    historicalPeriods: imported,
    calendarDocuments: calendar
      .filter((p) =>
        selected.some(
          (selected) =>
            selected.periodStart === p.periodStart && selected.periodEnd === p.periodEnd,
        ),
      )
      .map((p) => p.documentId)
      .filter((id): id is string => id !== null),
  };
}

export async function readRoeReportingWindow(context: RoeWindowContext) {
  const cutoff =
    context.event.salary_continuance_end_on ?? context.event.last_insurable_earnings_on;
  const counts = ROE_REPORTING_COUNTS[context.frequency];
  if (!counts) throw new PayrollError("Unsupported ROE reporting frequency");
  const limit = counts.hours;
  const nativeCalendar = await db.execute<RoeCalendarPeriod>(
    sql`
    select run.period_start::text as "periodStart",run.period_end::text as "periodEnd",run.pay_date::text as "payDate",
           run.document_id as "documentId",run.run_type as "runType",exists(select 1 from pay_run_adjustments adjustment
             where adjustment.org_id=run.org_id and adjustment.pay_run_document_id=run.document_id
               and adjustment.employee_party_id=${context.employeeId} and adjustment.adjustment_type='exclude') as "explicitlyExcluded"
      from pay_runs run join documents document on document.org_id=run.org_id and document.id=run.document_id
     where run.org_id=${context.orgId} and run.pay_schedule_id=${context.scheduleId}
       and document.subsidiary_id=${context.subsidiaryId} and run.run_status='committed'
       and (run.run_type='regular' or (run.run_type='termination' and exists(
         select 1 from pay_stubs final_stub where final_stub.org_id=run.org_id
           and final_stub.pay_run_document_id=run.document_id and final_stub.employee_party_id=${context.employeeId})))
       and run.period_start<=${cutoff}::date and run.period_end>=${context.event.first_day_worked}::date
     order by run.period_end desc,run.document_id desc limit ${(limit + 1) * 2}`,
    "objects",
  );
  const historicalPeriods = await db.execute<RoePriorPeriod>(
    sql`
    select id,employment_id as "employmentId",subsidiary_id as "subsidiaryId",filing_account_id as "filingAccountId",
      pay_schedule_id as "payScheduleId",frequency,period_start::text as "periodStart",period_end::text as "periodEnd",pay_date::text as "payDate",
      earned_from::text as "earnedFrom",earned_to::text as "earnedTo",insurable_earnings::text as "insurableEarnings",insurable_hours::text as "insurableHours",
      nil_period as "nilPeriod",source_file_id as "sourceFileId",source_version_id as "sourceVersionId",source_sha256 as "sourceSha256",
      source_reference as "sourceReference",insurance_reference as "insuranceReference",hours_reference as "hoursReference",change_reason as reason,updated_at::text as "updatedAt"
    from payroll_roe_historical_periods where org_id=${context.orgId} and employee_party_id=${context.employeeId}
      and employment_id=${context.employmentId} and subsidiary_id=${context.subsidiaryId}
      and period_start<=${cutoff}::date and period_end>=${context.event.first_day_worked}::date
    order by period_end desc,id limit ${limit + 1}`,
    "objects",
  );
  const calendar: RoeCalendarPeriod[] = [
    ...nativeCalendar,
    ...historicalPeriods.map((p) => ({
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      payDate: p.payDate,
      documentId: null,
      runType: "historical" as const,
      historicalEvidenceId: p.id,
      explicitlyExcluded: p.nilPeriod,
    })),
  ];
  if (!calendar.length)
    throw new PayrollError(
      `${context.name} has no committed scheduled period for the ROE reporting window`,
    );
  const final = calendar.filter((p) => p.periodStart <= cutoff && p.periodEnd >= cutoff);
  if (!final.length)
    throw new PayrollError(
      `${context.name} has no committed scheduled period containing ${cutoff}`,
    );
  const intervals = [
    ...new Map(calendar.map((p) => [p.periodStart + ":" + p.periodEnd, p])).values(),
  ]
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, limit);
  const from = intervals.at(-1)!.periodStart;
  // For nonnegative earnings, equality of the retained gross and insurable
  // bases proves every positive earning is insurable. Mixed bases and earning
  // lines without retained hours cannot establish historical insurable hours from this
  // proof; current component settings cannot reinterpret committed history.
  const candidates = await db.execute<
    RoeWindowStub & { excludedLaterService: Record<string, unknown> | null }
  >(
    sql`
    select public.payroll_roe_later_stub_source(${context.orgId}::uuid,${context.event.id}::uuid,stub.id) as "excludedLaterService",
           stub.id,stub.pay_run_document_id as "documentId",document.subsidiary_id as "subsidiaryId",
           stub.employment_id as "employmentId",stub.filing_account_id as "filingAccountId",stub.currency_code as currency,
           (stub.gross=stub.insurable_earnings and not exists(
             select 1 from pay_stub_lines evidence
              where evidence.org_id=stub.org_id and evidence.stub_id=stub.id and evidence.kind='earning'
                and (evidence.amount<0 or (evidence.amount=0 and evidence.hours<>0)
                  or (evidence.amount<>0 and evidence.hours is null))
           )) as "hoursBasisQualified",
           run.period_start::text as "periodStart",run.period_end::text as "periodEnd",stub.pay_date::text as "payDate",
           stub.insurable_earnings::text as "insurableEarnings",
           (select min(line.earned_from)::text from pay_stub_lines line where line.org_id=stub.org_id and line.stub_id=stub.id
             and line.kind='earning' and (line.amount<>0 or line.hours<>0)) as "earnedFrom",
           (select max(line.earned_to)::text from pay_stub_lines line where line.org_id=stub.org_id and line.stub_id=stub.id
             and line.kind='earning' and (line.amount<>0 or line.hours<>0)) as "earnedTo",
           (exists(select 1 from pay_stub_lines line where line.org_id=stub.org_id and line.stub_id=stub.id
              and line.kind='earning' and (line.amount<>0 or line.hours<>0))
            and not exists(select 1 from pay_stub_lines line where line.org_id=stub.org_id and line.stub_id=stub.id
              and line.kind='earning' and (line.amount<>0 or line.hours<>0)
              and (line.earned_from is null or line.earned_to is null or line.earned_from>line.earned_to))) as "earnedDatesComplete",
           (select coalesce(sum(line.hours),0)::text from pay_stub_lines line
             where line.org_id=stub.org_id and line.stub_id=stub.id and line.kind='earning') as "insurableHours"
      from pay_stubs stub join pay_runs run on run.org_id=stub.org_id and run.document_id=stub.pay_run_document_id
      join documents document on document.org_id=stub.org_id and document.id=run.document_id
     where stub.org_id=${context.orgId} and stub.employee_party_id=${context.employeeId} and run.run_status='committed'
       and (run.period_end>=${from}::date and run.period_start<=${final[0]!.periodEnd}::date
         or exists(select 1 from pay_stub_lines line where line.org_id=stub.org_id and line.stub_id=stub.id
             and line.kind='earning' and line.earned_from<=${cutoff}::date and line.earned_to>=${from}::date)
         or exists(select 1 from pay_stub_lines line join payroll_roe_line_evidence qualified
             on qualified.org_id=line.org_id and qualified.pay_stub_line_id=line.id
             where line.org_id=stub.org_id and line.stub_id=stub.id and line.kind='earning'
               and qualified.report_period_start<=${final[0]!.periodEnd}::date and qualified.report_period_end>=${from}::date)
         or (run.period_start>${final[0]!.periodEnd}::date and stub.insurable_earnings<>0))
       and (stub.employment_id=${context.employmentId} or stub.employment_id is null)
     order by run.period_end desc,stub.id limit 5001`,
    "objects",
  );
  if (candidates.length > 5000)
    throw new PayrollError("ROE reporting source exceeds the bounded retained-stub window");
  const excludedLaterStubIds = candidates
    .filter((stub) => stub.excludedLaterService !== null)
    .map((stub) => stub.id);
  const stubs = candidates.filter((stub) => stub.excludedLaterService === null);
  const lineRows = stubs.length
    ? await db.execute<RoeRetainedLine>(
        sql`
    select l.id as "lineId",l.stub_id as "stubId",l.amount::text as amount,l.hours::text as hours,
      e.id as "evidenceId",(e.line_snapshot=public.payroll_roe_reporting_line_snapshot(l.id,l.org_id)) as "snapshotMatches",
      e.is_insurable as "isInsurable",e.insurable_hours::text as "insurableHours",
      e.report_period_start::text as "reportPeriodStart",e.report_period_end::text as "reportPeriodEnd",
      e.reporting_basis as "reportingBasis",e.separation_event_id as "separationEventId",
      (e.separation_basis_snapshot=public.payroll_roe_separation_reporting_basis(e.org_id,e.separation_event_id,l.id,e.separation_payment_id,e.report_period_start,e.report_period_end)) as "separationBasisMatches",
      e.earned_from::text as "earnedFrom",e.earned_to::text as "earnedTo"
    from pay_stub_lines l left join payroll_roe_line_evidence e on e.org_id=l.org_id and e.pay_stub_line_id=l.id
    where l.org_id=${context.orgId} and l.stub_id=any(${`{${stubs.map((stub) => stub.id).join(",")}}`}::uuid[])
      and l.kind='earning' and (l.amount<>0 or l.hours<>0) order by l.stub_id,l.id limit 50001`,
        "objects",
      )
    : [];
  if (lineRows.length > 50000)
    throw new PayrollError("ROE line attribution exceeds the bounded retained-source window");
  const allocated = stubs.flatMap((stub) =>
    roeQualifiedLineAllocations(
      stub,
      lineRows.filter((line) => line.stubId === stub.id),
    ),
  );
  return {
    ...assembleRoeReportingWindow(context, calendar, allocated, historicalPeriods),
    excludedLaterStubIds,
  };
}
