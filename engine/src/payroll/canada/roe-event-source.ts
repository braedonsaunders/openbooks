import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { isUuid } from "../../platform/uuid.ts";
import { PayrollError } from "../error.ts";

export { parseRoeEventRow, roeEventRow, type RoeEventSelection } from "../roe-event-row.ts";
export type SelectedRoeEvent = {
  id: string;
  employeePartyId: string;
  employmentId: string;
  subsidiaryId: string;
  firstDayWorked: string | null;
  interruptionOn: string;
  lastInsurableEarningsOn: string;
  salaryContinuanceEndOn: string | null;
  sourceReference: string | null;
  status: string;
  updatedAt: string;
};

/** A retained historical event governs admission even after the current profile changes. */
export function roeProfileAdmission(
  country: string | null,
  hasRetainedEvent: boolean,
  employeeName: string,
): boolean {
  if (hasRetainedEvent || country === "CA") return true;
  if (country === null)
    throw new PayrollError(
      `${employeeName} has no payroll country on file — record the original Canadian employment and separation evidence before preparing an ROE`,
    );
  return false;
}
export const ROE_EVENT_COLUMNS = sql`id,employee_party_id as "employeePartyId",employment_id as "employmentId",subsidiary_id as "subsidiaryId",
 first_day_worked::text as "firstDayWorked",interruption_on::text as "interruptionOn",last_insurable_earnings_on::text as "lastInsurableEarningsOn",
 salary_continuance_end_on::text as "salaryContinuanceEndOn",source_reference as "sourceReference",status,updated_at::text as "updatedAt"`;
/** Bare historical row keys resolve only when there is exactly one retained event. */
export async function selectRoeEvent(
  orgId: string,
  employeePartyId: string,
  eventId?: string | null,
): Promise<SelectedRoeEvent> {
  if (!isUuid(orgId) || !isUuid(employeePartyId) || (eventId != null && !isUuid(eventId)))
    throw new PayrollError("Choose the native employee and separation event");
  const rows = await db.execute<SelectedRoeEvent>(
    sql`select ${ROE_EVENT_COLUMNS} from payroll_roe_separation_events
  where org_id=${orgId} and employee_party_id=${employeePartyId} and status in ('draft','confirmed','issued')
    ${eventId ? sql`and id=${eventId}` : sql``} order by interruption_on,id limit 2`,
    "objects",
  );
  if (!rows.length)
    throw new PayrollError(
      "This employee has no retained separation event — record the original employment-spell and separation facts",
    );
  if (rows.length !== 1)
    throw new PayrollError(
      "This employee has multiple separation events — select the exact event before reviewing or issuing its ROE",
    );
  const event = rows[0]!;
  if (!event.employmentId || !event.subsidiaryId)
    throw new PayrollError(
      "The selected separation event needs its native employment and legal employer",
    );
  return event;
}
export async function assertRoeLegacySourcesBound(
  orgId: string,
  employeePartyId: string,
  pendingSubmissionId?: string,
): Promise<void> {
  const rows = await db.execute(
    sql`select sl.id from payroll_filing_submission_slips sl
  join payroll_filing_submissions f on f.org_id=sl.org_id and f.id=sl.submission_id
  where sl.org_id=${orgId} and f.country='CA' and f.filing_key='roe'
   and (sl.row_id=${employeePartyId} or split_part(sl.row_id,'~',1)=${employeePartyId})
   ${pendingSubmissionId ? sql`and f.id<>${pendingSubmissionId}` : sql``}
   and not exists(select 1 from payroll_roe_issued_event_sources b where b.org_id=sl.org_id and b.issued_slip_id=sl.id) limit 1`,
    "objects",
  );
  if (rows.length)
    throw new PayrollError(
      "A retained issued ROE has no qualified separation-event source binding — preserve its artifact and resolve the original event evidence before recording further ROE sources",
    );
}
/** Historical Canadian account/schedule identity comes from the selected spell's retained sources. */
export async function roeEventPayrollIdentity(
  orgId: string,
  event: SelectedRoeEvent,
): Promise<{ scheduleId: string; frequency: string; filingAccountId: string }> {
  const cutoff = event.salaryContinuanceEndOn ?? event.lastInsurableEarningsOn;
  if (!event.firstDayWorked)
    throw new PayrollError("The selected event needs its original first day worked");
  const rows = await db.execute<{
    scheduleId: string | null;
    frequency: string | null;
    filingAccountId: string | null;
  }>(
    sql`
  with evidence as (
   select r.pay_schedule_id as schedule_id,s.filing_account_id from pay_stubs s
    join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${orgId} and s.employee_party_id=${event.employeePartyId} and s.employment_id=${event.employmentId}
      and d.subsidiary_id=${event.subsidiaryId} and s.currency_code='CAD' and r.run_status='committed'
      and r.period_start<=${cutoff}::date and r.period_end>=${event.firstDayWorked}::date
   union
   select p.pay_schedule_id,p.filing_account_id from payroll_roe_historical_periods p
    where p.org_id=${orgId} and p.employee_party_id=${event.employeePartyId} and p.employment_id=${event.employmentId}
      and p.subsidiary_id=${event.subsidiaryId} and p.period_start<=${cutoff}::date and p.period_end>=${event.firstDayWorked}::date
  )
  select distinct e.schedule_id as "scheduleId",sc.frequency,a.id as "filingAccountId" from evidence e
   left join pay_schedules sc on sc.org_id=${orgId} and sc.id=e.schedule_id
   left join payroll_filing_accounts a on a.org_id=${orgId} and a.id=e.filing_account_id
    and a.subsidiary_id=${event.subsidiaryId} and a.country='CA' and a.program_type='ca_rp'
  order by 1,2,3 limit 2`,
    "objects",
  );
  if (rows.length !== 1 || !rows[0]!.scheduleId || !rows[0]!.frequency || !rows[0]!.filingAccountId)
    throw new PayrollError(
      "The selected employment spell needs one qualified retained Canadian filing account and pay schedule — current-profile settings cannot replace missing or conflicting historical evidence",
    );
  return {
    scheduleId: rows[0]!.scheduleId!,
    frequency: rows[0]!.frequency!,
    filingAccountId: rows[0]!.filingAccountId!,
  };
}

/** Filing population and reporting use the same source-qualified later-service resolver. */
export function roeLaterSpellStubSql(
  orgId: string,
  employeeId: string,
  employmentId: string,
  eventId: string,
  cutoff: string,
) {
  return sql`(stub.employee_party_id=${employeeId} and stub.employment_id=${employmentId}
   and exists(select 1 from payroll_roe_separation_events selected where selected.org_id=${orgId}
     and selected.id=${eventId} and coalesce(selected.salary_continuance_end_on,selected.last_insurable_earnings_on)=${cutoff}::date)
   and public.payroll_roe_later_stub_source(${orgId}::uuid,${eventId}::uuid,stub.id) is not null)`;
}

export function assertRoeReportingCurrency(currency: string, name: string): void {
  if (currency !== "CAD")
    throw new PayrollError(
      `${name} needs a qualified Canadian-dollar statutory reporting basis for this ROE`,
    );
}
/** Admission uses the selected employment's retained Canadian account evidence. */
export function roeCanadianEmploymentEvidenceSql() {
  return sql`((prof.employment_id=employment.id and prof.country='CA' and p.subsidiary_id=employment.employer_subsidiary_id)
      or exists(select 1 from pay_stubs st join documents d on d.org_id=st.org_id and d.id=st.pay_run_document_id
        join pay_runs r on r.org_id=st.org_id and r.document_id=st.pay_run_document_id
        join payroll_filing_accounts a on a.org_id=st.org_id and a.id=st.filing_account_id
        where st.org_id=p.org_id and st.employee_party_id=p.id and st.employment_id=employment.id and st.currency_code='CAD'
          and d.subsidiary_id=employment.employer_subsidiary_id and r.run_status='committed'
          and a.subsidiary_id=employment.employer_subsidiary_id and a.country='CA' and a.program_type='ca_rp')
      or exists(select 1 from payroll_roe_historical_periods h where h.org_id=p.org_id and h.employee_party_id=p.id
        and h.employment_id=employment.id and h.subsidiary_id=employment.employer_subsidiary_id))`;
}
