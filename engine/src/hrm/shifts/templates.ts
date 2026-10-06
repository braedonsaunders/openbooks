import { isIsoCalendarDate } from "../../platform/civil-date.ts";
import { loadWorkSchedules, pickWorkSchedule } from "../../payroll/work-schedules.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../../organization/subsidiary-scope.ts";
import { attendancePolicy, shiftPattern, ShiftError, requireUuid, type AttendancePolicy, type ShiftPattern, type ShiftSlot } from "./policy.ts";
import { authorParty, creationReplay, db, expectedRevision, one, requestHash, scopedRow, shiftAuthority, shiftInteger, shiftText, shiftTransaction, sql, subsidiaryVisibleFilter, type ShiftActor } from "./store.ts";

export type ShiftTemplate = {
  readonly id: string; readonly subsidiaryId: string; readonly normalWorkScheduleId: string; readonly code: string; readonly version: number;
  readonly name: string; readonly description: string | null; readonly effectiveFrom: string; readonly effectiveTo: string | null;
  readonly pattern: ShiftPattern; readonly attendancePolicy: AttendancePolicy | null; readonly definitionHash: string;
  readonly status: "draft" | "approved" | "retired" | "cancelled"; readonly revision: number;
  readonly createdBy: string; readonly authorPartyId: string; readonly decidedBy: string | null;
}
export const TEMPLATE_COLUMNS = sql`id,subsidiary_id as "subsidiaryId",normal_work_schedule_id as "normalWorkScheduleId",code,version,name,description,
 effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",pattern,attendance_policy as "attendancePolicy",definition_hash as "definitionHash",status,revision,
 created_by as "createdBy",author_party_id as "authorPartyId",decided_by as "decidedBy"`;
export function shiftWindow(from: unknown, to: unknown): { effectiveFrom: string; effectiveTo: string | null } {
  if (!isIsoCalendarDate(from) || (to !== null && (!isIsoCalendarDate(to) || to <= from))) throw new ShiftError("The effective interval needs a real start and a later exclusive end, or an explicitly open end — review its calendar dates.");
  return { effectiveFrom: from, effectiveTo: to };
}
export async function listShiftTemplates(actor: ShiftActor): Promise<ShiftTemplate[]> {
  return shiftTransaction(actor, async () => {
    const scope = await shiftAuthority(actor, "hrm.shifts.read");
    return (await db.execute<ShiftTemplate>(sql`select ${TEMPLATE_COLUMNS} from hrm_shift_templates where org_id=${actor.orgId}
      ${subsidiaryVisibleFilter(sql`subsidiary_id`,scope)} order by code,version desc,id`)).rows;
  });
}
export async function getShiftTemplate(actor: ShiftActor & { templateId: string }): Promise<ShiftTemplate> {
  return shiftTransaction(actor, () => scopedRow<ShiftTemplate>(actor, "hrm_shift_templates", actor.templateId, TEMPLATE_COLUMNS, "hrm.shifts.read", false));
}
export async function createShiftTemplate(input: ShiftActor & {
  id: string; subsidiaryId: string; normalWorkScheduleId: string; code: string; version: number; name: string; description: string | null;
  effectiveFrom: string; effectiveTo: string | null; timeZone: string; slots: readonly ShiftSlot[]; attendancePolicy: AttendancePolicy | null; reason: string;
}): Promise<ShiftTemplate> {
  const id = requireUuid(input.id,"Request key"), subsidiaryId = requireUuid(input.subsidiaryId,"Employer"), normalWorkScheduleId = requireUuid(input.normalWorkScheduleId,"Normal work schedule");
  const definition = { subsidiaryId, normalWorkScheduleId, code: shiftText(input.code,"Definition code",64), version: shiftInteger(input.version,"Version",2147483647,1),
    name: shiftText(input.name,"Definition name",160), description: input.description === null ? null : shiftText(input.description,"Description"),
    ...shiftWindow(input.effectiveFrom,input.effectiveTo), attendancePolicy: input.attendancePolicy === null ? null : attendancePolicy(input.attendancePolicy), reason: shiftText(input.reason,"Reason") };
  const initialHash = requestHash({ ...definition, timeZone: input.timeZone, slots: input.slots });
  return shiftTransaction(input, async () => {
    const scope = await shiftAuthority(input,"hrm.shifts.manage",subsidiaryId);
    if (!(await db.execute(sql`select id from subsidiaries where org_id=${input.orgId} and id=${subsidiaryId} and is_active for share`)).rows.length) throw new ScopeNotFoundError();
    const replay = await creationReplay<ShiftTemplate>(input,"hrm_shift_templates",id,initialHash,TEMPLATE_COLUMNS);
    if (replay) return replay;
    // Lock the native cycle before its existing reader builds the frozen definition.
    if (!(await db.execute(sql`select id from work_schedules where org_id=${input.orgId} and id=${normalWorkScheduleId} and is_active for share`)).rows.length) throw new ScopeNotFoundError();
    const source = (await loadWorkSchedules(db,input.orgId,scope)).find(row => row.id === normalWorkScheduleId);
    if (!source) throw new ScopeNotFoundError();
    const schedule = pickWorkSchedule([source],{ employeePartyId: source.employeePartyId ?? "", jobTitle: source.jobTitle, tradeId: source.tradeId, departmentId: source.departmentId, subsidiaryId: source.subsidiaryId },source.effectiveFrom);
    if (!schedule) throw new ShiftError("The selected normal work schedule is unavailable — reactivate its native cycle or select another configured cycle.");
    const pattern = shiftPattern({ schedule,timeZone:input.timeZone,slots:input.slots });
    if (pattern.slots.some(slot => slot.qualificationTypeIds.length) && !await lockAndCheckOrgFeature(db,input.orgId,"hrmCertifications")) throw new ShiftError("Qualification requirements need Certifications and licenses — enable it on Company Settings → Features before selecting required types.");
    const frozenHash = requestHash({ ...definition, reason: undefined, pattern });
    return one((await db.execute<ShiftTemplate>(sql`insert into hrm_shift_templates
      (id,org_id,subsidiary_id,normal_work_schedule_id,code,version,name,description,effective_from,effective_to,pattern,attendance_policy,definition_hash,request_hash,author_party_id,reason,created_by,updated_by)
      values(${id},${input.orgId},${subsidiaryId},${normalWorkScheduleId},${definition.code},${definition.version},${definition.name},${definition.description},${definition.effectiveFrom},${definition.effectiveTo},
       ${JSON.stringify(pattern)}::jsonb,${definition.attendancePolicy === null ? null : JSON.stringify(definition.attendancePolicy)}::jsonb,${frozenHash},${initialHash},${await authorParty(input)},${definition.reason},${input.actorId},${input.actorId}) returning ${TEMPLATE_COLUMNS}`)).rows);
  });
}
export async function transitionShiftTemplate(input: ShiftActor & { templateId: string; expectedRevision: number; action: "approve" | "retire" | "cancel"; reason: string }): Promise<ShiftTemplate> {
  const reason = shiftText(input.reason,"Reason"), status = input.action === "approve" ? "approved" : input.action === "retire" ? "retired" : input.action === "cancel" ? "cancelled" : null;
  if (!status) throw new ShiftError("Choose approve, retire or cancel for the recurring definition.");
  return shiftTransaction(input,async () => {
    const row = await scopedRow<ShiftTemplate>(input,"hrm_shift_templates",input.templateId,TEMPLATE_COLUMNS,input.action === "approve" ? "hrm.shifts.approve" : "hrm.shifts.manage",true);
    if (row.revision === input.expectedRevision+1 && row.status === status && (await db.execute(sql`select id from hrm_shift_templates where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    expectedRevision(row,input.expectedRevision);
    if (row.status !== (input.action === "retire" ? "approved" : "draft")) throw new ShiftError("This definition cannot make that transition — reload it and choose an action for its current lifecycle state.");
    return one((await db.execute<ShiftTemplate>(sql`update hrm_shift_templates set status=${status},revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now(),
     decided_by=case when ${status === "approved"} then ${input.actorId}::uuid else decided_by end,decided_at=case when ${status === "approved"} then now() else decided_at end
     where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${TEMPLATE_COLUMNS}`)).rows);
  });
}
