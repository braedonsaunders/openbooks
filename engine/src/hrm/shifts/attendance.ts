import { observeAttendance, requireShiftInstant, requireUuid, ShiftError, type AttendanceObservation, type DeviceCheckIn } from "./policy.ts";
import { SHIFT_COLUMNS, type RosterShift } from "./roster.ts";
import { creationReplay, db, expectedRevision, one, requestHash, scopedRow, shiftAuthority, shiftEmployment, shiftText, shiftTransaction, sql, type ShiftActor } from "./store.ts";

export type StoredAttendanceObservation = Omit<AttendanceObservation,"eventIds"|"presenceMilliseconds"|"breakMilliseconds"|"status"> & {
  readonly id: string; readonly shiftId: string; readonly subsidiaryId: string; readonly employmentId: string; readonly workerPartyId: string;
  readonly status: AttendanceObservation["status"] | "voided"; readonly presenceMilliseconds: string | null; readonly breakMilliseconds: string | null;
  readonly supersedesId: string | null; readonly sourceEvidence: unknown;
}
const OBSERVATION_COLUMNS = sql`id,shift_id as "shiftId",subsidiary_id as "subsidiaryId",employment_id as "employmentId",worker_party_id as "workerPartyId",status,
 to_char(complete_through at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "completeThrough",to_char(first_in at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "firstIn",to_char(last_out at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastOut",
 presence_milliseconds::text as "presenceMilliseconds",break_milliseconds::text as "breakMilliseconds",late,left_early as "leftEarly",evidence_hash as "evidenceHash",supersedes_id as "supersedesId",source_evidence as "sourceEvidence"`;
export async function processShiftAttendance(input: ShiftActor & { id: string; shiftId: string; expectedShiftRevision: number; supersedesId: string | null; reason: string }): Promise<StoredAttendanceObservation> {
  const id = requireUuid(input.id,"Attendance request key"), shiftId = requireUuid(input.shiftId,"Shift"), supersedesId = input.supersedesId === null ? null : requireUuid(input.supersedesId,"Previous observation"), reason = shiftText(input.reason,"Reason");
  const payload = { shiftId,expectedShiftRevision:input.expectedShiftRevision,supersedesId,reason }, hash = requestHash(payload);
  return shiftTransaction(input,async () => {
    await shiftAuthority(input,"hrm.shifts.read");
    const identity = await scopedRow<RosterShift>(input,"hrm_shifts",shiftId,SHIFT_COLUMNS,"hrm.attendance.manage","none");
    await shiftEmployment(input,identity.employmentId,"hrm.attendance.manage");
    await db.execute(sql`select d.id from hrm_attendance_devices d where d.org_id=${input.orgId} and exists(select 1 from hrm_attendance_identities i where i.org_id=d.org_id and i.device_id=d.id and i.employment_id=${identity.employmentId}) order by d.id for update`);
    const shift = await scopedRow<RosterShift>(input,"hrm_shifts",shiftId,SHIFT_COLUMNS,"hrm.attendance.manage",true);
    const replay = await creationReplay<StoredAttendanceObservation>(input,"hrm_attendance_observations",id,hash,OBSERVATION_COLUMNS);
    if (replay) return replay;
    expectedRevision(shift,input.expectedShiftRevision);
    if (!["published","closed","cancelled"].includes(shift.status)) throw new ShiftError("Attendance requires a published shift — publish its independently reviewed roster record before processing source check-ins.");
    const previous = (await db.execute<{ id: string; evidenceHash: string }>(sql`select id,evidence_hash as "evidenceHash" from hrm_attendance_observations o where org_id=${input.orgId} and shift_id=${shiftId}
     and not exists(select 1 from hrm_attendance_observations n where n.org_id=o.org_id and n.supersedes_id=o.id) for update`)).rows[0];
    if ((previous?.id ?? null) !== supersedesId) throw new ShiftError("Attendance observation changed — reload the shift and use its latest observation as the correction predecessor.");
    if (!shift.attendancePolicy) throw new ShiftError("This shift has no attendance capture policy — publish a successor shift with explicit capture and grace bounds before processing device attendance; ordinary scheduling does not require those settings.");
    const captureFrom = new Date(requireShiftInstant(shift.startsAt,"Shift start")-shift.attendancePolicy.captureBeforeSeconds*1000).toISOString();
    const captureTo = new Date(requireShiftInstant(shift.endsAt,"Shift end")+shift.attendancePolicy.captureAfterSeconds*1000).toISOString();
    requireShiftInstant(captureFrom,"Capture window start"); requireShiftInstant(captureTo,"Capture window end");
    const mapped = (await db.execute<{ identityId: string; deviceId: string; watermarkId: string | null; batchId: string | null; completeThrough: string | null; covered: boolean }>(sql`select i.id as "identityId",i.device_id as "deviceId",w.id as "watermarkId",w.batch_id as "batchId",
     to_char(w.complete_through at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "completeThrough",
     daterange(i.effective_from,i.effective_to,'[)') @> daterange((${captureFrom}::timestamptz at time zone d.time_zone)::date,(${captureTo}::timestamptz at time zone d.time_zone)::date,'[]') as covered
     from hrm_attendance_identities i join hrm_attendance_devices d on d.org_id=i.org_id and d.id=i.device_id left join hrm_attendance_watermarks w on w.org_id=i.org_id and w.device_id=i.device_id
     where i.org_id=${input.orgId} and i.employment_id=${shift.employmentId}
     and daterange(i.effective_from,i.effective_to,'[)') && daterange((${captureFrom}::timestamptz at time zone d.time_zone)::date,(${captureTo}::timestamptz at time zone d.time_zone)::date,'[]') order by i.device_id,i.id`)).rows;
    if (shift.status !== "cancelled" && (!mapped.length || mapped.some(mapping => !mapping.covered))) throw new ShiftError("A dated device identity does not cover the whole capture window — configure the actual source mapping before processing this shift.");
    const events = (await db.execute<DeviceCheckIn>(sql`select e.id,e.kind,to_char(e.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "occurredAt" from hrm_attendance_events e
     where e.org_id=${input.orgId} and e.employment_id=${shift.employmentId} and e.worker_party_id=${shift.workerPartyId} and e.occurred_at between ${captureFrom} and ${captureTo} and e.kind<>'void'
     and not exists(select 1 from hrm_attendance_events n where n.org_id=e.org_id and n.supersedes_id=e.id) order by e.occurred_at,e.id for update`)).rows;
    const completeThrough = !mapped.length || mapped.some(mapping => mapping.completeThrough === null) ? null : mapped.map(mapping => mapping.completeThrough!).sort()[0]!;
    const observed = shift.status === "cancelled" ? { status:"voided" as const,completeThrough:null,firstIn:null,lastOut:null,presenceMilliseconds:null,breakMilliseconds:null,late:null,leftEarly:null,evidenceHash:requestHash({ shiftId,revision:shift.revision,status:shift.status }),eventIds:[] as readonly string[] }
      : observeAttendance({ shift:{ startsAt:shift.startsAt,endsAt:shift.endsAt },policy:shift.attendancePolicy,completeThrough,events });
    const evidence = { shiftRevision:shift.revision,definitionHash:shift.definitionHash,sources:mapped,eventIds:observed.eventIds,decisionHash:observed.evidenceHash };
    const evidenceHash = requestHash(evidence);
    if (previous?.evidenceHash === evidenceHash) throw new ShiftError("Attendance already reflects these source records — open the current observation; a new correction needs changed source evidence or roster state.");
    const stored = one((await db.execute<StoredAttendanceObservation>(sql`insert into hrm_attendance_observations
     (id,org_id,shift_id,subsidiary_id,employment_id,worker_party_id,status,complete_through,first_in,last_out,presence_milliseconds,break_milliseconds,late,left_early,source_evidence,evidence_hash,supersedes_id,request_hash,reason,created_by)
     values(${id},${input.orgId},${shiftId},${shift.subsidiaryId},${shift.employmentId},${shift.workerPartyId},${observed.status},${observed.completeThrough},${observed.firstIn},${observed.lastOut},${observed.presenceMilliseconds},${observed.breakMilliseconds},${observed.late},${observed.leftEarly},${JSON.stringify(evidence)}::jsonb,${evidenceHash},${supersedesId},${hash},${reason},${input.actorId}) returning ${OBSERVATION_COLUMNS}`)).rows);
    if (shift.status === "cancelled") {
      const claims = (await db.execute<{ id: string }>(sql`select id from hrm_attendance_event_claims where org_id=${input.orgId} and shift_id=${shiftId} and released_at is null order by id for update`)).rows;
      for (const claim of claims) one((await db.execute(sql`update hrm_attendance_event_claims set released_at=now(),released_by=${input.actorId},release_reason=${reason} where org_id=${input.orgId} and id=${claim.id} and released_at is null returning id`)).rows);
    }
    for (const eventId of observed.eventIds) {
      let claim = (await db.execute<{ id: string; shiftId: string }>(sql`select id,shift_id as "shiftId" from hrm_attendance_event_claims where org_id=${input.orgId} and event_id=${eventId} and released_at is null for update`)).rows[0];
      if (claim && claim.shiftId !== shiftId) throw new ShiftError(`Check-in ${eventId} is already attributed to another shift — reconcile overlapping capture windows and release the former attribution through its controlled correction before reprocessing.`);
      if (!claim) claim = one((await db.execute<{ id: string; shiftId: string }>(sql`insert into hrm_attendance_event_claims(org_id,event_id,shift_id,request_hash,reason,created_by)
        values(${input.orgId},${eventId},${shiftId},${requestHash({ observationId:id,eventId })},${reason},${input.actorId}) returning id,shift_id as "shiftId"`)).rows);
      one((await db.execute(sql`insert into hrm_attendance_observation_events(org_id,observation_id,event_claim_id,request_hash,reason,created_by)
        values(${input.orgId},${id},${claim.id},${requestHash({ observationId:id,claimId:claim.id })},${reason},${input.actorId}) returning id`)).rows);
    }
    return stored;
  });
}
