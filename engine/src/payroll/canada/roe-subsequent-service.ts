import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { isUuid } from "../../platform/uuid.ts";
import { isIsoCalendarDate } from "../../platform/iso-date.ts";
import { PayrollError } from "../error.ts";
import { authorizeRoeReportingEmployee, type RoeEmployeeScope } from "../roe-separation-facts.ts";
import { takeEmployeeConfigurationFence } from "../fences.ts";
import { assertRoeLegacySourcesBound, selectRoeEvent } from "./roe-event-source.ts";

export type RoeSubsequentServiceInput = {
  precedingEventId: string;
  firstDayWorked: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  reason: string;
  expectedId: string | null;
  expectedUpdatedAt: string | null;
};
export type RoeSubsequentService = {
  id: string;
  precedingEventId: string;
  firstDayWorked: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  reason: string;
  updatedAt: string;
};
const columns = sql`id,preceding_event_id as "precedingEventId",first_day_worked::text as "firstDayWorked",
  source_file_id as "sourceFileId",source_version_id as "sourceVersionId",source_sha256 as "sourceSha256",
  source_reference as "sourceReference",change_reason as reason,updated_at::text as "updatedAt"`;

export function validateRoeSubsequentService(
  input: RoeSubsequentServiceInput,
): RoeSubsequentServiceInput {
  if (
    ![input.precedingEventId, input.sourceFileId, input.sourceVersionId].every(isUuid) ||
    !/^[a-f0-9]{64}$/.test(input.sourceSha256)
  )
    throw new PayrollError(
      "Choose the exact preceding event and retained source file version and hash",
    );
  if (!isIsoCalendarDate(input.firstDayWorked))
    throw new PayrollError(
      "Record the original first day worked after returning to service as a real calendar date",
    );
  if (
    (input.expectedId === null) !== (input.expectedUpdatedAt === null) ||
    (input.expectedId !== null && !isUuid(input.expectedId)) ||
    (input.expectedUpdatedAt !== null &&
      (typeof input.expectedUpdatedAt !== "string" || !input.expectedUpdatedAt))
  )
    throw new PayrollError("Reload the return-to-service evidence before saving");
  if (typeof input.sourceReference !== "string" || typeof input.reason !== "string")
    throw new PayrollError("Record the original return-to-work source and a reason");
  const sourceReference = input.sourceReference.trim(),
    reason = input.reason.trim();
  if (!sourceReference || sourceReference.length > 2000 || !reason || reason.length > 2000)
    throw new PayrollError(
      "Record the original return-to-work source and a reason, each within 2000 characters",
    );
  return { ...input, sourceReference, reason };
}

/** A return within the same employment does not reset its seniority or annual statutory history. */
export async function saveRoeSubsequentService(
  scope: RoeEmployeeScope,
  input: RoeSubsequentServiceInput,
): Promise<RoeSubsequentService> {
  const value = validateRoeSubsequentService(input);
  return withOrgTransaction(scope.orgId, async () => {
    await takeEmployeeConfigurationFence(db, scope.orgId, scope.employeePartyId);
    const event = await selectRoeEvent(scope.orgId, scope.employeePartyId, value.precedingEventId);
    if (
      (scope.eventId !== undefined && scope.eventId !== event.id) ||
      (scope.employmentId !== undefined && scope.employmentId !== event.employmentId) ||
      (scope.subsidiaryId !== undefined && scope.subsidiaryId !== event.subsidiaryId)
    )
      throw new PayrollError(
        "Choose the original event and its actual native employment and legal employer",
      );
    await authorizeRoeReportingEmployee(
      { ...scope, employmentId: event.employmentId, subsidiaryId: event.subsidiaryId },
      "payroll.run",
    );
    await assertRoeLegacySourcesBound(scope.orgId, scope.employeePartyId);
    if (
      event.status !== "confirmed" ||
      !event.firstDayWorked ||
      value.firstDayWorked <= event.interruptionOn ||
      value.firstDayWorked <= (event.salaryContinuanceEndOn ?? event.lastInsurableEarningsOn)
    )
      throw new PayrollError(
        "Confirm the earlier event and record a genuine later return to work; payment, observation and current hire dates cannot supply it",
      );
    const original =
      (
        await db.execute<RoeSubsequentService>(
          sql`select ${columns} from payroll_roe_subsequent_service_sources
      where org_id=${scope.orgId} and preceding_event_id=${event.id} for update`,
          "objects",
        )
      )[0] ?? null;
    if (
      original &&
      (value.expectedId === null || value.expectedId === original.id) &&
      original.firstDayWorked === value.firstDayWorked &&
      original.sourceFileId === value.sourceFileId &&
      original.sourceVersionId === value.sourceVersionId &&
      original.sourceSha256 === value.sourceSha256 &&
      original.sourceReference === value.sourceReference &&
      original.reason === value.reason
    )
      return original;
    if (
      (original?.id ?? null) !== value.expectedId ||
      (original?.updatedAt ?? null) !== value.expectedUpdatedAt
    )
      throw new PayrollError("Return-to-service evidence changed — reload it before saving");
    const source = await db.execute(
      sql`select v.id from files f join file_versions v on v.file_id=f.id
      where f.org_id=${scope.orgId} and f.id=${value.sourceFileId} and not f.is_inactive and v.id=${value.sourceVersionId}
        and v.content_hash=${value.sourceSha256} and v.created_by=${scope.actorId} for share of f,v`,
      "objects",
    );
    if (source.length !== 1)
      throw new PayrollError(
        "Choose the active original return-to-work source uploaded to File Cabinet by the importing operator, with its retained version and hash",
      );
    const rows = original
      ? await db.execute<RoeSubsequentService>(
          sql`update payroll_roe_subsequent_service_sources
      set first_day_worked=${value.firstDayWorked},source_file_id=${value.sourceFileId},source_version_id=${value.sourceVersionId},
        source_sha256=${value.sourceSha256},source_reference=${value.sourceReference},change_reason=${value.reason},
        updated_by=${scope.actorId},updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
      where org_id=${scope.orgId} and id=${original.id} and updated_at::text=${value.expectedUpdatedAt} returning ${columns}`,
          "objects",
        )
      : await db.execute<RoeSubsequentService>(
          sql`insert into payroll_roe_subsequent_service_sources
      (org_id,preceding_event_id,employee_party_id,employment_id,subsidiary_id,first_day_worked,
        source_file_id,source_version_id,source_sha256,source_reference,change_reason,created_by,updated_by)
      values(${scope.orgId},${event.id},${scope.employeePartyId},${event.employmentId},${event.subsidiaryId},${value.firstDayWorked},
        ${value.sourceFileId},${value.sourceVersionId},${value.sourceSha256},${value.sourceReference},${value.reason},${scope.actorId},${scope.actorId})
      returning ${columns}`,
          "objects",
        );
    if (rows.length !== 1)
      throw new PayrollError("The return-to-service source was not saved — reload and retry");
    const after = rows[0]!;
    const audit = await db.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${scope.orgId},'payroll_roe_subsequent_service_sources',${after.id},${original ? "update" : "insert"},
        ${JSON.stringify({ before: original, after, reason: value.reason })}::jsonb,${scope.actorId}) returning id`,
      "objects",
    );
    if (audit.length !== 1)
      throw new PayrollError(
        "The return-to-service source audit was not saved; nothing was changed",
      );
    return after;
  });
}
export async function readRoeSubsequentService(
  scope: RoeEmployeeScope,
  precedingEventId: string,
): Promise<RoeSubsequentService | null> {
  return withOrgTransaction(scope.orgId, async () => {
    const event = await selectRoeEvent(scope.orgId, scope.employeePartyId, precedingEventId);
    if (
      (scope.eventId !== undefined && scope.eventId !== event.id) ||
      (scope.employmentId !== undefined && scope.employmentId !== event.employmentId) ||
      (scope.subsidiaryId !== undefined && scope.subsidiaryId !== event.subsidiaryId)
    )
      throw new PayrollError(
        "Choose the original event and its actual native employment and legal employer",
      );
    await authorizeRoeReportingEmployee(
      { ...scope, employmentId: event.employmentId, subsidiaryId: event.subsidiaryId },
      "payroll.read",
    );
    return (
      (
        await db.execute<RoeSubsequentService>(
          sql`select ${columns} from payroll_roe_subsequent_service_sources
      where org_id=${scope.orgId} and preceding_event_id=${event.id}`,
          "objects",
        )
      )[0] ?? null
    );
  });
}

/** Resolve the selected Cabinet version without accepting a client-supplied file hash. */
export async function readRoeSubsequentServiceContext(
  scope: RoeEmployeeScope,
  precedingEventId: string,
  sourceFileId?: string,
) {
  if (!isUuid(precedingEventId) || (sourceFileId !== undefined && !isUuid(sourceFileId)))
    throw new PayrollError("Choose the original separation event and retained source file");
  return withOrgTransaction(scope.orgId, async () => {
    const record = await readRoeSubsequentService(scope, precedingEventId);
    const source = sourceFileId
      ? ((
          await db.execute<{ id: string; versionId: string; sha256: string; name: string }>(
            sql`
      select f.id,v.id as "versionId",v.content_hash as sha256,f.name from files f
      join file_versions v on v.file_id=f.id and v.id=f.current_version_id
      where f.org_id=${scope.orgId} and f.id=${sourceFileId} and not f.is_inactive
        and v.created_by=${scope.actorId}`,
            "objects",
          )
        )[0] ?? null)
      : null;
    if (sourceFileId && (!source || !/^[a-f0-9]{64}$/.test(source.sha256)))
      throw new PayrollError(
        "Select the original return-to-work file uploaded to Cabinet by the qualifying operator",
      );
    return { record, source };
  });
}
