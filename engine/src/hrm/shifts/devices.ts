import { canonicalTimeZone } from "../../platform/time-zone.ts";
import { ScopeNotFoundError } from "../../organization/subsidiary-scope.ts";
import { requireShiftInstant, requireUuid, ShiftError, type DeviceCheckIn } from "./policy.ts";
import { shiftWindow } from "./templates.ts";
import { creationReplay, db, expectedRevision, one, requestHash, scopedRow, shiftAuthority, shiftEmployment, shiftInteger, shiftText, shiftTransaction, sql, subsidiaryVisibleFilter, type ShiftActor } from "./store.ts";

export interface AttendanceDevice {
  readonly id: string; readonly subsidiaryId: string; readonly code: string; readonly name: string; readonly timeZone: string;
  readonly isActive: boolean; readonly revision: number;
}
export interface AttendanceIdentity {
  readonly id: string; readonly deviceId: string; readonly sourceWorkerId: string; readonly subsidiaryId: string;
  readonly employmentId: string; readonly workerPartyId: string; readonly effectiveFrom: string; readonly effectiveTo: string | null; readonly revision: number;
}
export interface AttendanceBatch { readonly id: string; readonly deviceId: string; readonly completeThrough: string | null; readonly eventCount: number }
export const DEVICE_COLUMNS = sql`id,subsidiary_id as "subsidiaryId",code,name,time_zone as "timeZone",is_active as "isActive",revision`;
const IDENTITY_COLUMNS = sql`id,device_id as "deviceId",source_worker_id as "sourceWorkerId",subsidiary_id as "subsidiaryId",employment_id as "employmentId",worker_party_id as "workerPartyId",effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",revision`;
const BATCH_COLUMNS = sql`id,device_id as "deviceId",to_char(complete_through at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "completeThrough",event_count as "eventCount"`;
export async function listAttendanceDevices(actor: ShiftActor): Promise<AttendanceDevice[]> {
  return shiftTransaction(actor,async () => {
    const scope = await shiftAuthority(actor,"hrm.attendance.read");
    return (await db.execute<AttendanceDevice>(sql`select ${DEVICE_COLUMNS} from hrm_attendance_devices where org_id=${actor.orgId} ${subsidiaryVisibleFilter(sql`subsidiary_id`,scope)} order by code,id`)).rows;
  });
}
export async function createAttendanceDevice(input: ShiftActor & { id: string; subsidiaryId: string; code: string; name: string; timeZone: string; reason: string }): Promise<AttendanceDevice> {
  const id = requireUuid(input.id,"Request key"), subsidiaryId = requireUuid(input.subsidiaryId,"Employer"), timeZone = canonicalTimeZone(input.timeZone);
  if (!timeZone || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(input.timeZone)) throw new ShiftError("Device time zone is unknown — choose its named source time zone before importing timestamps.");
  const definition = { subsidiaryId,code:shiftText(input.code,"Device code",64),name:shiftText(input.name,"Device name",160),timeZone,reason:shiftText(input.reason,"Reason") };
  return shiftTransaction(input,async () => {
    await shiftAuthority(input,"hrm.attendance.manage",subsidiaryId);
    if (!(await db.execute(sql`select id from subsidiaries where org_id=${input.orgId} and id=${subsidiaryId} and is_active for share`)).rows.length) throw new ScopeNotFoundError();
    const replay = await creationReplay<AttendanceDevice>(input,"hrm_attendance_devices",id,requestHash(definition),DEVICE_COLUMNS);
    if (replay) return replay;
    return one((await db.execute<AttendanceDevice>(sql`insert into hrm_attendance_devices(id,org_id,subsidiary_id,code,name,time_zone,request_hash,reason,created_by,updated_by)
     values(${id},${input.orgId},${subsidiaryId},${definition.code},${definition.name},${timeZone},${requestHash(definition)},${definition.reason},${input.actorId},${input.actorId}) returning ${DEVICE_COLUMNS}`)).rows);
  });
}
export async function updateAttendanceDevice(input: ShiftActor & { deviceId: string; expectedRevision: number; name: string; isActive: boolean; reason: string }): Promise<AttendanceDevice> {
  const name = shiftText(input.name,"Device name",160), reason = shiftText(input.reason,"Reason");
  if (typeof input.isActive !== "boolean") throw new ShiftError("Device availability must be explicitly enabled or disabled — review the selected state.");
  return shiftTransaction(input,async () => {
    const row = await scopedRow<AttendanceDevice>(input,"hrm_attendance_devices",input.deviceId,DEVICE_COLUMNS,"hrm.attendance.manage",true);
    if (row.name === name && row.isActive === input.isActive) {
      if (row.revision === input.expectedRevision) return row;
      if (row.revision === input.expectedRevision+1 && (await db.execute(sql`select id from hrm_attendance_devices where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    }
    expectedRevision(row,input.expectedRevision);
    return one((await db.execute<AttendanceDevice>(sql`update hrm_attendance_devices set name=${name},is_active=${input.isActive},revision=revision+1,reason=${reason},updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${DEVICE_COLUMNS}`)).rows);
  });
}
export async function createAttendanceIdentity(input: ShiftActor & { id: string; deviceId: string; sourceWorkerId: string; employmentId: string; effectiveFrom: string; effectiveTo: string | null; reason: string }): Promise<AttendanceIdentity> {
  const id = requireUuid(input.id,"Request key"), definition = { deviceId:requireUuid(input.deviceId,"Device"),sourceWorkerId:shiftText(input.sourceWorkerId,"Source worker identifier",160),employmentId:requireUuid(input.employmentId,"Employment"),...shiftWindow(input.effectiveFrom,input.effectiveTo),reason:shiftText(input.reason,"Reason") };
  return shiftTransaction(input,async () => {
    const subject = await shiftEmployment(input,definition.employmentId,"hrm.attendance.manage");
    const device = await scopedRow<AttendanceDevice>(input,"hrm_attendance_devices",definition.deviceId,DEVICE_COLUMNS,"hrm.attendance.manage",true);
    if (device.subsidiaryId !== subject.employerSubsidiaryId) throw new ShiftError("The device and native employment have different employers — select the device for this employment employer.");
    const replay = await creationReplay<AttendanceIdentity>(input,"hrm_attendance_identities",id,requestHash(definition),IDENTITY_COLUMNS);
    if (replay) return replay;
    return one((await db.execute<AttendanceIdentity>(sql`insert into hrm_attendance_identities
     (id,org_id,device_id,source_worker_id,subsidiary_id,employment_id,worker_party_id,effective_from,effective_to,request_hash,reason,created_by,updated_by)
     values(${id},${input.orgId},${device.id},${definition.sourceWorkerId},${subject.employerSubsidiaryId},${subject.id},${subject.workerPartyId},${definition.effectiveFrom},${definition.effectiveTo},${requestHash(definition)},${definition.reason},${input.actorId},${input.actorId}) returning ${IDENTITY_COLUMNS}`)).rows);
  });
}
export async function listAttendanceIdentities(input: ShiftActor & { deviceId: string }): Promise<AttendanceIdentity[]> {
  return shiftTransaction(input,async () => {
    const device = await scopedRow<AttendanceDevice>(input,"hrm_attendance_devices",input.deviceId,DEVICE_COLUMNS,"hrm.attendance.read",false);
    return (await db.execute<AttendanceIdentity>(sql`select ${IDENTITY_COLUMNS} from hrm_attendance_identities where org_id=${input.orgId} and device_id=${device.id} order by source_worker_id,effective_from,id`)).rows;
  });
}
export async function endAttendanceIdentity(input: ShiftActor & { identityId: string; expectedRevision: number; effectiveTo: string; reason: string }): Promise<AttendanceIdentity> {
  const reason = shiftText(input.reason,"Reason");
  return shiftTransaction(input,async () => {
    const identity = await scopedRow<AttendanceIdentity>(input,"hrm_attendance_identities",input.identityId,IDENTITY_COLUMNS,"hrm.attendance.manage","none");
    const window = shiftWindow(identity.effectiveFrom,input.effectiveTo);
    await shiftEmployment(input,identity.employmentId,"hrm.attendance.manage");
    await scopedRow<AttendanceDevice>(input,"hrm_attendance_devices",identity.deviceId,DEVICE_COLUMNS,"hrm.attendance.manage",true);
    const row = await scopedRow<AttendanceIdentity>(input,"hrm_attendance_identities",identity.id,IDENTITY_COLUMNS,"hrm.attendance.manage",true);
    if (row.revision === input.expectedRevision+1 && row.effectiveTo === window.effectiveTo && (await db.execute(sql`select id from hrm_attendance_identities where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    expectedRevision(row,input.expectedRevision);
    return one((await db.execute<AttendanceIdentity>(sql`update hrm_attendance_identities set effective_to=${window.effectiveTo},revision=revision+1,reason=${reason},updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${IDENTITY_COLUMNS}`)).rows);
  });
}

export interface SourceCheckIn {
  readonly id: string; readonly sourceEventId: string; readonly sourceVersion: number; readonly sourceWorkerId: string;
  readonly kind: DeviceCheckIn["kind"] | "void"; readonly occurredAt: string; readonly sourcePayload: Readonly<Record<string,unknown>>; readonly supersedesId: string | null;
}
function sourceCheckInHash(event: SourceCheckIn): string {
  const { id: _requestId, ...source } = event;
  return requestHash(source);
}
export async function admitAttendanceBatch(input: ShiftActor & { id: string; deviceId: string; completeThrough: string | null; sourceEvidence: Readonly<Record<string,unknown>>; events: readonly SourceCheckIn[]; reason: string }): Promise<AttendanceBatch> {
  const id = requireUuid(input.id,"Batch request key"), deviceId = requireUuid(input.deviceId,"Device"), reason = shiftText(input.reason,"Reason");
  if (input.completeThrough !== null) requireShiftInstant(input.completeThrough,"Source completeness watermark");
  if (!Array.isArray(input.events) || input.events.length>10000) throw new ShiftError("A device batch admits at most 10000 records — choose a smaller source window.");
  if (!input.sourceEvidence || typeof input.sourceEvidence !== "object" || Array.isArray(input.sourceEvidence) || typeof input.sourceEvidence.source !== "string" || !input.sourceEvidence.source.trim()) throw new ShiftError("Device synchronization needs actual source evidence — identify the source connection or import file before admission.");
  const events = input.events.map(event => {
    requireShiftInstant(event.occurredAt,"Source check-in time");
    if (!["clock_in","clock_out","break_start","break_end","void"].includes(event.kind)) throw new ShiftError("Source check-in kind is undeclared — select an actual clock event or a reasoned void correction.");
    if (!event.sourcePayload || typeof event.sourcePayload !== "object" || Array.isArray(event.sourcePayload)) throw new ShiftError("Source event payload is missing — retain its actual source fields before admission.");
    return { id:requireUuid(event.id,"Source event request key"),sourceEventId:shiftText(event.sourceEventId,"Source event identifier",160),sourceVersion:shiftInteger(event.sourceVersion,"Source version",2147483647,1),sourceWorkerId:shiftText(event.sourceWorkerId,"Source worker identifier",160),kind:event.kind,occurredAt:event.occurredAt,sourcePayload:event.sourcePayload,supersedesId:event.supersedesId === null ? null : requireUuid(event.supersedesId,"Previous source event") };
  }).sort((a,b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  if (new Set(events.map(event => event.id.toLowerCase())).size!==events.length || new Set(events.map(event => `${event.sourceEventId}:${event.sourceVersion}`)).size!==events.length) throw new ShiftError("A device batch repeats a source event identity or version — keep one exact record for each declared source version.");
  const definition = { deviceId,completeThrough:input.completeThrough,sourceEvidence:input.sourceEvidence,events,reason }, hash = requestHash(definition);
  return shiftTransaction(input,async () => {
    const device = await scopedRow<AttendanceDevice>(input,"hrm_attendance_devices",deviceId,DEVICE_COLUMNS,"hrm.attendance.manage","none");
    const replay = await creationReplay<AttendanceBatch>(input,"hrm_attendance_batches",id,hash,BATCH_COLUMNS);
    if (replay) return replay;
    const identities = [];
    for (const event of events) {
      const mappings = (await db.execute<AttendanceIdentity & { localDate: string }>(sql`select ${IDENTITY_COLUMNS},(${event.occurredAt}::timestamptz at time zone ${device.timeZone})::date::text as "localDate" from hrm_attendance_identities where org_id=${input.orgId} and device_id=${deviceId} and source_worker_id=${event.sourceWorkerId}
       and effective_from<=(${event.occurredAt}::timestamptz at time zone ${device.timeZone})::date and (effective_to is null or effective_to>(${event.occurredAt}::timestamptz at time zone ${device.timeZone})::date)`)).rows;
      if (mappings.length !== 1) throw new ShiftError(`Device worker ${event.sourceWorkerId} has no unique dated native employment mapping — configure its device identity for the source date before admission.`);
      const mapping = mappings[0]!;
      identities.push(mapping);
    }
    for (const employmentId of [...new Set(identities.map(mapping => mapping.employmentId))].sort()) await shiftEmployment(input,employmentId,"hrm.attendance.manage");
    await scopedRow<AttendanceDevice>(input,"hrm_attendance_devices",deviceId,DEVICE_COLUMNS,"hrm.attendance.manage",true);
    for (const mapping of [...identities].sort((a,b) => a.id.localeCompare(b.id))) {
      await scopedRow<AttendanceIdentity>(input,"hrm_attendance_identities",mapping.id,IDENTITY_COLUMNS,"hrm.attendance.manage",false);
    }
    const novel: number[] = [], replayedIds: string[] = [];
    for (const [index,event] of events.entries()) {
      const stored = (await db.execute<{ id: string; requestHash: string }>(sql`select id,request_hash as "requestHash" from hrm_attendance_events
       where org_id=${input.orgId} and device_id=${deviceId} and source_event_id=${event.sourceEventId} and source_version=${event.sourceVersion} for share`)).rows[0];
      if (!stored) novel.push(index);
      else if (stored.requestHash === sourceCheckInHash(event)) replayedIds.push(stored.id);
      else throw new ShiftError(`Source event ${event.sourceEventId} version ${event.sourceVersion} already has different content — preserve it and submit the next explicit source version with its actual predecessor.`);
    }
    const sourceEvidence = { ...input.sourceEvidence, receivedCount:events.length, replayedEventIds:replayedIds };
    const batch = one((await db.execute<AttendanceBatch>(sql`insert into hrm_attendance_batches(id,org_id,device_id,complete_through,source_evidence,event_count,request_hash,reason,created_by)
      values(${id},${input.orgId},${deviceId},${input.completeThrough},${JSON.stringify(sourceEvidence)}::jsonb,${novel.length},${hash},${reason},${input.actorId}) returning ${BATCH_COLUMNS}`)).rows);
    for (const index of novel) {
      const event = events[index]!;
      const mapping = identities[index]!;
      if (event.supersedesId) {
        const claims = (await db.execute<{ id: string }>(sql`select id from hrm_attendance_event_claims where org_id=${input.orgId} and event_id=${event.supersedesId} and released_at is null order by id for update`)).rows;
        for (const claim of claims) one((await db.execute(sql`update hrm_attendance_event_claims set released_at=now(),released_by=${input.actorId},release_reason=${reason} where org_id=${input.orgId} and id=${claim.id} and released_at is null returning id`)).rows);
      }
      one((await db.execute(sql`insert into hrm_attendance_events
       (id,org_id,device_id,batch_id,identity_id,subsidiary_id,employment_id,worker_party_id,source_event_id,source_version,kind,occurred_at,source_local_date,source_payload,supersedes_id,request_hash,reason,created_by)
       values(${event.id},${input.orgId},${deviceId},${id},${mapping.id},${mapping.subsidiaryId},${mapping.employmentId},${mapping.workerPartyId},${event.sourceEventId},${event.sourceVersion},${event.kind},${event.occurredAt},${mapping.localDate},${JSON.stringify(event.sourcePayload)}::jsonb,${event.supersedesId},${sourceCheckInHash(event)},${reason},${input.actorId}) returning id`)).rows);
    }
    if (input.completeThrough !== null) {
      const watermark = (await db.execute<{ id: string; revision: number }>(sql`select id,revision from hrm_attendance_watermarks where org_id=${input.orgId} and device_id=${deviceId} for update`)).rows[0];
      if (watermark) one((await db.execute(sql`update hrm_attendance_watermarks set batch_id=${id},complete_through=${input.completeThrough},revision=revision+1,reason=${reason},updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${watermark.id} and revision=${watermark.revision} returning id`)).rows);
      else one((await db.execute(sql`insert into hrm_attendance_watermarks(org_id,device_id,batch_id,complete_through,request_hash,reason,created_by,updated_by) values(${input.orgId},${deviceId},${id},${input.completeThrough},${hash},${reason},${input.actorId},${input.actorId}) returning id`)).rows);
    }
    return batch;
  });
}
