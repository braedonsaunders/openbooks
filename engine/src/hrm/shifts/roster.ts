import { isIsoCalendarDate } from "../../platform/civil-date.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { attendancePolicy, recurringShiftOccurrences, shiftOccurrence, ShiftError, requireUuid, type AttendancePolicy, type ShiftOccurrence, type ShiftOccurrenceSelection, type ShiftSlot } from "./policy.ts";
import { TEMPLATE_COLUMNS, shiftWindow, type ShiftTemplate } from "./templates.ts";
import { authorParty, creationReplay, db, expectedRevision, one, requestHash, scopedRow, shiftAuthority, shiftEmployment, shiftText, shiftTransaction, sql, subsidiaryVisibleFilter, type ShiftActor } from "./store.ts";

export interface ShiftAssignment {
  readonly id: string; readonly subsidiaryId: string; readonly employmentId: string; readonly workerPartyId: string; readonly templateId: string;
  readonly effectiveFrom: string; readonly effectiveTo: string | null; readonly status: "draft" | "approved" | "ended" | "cancelled"; readonly revision: number;
  readonly createdBy: string; readonly authorPartyId: string; readonly decidedBy: string | null; readonly decidedAt: string | null;
}
export interface RosterShift extends Omit<ShiftOccurrence,"durationSeconds"> {
  readonly id: string; readonly subsidiaryId: string; readonly employmentId: string; readonly workerPartyId: string; readonly name: string;
  readonly templateId: string | null; readonly publicationId: string | null; readonly slotIndex: number | null; readonly supersedesId: string | null;
  readonly attendancePolicy: AttendancePolicy | null; readonly definitionHash: string; readonly status: "draft" | "published" | "closed" | "cancelled"; readonly revision: number;
  readonly createdBy: string; readonly authorPartyId: string; readonly decidedBy: string | null;
}
export const ASSIGNMENT_COLUMNS = sql`id,subsidiary_id as "subsidiaryId",employment_id as "employmentId",worker_party_id as "workerPartyId",template_id as "templateId",
 effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",status,revision,created_by as "createdBy",author_party_id as "authorPartyId",decided_by as "decidedBy",
 to_char(decided_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "decidedAt"`;
export const SHIFT_COLUMNS = sql`id,subsidiary_id as "subsidiaryId",employment_id as "employmentId",worker_party_id as "workerPartyId",name,template_id as "templateId",publication_id as "publicationId",slot_index as "slotIndex",supersedes_id as "supersedesId",
 time_zone as "timeZone",starts_on::text as "startsOn",ends_on::text as "endsOn",to_char(starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",to_char(ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt",
 planned_break_seconds as "plannedBreakSeconds",qualification_type_ids as "qualificationTypeIds",attendance_policy as "attendancePolicy",definition_hash as "definitionHash",status,revision,created_by as "createdBy",author_party_id as "authorPartyId",decided_by as "decidedBy"`;
export async function listShiftAssignments(actor: ShiftActor & { templateId?: string }): Promise<ShiftAssignment[]> {
  return shiftTransaction(actor,async () => {
    const scope = await shiftAuthority(actor,"hrm.shifts.read");
    if (actor.templateId) await scopedRow<ShiftTemplate>(actor,"hrm_shift_templates",actor.templateId,TEMPLATE_COLUMNS,"hrm.shifts.read",false);
    return (await db.execute<ShiftAssignment>(sql`select ${ASSIGNMENT_COLUMNS} from hrm_shift_assignments where org_id=${actor.orgId}
      ${actor.templateId ? sql`and template_id=${actor.templateId}` : sql``} ${subsidiaryVisibleFilter(sql`subsidiary_id`,scope)} order by effective_from desc,id`)).rows;
  });
}
export async function createShiftAssignment(input: ShiftActor & { id: string; templateId: string; employmentId: string; effectiveFrom: string; effectiveTo: string | null; reason: string }): Promise<ShiftAssignment> {
  const id = requireUuid(input.id,"Request key"), templateId = requireUuid(input.templateId,"Recurring definition");
  const definition = { templateId,employmentId:requireUuid(input.employmentId,"Employment"),...shiftWindow(input.effectiveFrom,input.effectiveTo),reason:shiftText(input.reason,"Reason") };
  const hash = requestHash(definition);
  return shiftTransaction(input,async () => {
    const subject = await shiftEmployment(input,definition.employmentId,"hrm.shifts.manage");
    const template = await scopedRow<ShiftTemplate>(input,"hrm_shift_templates",templateId,TEMPLATE_COLUMNS,"hrm.shifts.manage",false);
    if (subject.employerSubsidiaryId !== template.subsidiaryId) throw new ShiftError("The recurring definition belongs to another employer — select a definition for the native employment employer.");
    const replay = await creationReplay<ShiftAssignment>(input,"hrm_shift_assignments",id,hash,ASSIGNMENT_COLUMNS);
    if (replay) return replay;
    return one((await db.execute<ShiftAssignment>(sql`insert into hrm_shift_assignments
      (id,org_id,template_id,subsidiary_id,employment_id,worker_party_id,effective_from,effective_to,request_hash,author_party_id,reason,created_by,updated_by)
      values(${id},${input.orgId},${templateId},${subject.employerSubsidiaryId},${subject.id},${subject.workerPartyId},${definition.effectiveFrom},${definition.effectiveTo},${hash},${await authorParty(input)},${definition.reason},${input.actorId},${input.actorId}) returning ${ASSIGNMENT_COLUMNS}`)).rows);
  });
}
export async function transitionShiftAssignment(input: ShiftActor & { assignmentId: string; expectedRevision: number; action: "approve" | "end" | "cancel"; effectiveTo?: string; reason: string }): Promise<ShiftAssignment> {
  const reason = shiftText(input.reason,"Reason"), status = input.action === "approve" ? "approved" : input.action === "end" ? "ended" : input.action === "cancel" ? "cancelled" : null;
  if (!status) throw new ShiftError("Choose approve, end or cancel for the recurring assignment.");
  if (input.action === "end" && !isIsoCalendarDate(input.effectiveTo)) throw new ShiftError("Ending the assignment needs a real exclusive end date — choose the first date it will no longer publish shifts.");
  return shiftTransaction(input,async () => {
    const permission = input.action === "approve" ? "hrm.shifts.approve" : "hrm.shifts.manage";
    const row = await scopedRow<ShiftAssignment>(input,"hrm_shift_assignments",input.assignmentId,ASSIGNMENT_COLUMNS,permission,true);
    await shiftEmployment(input,row.employmentId,permission);
    if (row.revision === input.expectedRevision+1 && row.status === status && (input.action !== "end" || row.effectiveTo === input.effectiveTo)
      && (await db.execute(sql`select id from hrm_shift_assignments where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    expectedRevision(row,input.expectedRevision);
    return one((await db.execute<ShiftAssignment>(sql`update hrm_shift_assignments set status=${status},effective_to=${input.action === "end" ? input.effectiveTo! : row.effectiveTo},revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now(),
      decided_by=case when ${status === "approved"} then ${input.actorId}::uuid else decided_by end,decided_at=case when ${status === "approved"} then now() else decided_at end
      where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${ASSIGNMENT_COLUMNS}`)).rows);
  });
}
async function publicationShifts(actor: ShiftActor, id: string): Promise<RosterShift[]> {
  return (await db.execute<RosterShift>(sql`select ${SHIFT_COLUMNS} from hrm_shifts where org_id=${actor.orgId} and publication_id=${id} order by starts_at,slot_index,id`)).rows;
}
export async function publishShiftAssignment(input: ShiftActor & { id: string; assignmentId: string; expectedRevision: number; from: string; through: string; occurrences?: Readonly<Record<string,ShiftOccurrenceSelection>>; reason: string }): Promise<{ id: string; shifts: readonly RosterShift[] }> {
  const id = requireUuid(input.id,"Publication request key"), reason = shiftText(input.reason,"Reason");
  return shiftTransaction(input,async () => {
    const assignment = await scopedRow<ShiftAssignment>(input,"hrm_shift_assignments",input.assignmentId,ASSIGNMENT_COLUMNS,"hrm.shifts.manage",true);
    await shiftEmployment(input,assignment.employmentId,"hrm.shifts.manage");
    const template = await scopedRow<ShiftTemplate>(input,"hrm_shift_templates",assignment.templateId,TEMPLATE_COLUMNS,"hrm.shifts.manage",false);
    const selected = Object.fromEntries(Object.entries(input.occurrences ?? {}).map(([key,value]) => [key,{ startsAt:value.startsAt,endsAt:value.endsAt,omitReason:value.omitReason }]));
    const payload = { assignmentId:assignment.id,expectedRevision:input.expectedRevision,from:input.from,through:input.through,occurrences:selected,reason };
    const replay = await creationReplay<{ id: string }>(input,"hrm_shift_publications",id,requestHash(payload),sql`id`);
    if (replay) return { id:replay.id,shifts:await publicationShifts(input,replay.id) };
    expectedRevision(assignment,input.expectedRevision);
    if (assignment.status !== "approved" || template.status !== "approved") throw new ShiftError("The recurring assignment and definition must both be approved — review their lifecycle records before publication.");
    if (template.pattern.slots.some(slot => slot.qualificationTypeIds.length) && !await lockAndCheckOrgFeature(db,input.orgId,"hrmCertifications")) throw new ShiftError("Required qualifications are unavailable — enable Certifications and licenses on Company Settings → Features before publication.");
    const occurrences = recurringShiftOccurrences({ pattern:template.pattern,from:input.from,through:input.through,occurrences:selected });
    one((await db.execute(sql`insert into hrm_shift_publications
      (id,org_id,assignment_id,from_on,through_on,assignment_revision,definition_hash,occurrence_selections,request_hash,reason,created_by)
      values(${id},${input.orgId},${assignment.id},${input.from},${input.through},${assignment.revision},${template.definitionHash},${JSON.stringify(selected)}::jsonb,${requestHash(payload)},${reason},${input.actorId}) returning id`)).rows);
    for (const occurrence of occurrences) {
      one((await db.execute(sql`insert into hrm_shifts
       (org_id,subsidiary_id,employment_id,worker_party_id,template_id,publication_id,slot_index,name,time_zone,starts_on,ends_on,starts_at,ends_at,planned_break_seconds,qualification_type_ids,attendance_policy,definition_hash,status,request_hash,author_party_id,decided_by,decided_at,reason,created_by,updated_by)
       values(${input.orgId},${assignment.subsidiaryId},${assignment.employmentId},${assignment.workerPartyId},${template.id},${id},${occurrence.slotIndex},${template.name},${occurrence.timeZone},${occurrence.startsOn},${occurrence.endsOn},${occurrence.startsAt},${occurrence.endsAt},${occurrence.plannedBreakSeconds},${JSON.stringify(occurrence.qualificationTypeIds)}::jsonb,${template.attendancePolicy === null ? null : JSON.stringify(template.attendancePolicy)}::jsonb,${template.definitionHash},'published',${requestHash({ publicationId:id,occurrence })},${assignment.authorPartyId},${assignment.decidedBy},${assignment.decidedAt},${reason},${input.actorId},${input.actorId}) returning id`)).rows);
    }
    return { id,shifts:await publicationShifts(input,id) };
  });
}
export async function createIndividualShift(input: ShiftActor & { id: string; employmentId: string; name: string; onDate: string; timeZone: string; slot: ShiftSlot; startsAt?: string; endsAt?: string; attendancePolicy: AttendancePolicy | null; reason: string; supersedesId: string | null }): Promise<RosterShift> {
  const id = requireUuid(input.id,"Request key"), occurrence = shiftOccurrence({ onDate:input.onDate,timeZone:input.timeZone,slot:input.slot,startsAt:input.startsAt,endsAt:input.endsAt });
  const definition = { employmentId:requireUuid(input.employmentId,"Employment"),name:shiftText(input.name,"Shift name",160),occurrence,attendancePolicy:input.attendancePolicy === null ? null : attendancePolicy(input.attendancePolicy),reason:shiftText(input.reason,"Reason"),supersedesId:input.supersedesId === null ? null : requireUuid(input.supersedesId,"Previous shift") };
  return shiftTransaction(input,async () => {
    const subject = await shiftEmployment(input,definition.employmentId,"hrm.shifts.manage");
    const replay = await creationReplay<RosterShift>(input,"hrm_shifts",id,requestHash(definition),SHIFT_COLUMNS);
    if (replay) return replay;
    if (occurrence.qualificationTypeIds.length && !await lockAndCheckOrgFeature(db,input.orgId,"hrmCertifications")) throw new ShiftError("Required qualifications need Certifications and licenses — enable it on Company Settings → Features before selecting required types.");
    return one((await db.execute<RosterShift>(sql`insert into hrm_shifts
     (id,org_id,subsidiary_id,employment_id,worker_party_id,name,time_zone,starts_on,ends_on,starts_at,ends_at,planned_break_seconds,qualification_type_ids,attendance_policy,definition_hash,supersedes_id,request_hash,author_party_id,reason,created_by,updated_by)
     values(${id},${input.orgId},${subject.employerSubsidiaryId},${subject.id},${subject.workerPartyId},${definition.name},${occurrence.timeZone},${occurrence.startsOn},${occurrence.endsOn},${occurrence.startsAt},${occurrence.endsAt},${occurrence.plannedBreakSeconds},${JSON.stringify(occurrence.qualificationTypeIds)}::jsonb,${definition.attendancePolicy === null ? null : JSON.stringify(definition.attendancePolicy)}::jsonb,${requestHash({ occurrence,attendancePolicy:definition.attendancePolicy })},${definition.supersedesId},${requestHash(definition)},${await authorParty(input)},${definition.reason},${input.actorId},${input.actorId}) returning ${SHIFT_COLUMNS}`)).rows);
  });
}
export async function getRosterShift(actor: ShiftActor & { shiftId: string }): Promise<RosterShift> {
  return shiftTransaction(actor,() => scopedRow<RosterShift>(actor,"hrm_shifts",actor.shiftId,SHIFT_COLUMNS,"hrm.shifts.read",false));
}
export async function transitionRosterShift(input: ShiftActor & { shiftId: string; expectedRevision: number; action: "publish" | "cancel" | "close"; reason: string }): Promise<RosterShift> {
  const reason = shiftText(input.reason,"Reason"), status = input.action === "publish" ? "published" : input.action === "cancel" ? "cancelled" : input.action === "close" ? "closed" : null;
  if (!status) throw new ShiftError("Choose publish, close or cancel for the roster shift.");
  return shiftTransaction(input,async () => {
    if (input.action === "close" && !await lockAndCheckOrgFeature(db,input.orgId,"hrmShiftClosing")) throw new ShiftError("Formal shift closing is disabled — enable Formal shift closing on Company Settings → Features to use this action; published shifts do not require closing.");
    const permission = input.action === "publish" ? "hrm.shifts.approve" : "hrm.shifts.manage";
    const identity = await scopedRow<RosterShift>(input,"hrm_shifts",input.shiftId,SHIFT_COLUMNS,permission,"none");
    await shiftEmployment(input,identity.employmentId,permission);
    // Employment, devices and shift are fenced in the same order as source admission.
    await db.execute(sql`select d.id from hrm_attendance_devices d where d.org_id=${input.orgId} and exists(select 1 from hrm_attendance_identities i where i.org_id=d.org_id and i.device_id=d.id and i.employment_id=${identity.employmentId}) order by d.id for update`);
    const row = await scopedRow<RosterShift>(input,"hrm_shifts",input.shiftId,SHIFT_COLUMNS,permission,true);
    if (row.revision === input.expectedRevision+1 && row.status === status && (await db.execute(sql`select id from hrm_shifts where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    expectedRevision(row,input.expectedRevision);
    if (status === "published" && row.qualificationTypeIds.length && !await lockAndCheckOrgFeature(db,input.orgId,"hrmCertifications")) throw new ShiftError("Required qualifications are unavailable — enable Certifications and licenses on Company Settings → Features before publication.");
    return one((await db.execute<RosterShift>(sql`update hrm_shifts set status=${status},revision=revision+1,reason=${reason},updated_at=now(),updated_by=${input.actorId},
     decided_by=case when ${status === "published"} then ${input.actorId}::uuid else decided_by end,decided_at=case when ${status === "published"} then now() else decided_at end
     where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${SHIFT_COLUMNS}`)).rows);
  });
}
