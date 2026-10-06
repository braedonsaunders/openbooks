import { ScopeNotFoundError } from "../../organization/subsidiary-scope.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { loadOwnEmploymentIds } from "../authorization.ts";
import { requireShiftInstant, requireUuid, ShiftError } from "./policy.ts";
import { SHIFT_COLUMNS, type RosterShift } from "./roster.ts";
import { authorParty, creationReplay, db, expectedRevision, one, requestHash, scopedRow, shiftAuthority, shiftEmployment, shiftText, shiftTransaction, sql, subsidiaryVisibleFilter, type ShiftActor, type ShiftPermission } from "./store.ts";

export interface ShiftRequest {
  readonly id: string; readonly shiftId: string; readonly shiftRevision: number; readonly subsidiaryId: string;
  readonly employmentId: string; readonly workerPartyId: string; readonly kind: "release" | "change";
  readonly proposedStartsAt: string | null; readonly proposedEndsAt: string | null; readonly outcomeShiftId: string | null;
  readonly status: "pending" | "approved" | "declined" | "withdrawn"; readonly revision: number;
  readonly createdBy: string; readonly authorPartyId: string; readonly decidedBy: string | null;
}
const REQUEST_COLUMNS = sql`id,shift_id as "shiftId",shift_revision as "shiftRevision",subsidiary_id as "subsidiaryId",employment_id as "employmentId",worker_party_id as "workerPartyId",kind,
 to_char(proposed_starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "proposedStartsAt",to_char(proposed_ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "proposedEndsAt",
 outcome_shift_id as "outcomeShiftId",status,revision,created_by as "createdBy",author_party_id as "authorPartyId",decided_by as "decidedBy"`;
interface ShiftRequestInput extends ShiftActor {
  readonly id: string; readonly shiftId: string; readonly expectedShiftRevision: number; readonly kind: "release" | "change";
  readonly proposedStartsAt: string | null; readonly proposedEndsAt: string | null; readonly reason: string;
}
async function ownEmployment(input: ShiftActor, employmentId: string): Promise<void> {
  if (!(await loadOwnEmploymentIds(db,input.orgId,input.actorId)).includes(employmentId)) throw new ScopeNotFoundError();
}
async function createRequest(input: ShiftRequestInput, own: boolean): Promise<ShiftRequest> {
  const id = requireUuid(input.id,"Request key"), shiftId = requireUuid(input.shiftId,"Shift"), reason = shiftText(input.reason,"Request reason");
  if (input.kind !== "release" && input.kind !== "change") throw new ShiftError("Choose a release or a change request for this shift.");
  if (input.kind === "release" && (input.proposedStartsAt !== null || input.proposedEndsAt !== null)) throw new ShiftError("A release request has no replacement times — clear the proposed times or choose a change request.");
  if (input.kind === "change") {
    const start = requireShiftInstant(input.proposedStartsAt,"Proposed start"), end = requireShiftInstant(input.proposedEndsAt,"Proposed end");
    if (end <= start || end-start > 48*60*60*1000) throw new ShiftError("Replacement times must end after their start within 48 hours — review the exact proposed instants.");
  }
  const payload = { shiftId,expectedShiftRevision:input.expectedShiftRevision,kind:input.kind,proposedStartsAt:input.proposedStartsAt,proposedEndsAt:input.proposedEndsAt,reason }, hash = requestHash(payload);
  return shiftTransaction(input,async () => {
    const permission: ShiftPermission = own ? "hrm.self.request" : "hrm.shifts.manage";
    const identity = await scopedRow<RosterShift>(input,"hrm_shifts",shiftId,SHIFT_COLUMNS,permission,"none");
    if (own) await ownEmployment(input,identity.employmentId);
    await shiftEmployment(input,identity.employmentId,permission);
    const shift = await scopedRow<RosterShift>(input,"hrm_shifts",shiftId,SHIFT_COLUMNS,permission,true);
    const replay = await creationReplay<ShiftRequest>(input,"hrm_shift_requests",id,hash,REQUEST_COLUMNS);
    if (replay) return replay;
    expectedRevision(shift,input.expectedShiftRevision);
    if (shift.status !== "published") throw new ShiftError("This shift is unavailable for requests — reload and choose a currently published shift.");
    return one((await db.execute<ShiftRequest>(sql`insert into hrm_shift_requests
     (id,org_id,shift_id,shift_revision,subsidiary_id,employment_id,worker_party_id,kind,proposed_starts_at,proposed_ends_at,request_hash,author_party_id,reason,created_by,updated_by)
     values(${id},${input.orgId},${shift.id},${shift.revision},${shift.subsidiaryId},${shift.employmentId},${shift.workerPartyId},${input.kind},${input.proposedStartsAt},${input.proposedEndsAt},${hash},${await authorParty(input)},${reason},${input.actorId},${input.actorId}) returning ${REQUEST_COLUMNS}`)).rows);
  });
}
export function createShiftRequest(input: ShiftRequestInput): Promise<ShiftRequest> { return createRequest(input,false); }
export function createOwnShiftRequest(input: ShiftRequestInput): Promise<ShiftRequest> { return createRequest(input,true); }
export async function listShiftRequests(input: ShiftActor & { shiftId?: string }): Promise<ShiftRequest[]> {
  return shiftTransaction(input,async () => {
    const scope = await shiftAuthority(input,"hrm.shifts.read");
    if (input.shiftId) await scopedRow<RosterShift>(input,"hrm_shifts",input.shiftId,SHIFT_COLUMNS,"hrm.shifts.read",false);
    return (await db.execute<ShiftRequest>(sql`select ${REQUEST_COLUMNS} from hrm_shift_requests where org_id=${input.orgId}
     ${input.shiftId ? sql`and shift_id=${input.shiftId}` : sql``} ${subsidiaryVisibleFilter(sql`subsidiary_id`,scope)} order by created_at desc,id`)).rows;
  });
}
export async function listOwnShiftRequests(input: ShiftActor): Promise<ShiftRequest[]> {
  return shiftTransaction(input,async () => {
    const scope = await shiftAuthority(input,"hrm.self.read"), ids = await loadOwnEmploymentIds(db,input.orgId,input.actorId);
    if (!ids.length) return [];
    return (await db.execute<ShiftRequest>(sql`select ${REQUEST_COLUMNS} from hrm_shift_requests where org_id=${input.orgId}
     and employment_id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}) ${subsidiaryVisibleFilter(sql`subsidiary_id`,scope)} order by created_at desc,id`)).rows;
  });
}
export async function transitionShiftRequest(input: ShiftActor & { requestId: string; expectedRevision: number; action: "approve" | "decline" | "withdraw"; reason: string }): Promise<ShiftRequest> {
  const reason = shiftText(input.reason,"Decision reason"), status = input.action === "approve" ? "approved" : input.action === "decline" ? "declined" : input.action === "withdraw" ? "withdrawn" : null;
  if (!status) throw new ShiftError("Choose approve, decline or withdraw for the request.");
  return shiftTransaction(input,async () => {
    const permission: ShiftPermission = status === "withdrawn" ? "hrm.self.request" : "hrm.shifts.approve";
    const identity = await scopedRow<ShiftRequest>(input,"hrm_shift_requests",input.requestId,REQUEST_COLUMNS,permission,"none");
    if (status === "withdrawn" && identity.createdBy !== input.actorId) throw new ShiftError("Only the request author can withdraw it — ask its author or use an independent decline decision.");
    await shiftEmployment(input,identity.employmentId,permission);
    const shift = await scopedRow<RosterShift>(input,"hrm_shifts",identity.shiftId,SHIFT_COLUMNS,permission,true);
    const row = await scopedRow<ShiftRequest>(input,"hrm_shift_requests",identity.id,REQUEST_COLUMNS,permission,true);
    if (row.revision === input.expectedRevision+1 && row.status === status && (await db.execute(sql`select id from hrm_shift_requests where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    expectedRevision(row,input.expectedRevision);
    if (row.status !== "pending") throw new ShiftError("This request already has a decision — reload and preserve its original decision evidence.");
    let outcomeShiftId: string | null = null;
    if (status === "approved") {
      expectedRevision(shift,row.shiftRevision);
      if (shift.status !== "published") throw new ShiftError("The requested shift is no longer published — decline this stale request and review its current successor.");
      if (row.kind === "change" && shift.qualificationTypeIds.length && !await lockAndCheckOrgFeature(db,input.orgId,"hrmCertifications")) throw new ShiftError("Required qualifications are disabled — enable Certifications and licenses on Company Settings → Features before approving the replacement.");
      one((await db.execute(sql`update hrm_shifts set status='cancelled',revision=revision+1,reason=${reason},updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${shift.id} and revision=${row.shiftRevision} returning id`)).rows);
      if (row.kind === "change") {
        const definition = { supersedesId:shift.id,originRequestId:row.id,startsAt:row.proposedStartsAt,endsAt:row.proposedEndsAt,attendancePolicy:shift.attendancePolicy,qualificationTypeIds:shift.qualificationTypeIds,plannedBreakSeconds:shift.plannedBreakSeconds };
        outcomeShiftId = one((await db.execute<{ id: string }>(sql`insert into hrm_shifts
         (org_id,subsidiary_id,employment_id,worker_party_id,name,time_zone,starts_on,ends_on,starts_at,ends_at,planned_break_seconds,qualification_type_ids,attendance_policy,definition_hash,status,supersedes_id,origin_request_id,request_hash,author_party_id,decided_by,decided_at,reason,created_by,updated_by)
         values(${input.orgId},${shift.subsidiaryId},${shift.employmentId},${shift.workerPartyId},${shift.name},${shift.timeZone},(${row.proposedStartsAt}::timestamptz at time zone ${shift.timeZone})::date,(${row.proposedEndsAt}::timestamptz at time zone ${shift.timeZone})::date,${row.proposedStartsAt},${row.proposedEndsAt},${shift.plannedBreakSeconds},${JSON.stringify(shift.qualificationTypeIds)}::jsonb,${shift.attendancePolicy === null ? null : JSON.stringify(shift.attendancePolicy)}::jsonb,${requestHash(definition)},'published',${shift.id},${row.id},${requestHash({ definition,reason })},${row.authorPartyId},${input.actorId},now(),${reason},${input.actorId},${input.actorId}) returning id`)).rows).id;
      }
    }
    return one((await db.execute<ShiftRequest>(sql`update hrm_shift_requests set status=${status},outcome_shift_id=${outcomeShiftId},revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now(),
     decided_by=case when ${status !== "withdrawn"} then ${input.actorId}::uuid else null end,decided_at=case when ${status !== "withdrawn"} then now() else null end
     where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${REQUEST_COLUMNS}`)).rows);
  });
}
