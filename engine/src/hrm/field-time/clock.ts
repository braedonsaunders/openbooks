/**
 * HR-20 clock service: record clock events, pair in<->out, produce entries.
 *
 * Idempotent on (org, client_event_id): a replayed offline event returns
 * the original recording, never a second row. Sequence violations refuse
 * by name, never silently pair. Outside-geofence events are RECORDED
 * with geo_check outside and flagged — a worker must be able to clock;
 * the flag routes to the approver. Photo enforcement refuses without a
 * photo. Pairing produces submitted time entries with hours from device
 * times, rounded per the declared rule, breaks subtracted per the
 * declared rule, weeks rolled into timesheet_weeks, cost rate through
 * the prevailing-wage resolver when it prices the day.
 */

import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { FieldTimeError, refuse } from "./errors.ts";
import {
  FIELD_TIME_GEOFENCE_FEATURE,
  FIELD_TIME_FEATURE,
  FIELD_TIME_PHOTO_FEATURE,
  loadFieldTimeSettings,
} from "./settings.ts";
import {
  insideCircle,
  insidePolygon,
  roundHours,
  subtractBreaks,
  validateClockSequence,
  type ClockKind,
  type LatLng,
} from "./pure.ts";
import { prevailingWageForTimeEntry } from "../construction/labor-hook.ts";

export interface ClockGeo {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

export interface RecordClockInput {
  orgId: string;
  /** The signed-in user recording (null on device-token kiosk routes). */
  actorUserId: string | null;
  employeePartyId: string;
  kind: ClockKind;
  /** Device time as ISO instant. */
  occurredAt: string;
  deviceId?: string | null;
  source: "mobile" | "kiosk" | "crew" | "api";
  projectId?: string | null;
  projectTaskId?: string | null;
  costCodeRef?: string | null;
  geo?: ClockGeo | null;
  photoFileId?: string | null;
  clientEventId: string;
  kioskId?: string | null;
}

export interface ClockRecordResult {
  eventId: string;
  pairId: string | null;
  geoCheck: string;
  autoClosedPairId: string | null;
  entryIds: string[];
  replayed: boolean;
}

type EventRow = {
  id: string;
  kind: string;
  occurred_at: string;
  project_id: string | null;
  project_task_id: string | null;
  cost_code_ref: string | null;
  pair_id: string | null;
  status: string;
  geo_check: string;
  auto_closed: boolean;
};

async function requireFieldTime(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, FIELD_TIME_FEATURE))) {
    refuse(
      "field_time_off",
      "Field time is turned off — turn on fieldTime in Company Settings → Features to clock in from the field",
    );
  }
}

async function checkPhotoRequirement(input: RecordClockInput): Promise<void> {
  let kioskRequires = false;
  if (input.kioskId) {
    const kiosk = (await db.execute<{ photo_required: boolean }>(sql`
      select photo_required from time_kiosks
       where org_id = ${input.orgId} and id = ${input.kioskId} and is_active`)).rows[0];
    if (!kiosk) refuse("kiosk_unknown", "The kiosk is unknown or retired — re-register the kiosk device before clocking");
    kioskRequires = kiosk.photo_required;
  }
  const settings = await loadFieldTimeSettings(input.orgId);
  const featureRequires =
    (await lockAndCheckOrgFeature(db, input.orgId, FIELD_TIME_PHOTO_FEATURE)) ||
    settings.photoRequired;
  if ((kioskRequires || featureRequires) && !input.photoFileId) {
    refuse(
      "photo_required",
      "A photo is required to clock in here — capture a photo and retry the clock action",
    );
  }
  if (input.photoFileId) {
    const file = (await db.execute<{ id: string }>(sql`
      select id from files where org_id = ${input.orgId} and id = ${input.photoFileId}`)).rows[0];
    if (!file) refuse("photo_unknown", "The attached photo is not in this organization — upload the photo through the File Cabinet and retry");
  }
}

async function checkGeofence(
  orgId: string,
  projectId: string | null,
  geo: ClockGeo | null | undefined,
): Promise<"inside" | "outside" | "unavailable" | "not_required"> {
  if (!projectId) return "not_required";
  if (!(await lockAndCheckOrgFeature(db, orgId, FIELD_TIME_GEOFENCE_FEATURE))) return "not_required";
  const fences = (await db.execute<{ kind: string; center: unknown; radius_m: number | null; polygon: unknown }>(sql`
    select kind, center, radius_m, polygon from project_geofences
     where org_id = ${orgId} and project_id = ${projectId} and is_active`)).rows;
  if (fences.length === 0) return "not_required";
  if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) return "unavailable";
  const point: LatLng = { lat: geo.lat, lng: geo.lng };
  for (const fence of fences) {
    if (fence.kind === "circle") {
      const center = fence.center as { lat: number; lng: number } | null;
      if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng) &&
          fence.radius_m && insideCircle(point, center, fence.radius_m)) {
        return "inside";
      }
    } else {
      const polygon = fence.polygon as LatLng[] | null;
      if (Array.isArray(polygon) && insidePolygon(point, polygon)) return "inside";
    }
  }
  return "outside";
}

async function openPair(orgId: string, employeePartyId: string): Promise<EventRow | null> {
  const rows = (await db.execute<EventRow>(sql`
    select id::text as id, kind, occurred_at::text as occurred_at,
           project_id::text as project_id, project_task_id::text as project_task_id,
           cost_code_ref, pair_id::text as pair_id, status, geo_check, auto_closed
      from time_clock_events
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and kind = 'clock_in' and status = 'recorded'
     order by occurred_at desc limit 1`)).rows;
  return rows[0] ?? null;
}

async function breakOpen(orgId: string, employeePartyId: string, sinceId: string): Promise<boolean> {
  const rows = (await db.execute<{ kind: string }>(sql`
    select kind from time_clock_events
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and kind in ('break_start', 'break_end')
       and (occurred_at, id) > ((select occurred_at from time_clock_events where id = ${sinceId}), ${sinceId})
     order by occurred_at desc, id desc limit 1`)).rows;
  return (rows[0]?.kind ?? null) === "break_start";
}

function sundayOf(dateIso: string): string {
  const d = new Date(dateIso);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

async function ensureWeek(orgId: string, employeePartyId: string, dateIso: string, actorUserId: string | null): Promise<void> {
  const weekStart = sundayOf(dateIso);
  // Get-or-create: a conflict means a concurrent clock already opened the
  // week, which is the expected benign case — the week exists either way.
  await db.execute(sql`
    insert into timesheet_weeks (org_id, employee_party_id, week_start, status, created_by, updated_by)
    values (${orgId}, ${employeePartyId}, ${weekStart}::date, 'draft', ${actorUserId}, ${actorUserId})
    on conflict do nothing`);
}

interface Segment {
  fromMs: number;
  toMs: number;
  breakMs: number;
  projectId: string | null;
  projectTaskId: string | null;
  costCodeRef: string | null;
}

/** Split a segment crossing UTC midnight into per-day pieces, pro-rata. */
function splitMidnight(segment: Segment): Array<Segment & { date: string }> {
  const out: Array<Segment & { date: string }> = [];
  let from = segment.fromMs;
  const total = segment.toMs - segment.fromMs;
  if (total <= 0) return [];
  while (from < segment.toMs) {
    const dayStart = Date.UTC(
      new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate(),
    );
    const dayEnd = dayStart + 86_400_000;
    const pieceEnd = Math.min(segment.toMs, dayEnd);
    const share = (pieceEnd - from) / total;
    out.push({
      ...segment,
      fromMs: from,
      toMs: pieceEnd,
      breakMs: Math.round(segment.breakMs * share),
      date: new Date(from).toISOString().slice(0, 10),
    });
    from = pieceEnd;
  }
  return out;
}

async function pairAndPostEntries(input: {
  orgId: string;
  actorUserId: string | null;
  employeePartyId: string;
  open: EventRow;
  closeOccurredAt: string;
  closeRefs: { projectId: string | null; projectTaskId: string | null; costCodeRef: string | null };
  autoClosed: boolean;
}): Promise<string[]> {
  const settings = await loadFieldTimeSettings(input.orgId);
  const pairId = input.open.id;
  const events = (await db.execute<EventRow>(sql`
    select id::text as id, kind, occurred_at::text as occurred_at,
           project_id::text as project_id, project_task_id::text as project_task_id,
           cost_code_ref, pair_id::text as pair_id, status, geo_check, auto_closed
      from time_clock_events
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and ((id = ${pairId}) or (occurred_at, id) > ((select occurred_at from time_clock_events where id = ${pairId}), ${pairId}))
       and occurred_at <= ${input.closeOccurredAt}::timestamptz
     order by occurred_at, id`)).rows;

  // Build segments: refs change at switch events; breaks accrue to the open segment.
  const segments: Segment[] = [];
  let current: Segment = {
    fromMs: Date.parse(input.open.occurred_at),
    toMs: Date.parse(input.closeOccurredAt),
    breakMs: 0,
    projectId: input.open.project_id,
    projectTaskId: input.open.project_task_id,
    costCodeRef: input.open.cost_code_ref,
  };
  let breakStartMs: number | null = null;
  for (const event of events) {
    if (event.id === pairId) continue;
    const at = Date.parse(event.occurred_at);
    if (event.kind === "break_start") {
      breakStartMs = at;
    } else if (event.kind === "break_end") {
      if (breakStartMs !== null) {
        current.breakMs += Math.max(0, at - breakStartMs);
        breakStartMs = null;
      }
    } else if (event.kind === "switch") {
      current.toMs = at;
      segments.push(current);
      current = {
        fromMs: at,
        toMs: Date.parse(input.closeOccurredAt),
        breakMs: 0,
        projectId: event.project_id,
        projectTaskId: event.project_task_id,
        costCodeRef: event.cost_code_ref,
      };
    }
  }
  if (breakStartMs !== null) {
    // A break left open at clock-out extends to the clock-out.
    current.breakMs += Math.max(0, Date.parse(input.closeOccurredAt) - breakStartMs);
  }
  segments.push(current);

  const entryIds: string[] = [];
  for (const segment of segments) {
    const grossMs = Math.max(0, segment.toMs - segment.fromMs);
    if (grossMs <= 0) continue;
    // Deduct the larger of recorded breaks and the declared unpaid rule.
    const declaredMs = settings.unpaidBreakMinutes * 60_000;
    const netMs = Math.max(0, grossMs - Math.max(segment.breakMs, declaredMs));
    const grossHours = (netMs / 3_600_000).toFixed(4);
    const rounded = roundHours(grossHours, settings.rounding);
    if (Number(rounded) <= 0) continue;
    const refs = segment === segments[segments.length - 1] && segments.length > 1
      ? input.closeRefs
      : { projectId: segment.projectId, projectTaskId: segment.projectTaskId, costCodeRef: segment.costCodeRef };
    for (const piece of splitMidnight(segment)) {
      const pieceGrossMs = Math.max(0, piece.toMs - piece.fromMs);
      if (pieceGrossMs <= 0) continue;
      const pieceDeclared = Math.max(piece.breakMs, Math.round(declaredMs * (pieceGrossMs / grossMs)));
      const pieceNet = Math.max(0, pieceGrossMs - pieceDeclared);
      const pieceHours = roundHours((pieceNet / 3_600_000).toFixed(4), settings.rounding);
      if (Number(pieceHours) <= 0) continue;
      let wageRate: string | null = null;
      let wageCurrency: string | null = null;
      if (refs.projectId && input.actorUserId) {
        try {
          const priced = await prevailingWageForTimeEntry({
            orgId: input.orgId,
            actorId: input.actorUserId,
            employeePartyId: input.employeePartyId,
            projectId: refs.projectId,
            workedOn: piece.date,
          });
          if (priced) {
            wageRate = priced.wage;
            wageCurrency = priced.currency;
          }
        } catch (e) {
          // The resolver refuses in-scope-but-unresolvable days by name;
          // that refusal must reach the caller, never a zero rate.
          throw e;
        }
      }
      await ensureWeek(input.orgId, input.employeePartyId, piece.date, input.actorUserId);
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into time_entries
          (org_id, employee_party_id, worked_on, hours, project_id, project_task_id,
           cost_code_ref, status, started_at, wage_rate, wage_currency,
           clock_pair_id, created_by, updated_by)
        values
          (${input.orgId}, ${input.employeePartyId}, ${piece.date}::date, ${pieceHours},
           ${refs.projectId}, ${refs.projectTaskId}, ${refs.costCodeRef},
           'submitted', ${input.open.occurred_at}::timestamptz,
           ${wageRate}, ${wageCurrency}, ${pairId},
           ${input.actorUserId}, ${input.actorUserId})
        returning id`)).rows[0];
      if (!inserted) throw new FieldTimeError("entry_not_stored", "The clock pairing produced no entry row — retry the clock-out");
      entryIds.push(inserted.id);
    }
  }
  // Close the pair on both rows.
  await db.execute(sql`
    update time_clock_events set status = 'paired', pair_id = ${pairId}, updated_at = now()
     where org_id = ${input.orgId} and (id = ${pairId} or pair_id is null and id in (
       select id from time_clock_events where org_id = ${input.orgId}
         and employee_party_id = ${input.employeePartyId} and occurred_at <= ${input.closeOccurredAt}::timestamptz
         and status = 'recorded'))`);
  return entryIds;
}

async function autoCloseStale(
  orgId: string,
  employeePartyId: string,
  actorUserId: string | null,
  nowMs: number,
): Promise<string | null> {
  const settings = await loadFieldTimeSettings(orgId);
  const open = await openPair(orgId, employeePartyId);
  if (!open) return null;
  const ageHours = (nowMs - Date.parse(open.occurred_at)) / 3_600_000;
  if (!(ageHours > settings.autoCloseHours)) return null;
  const closeAt = new Date(Date.parse(open.occurred_at) + settings.autoCloseHours * 3_600_000).toISOString();
  await db.execute(sql`
    insert into time_clock_events
      (org_id, employee_party_id, kind, occurred_at, source, project_id, project_task_id,
       cost_code_ref, geo_check, client_event_id, pair_id, status, auto_closed, created_by, updated_by)
    values
      (${orgId}, ${employeePartyId}, 'clock_out', ${closeAt}::timestamptz, 'api',
       ${open.project_id}, ${open.project_task_id}, ${open.cost_code_ref},
       'not_required', gen_random_uuid(), ${open.id}, 'recorded', true,
       ${actorUserId}, ${actorUserId})`);
  await pairAndPostEntries({
    orgId,
    actorUserId,
    employeePartyId,
    open,
    closeOccurredAt: closeAt,
    closeRefs: { projectId: open.project_id, projectTaskId: open.project_task_id, costCodeRef: open.cost_code_ref },
    autoClosed: true,
  });
  return open.id;
}

export async function recordClockEvent(input: RecordClockInput): Promise<ClockRecordResult> {
  await requireFieldTime(input.orgId);
  if (!input.clientEventId || !/^[0-9a-f-]{36}$/i.test(input.clientEventId)) {
    refuse("invalid_client_event", "The clock event carries no offline id — retry with a client-generated UUID so replay stays idempotent");
  }
  const occurredMs = Date.parse(input.occurredAt);
  if (!Number.isFinite(occurredMs)) refuse("invalid_occurred_at", "The clock time is not a valid instant — retry with the device time as ISO");
  if (occurredMs > Date.now() + 15 * 60_000) {
    refuse("future_clock", "The clock time is in the future — check the device clock and retry");
  }

  // Idempotency first: a replayed offline event returns the original result.
  const existing = (await db.execute<EventRow & { entries: string[] }>(sql`
    select e.id::text as id, e.kind, e.occurred_at::text as occurred_at,
           e.project_id::text as project_id, e.project_task_id::text as project_task_id,
           e.cost_code_ref, e.pair_id::text as pair_id, e.status, e.geo_check, e.auto_closed,
           coalesce(array_agg(t.id::text) filter (where t.id is not null), '{}') as entries
      from time_clock_events e
      left join time_entries t on t.org_id = e.org_id and t.clock_pair_id = e.pair_id
     where e.org_id = ${input.orgId} and e.client_event_id = ${input.clientEventId}
     group by e.id limit 1`)).rows[0];
  if (existing) {
    return {
      eventId: existing.id,
      pairId: existing.pair_id,
      geoCheck: existing.geo_check,
      autoClosedPairId: null,
      entryIds: existing.entries,
      replayed: true,
    };
  }

  return withOrgTransaction(input.orgId, async () => {
    const open = await openPair(input.orgId, input.employeePartyId);
    const onBreak = open ? await breakOpen(input.orgId, input.employeePartyId, open.id) : false;
    validateClockSequence(input.kind, { clockedIn: !!open, onBreak });

    // An open pair past the auto-close window closes with a flag first.
    let autoClosedPairId: string | null = null;
    if (input.kind === "clock_in" && open) {
      autoClosedPairId = await autoCloseStale(input.orgId, input.employeePartyId, input.actorUserId, occurredMs);
    }

    await checkPhotoRequirement(input);
    const geoCheck = await checkGeofence(input.orgId, input.projectId ?? null, input.geo ?? null);

    const inserted = (await db.execute<{ id: string }>(sql`
      insert into time_clock_events
        (org_id, employee_party_id, kind, occurred_at, device_id, source,
         project_id, project_task_id, cost_code_ref, geo, geo_check,
         photo_file_id, client_event_id, status, created_by, updated_by)
      values
        (${input.orgId}, ${input.employeePartyId}, ${input.kind}, ${input.occurredAt}::timestamptz,
         ${input.deviceId ?? null}, ${input.source},
         ${input.projectId ?? null}, ${input.projectTaskId ?? null}, ${input.costCodeRef ?? null},
         ${input.geo ? JSON.stringify(input.geo) : null}::jsonb, ${geoCheck},
         ${input.photoFileId ?? null}, ${input.clientEventId}, 'recorded',
         ${input.actorUserId}, ${input.actorUserId})
      returning id`)).rows[0];
    if (!inserted) throw new FieldTimeError("event_not_stored", "The clock event was not stored — no row was written; retry the clock action");

    let entryIds: string[] = [];
    let pairId: string | null = null;
    if ((input.kind === "clock_out" || input.kind === "switch") && open) {
      pairId = open.id;
      entryIds = await pairAndPostEntries({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        employeePartyId: input.employeePartyId,
        open,
        closeOccurredAt: input.occurredAt,
        closeRefs: {
          projectId: input.projectId ?? open.project_id,
          projectTaskId: input.projectTaskId ?? open.project_task_id,
          costCodeRef: input.costCodeRef ?? open.cost_code_ref,
        },
        autoClosed: false,
      });
      if (input.kind === "switch") {
        // The switch opens the next segment immediately.
        const next = (await db.execute<{ id: string }>(sql`
          insert into time_clock_events
            (org_id, employee_party_id, kind, occurred_at, device_id, source,
             project_id, project_task_id, cost_code_ref, geo, geo_check,
             photo_file_id, client_event_id, status, created_by, updated_by)
          values
            (${input.orgId}, ${input.employeePartyId}, 'clock_in', ${input.occurredAt}::timestamptz,
             ${input.deviceId ?? null}, ${input.source},
             ${input.projectId ?? open.project_id}, ${input.projectTaskId ?? open.project_task_id},
             ${input.costCodeRef ?? open.cost_code_ref},
             ${input.geo ? JSON.stringify(input.geo) : null}::jsonb, ${geoCheck},
             ${input.photoFileId ?? null}, gen_random_uuid(), 'recorded',
             ${input.actorUserId}, ${input.actorUserId})
          returning id`)).rows[0];
        if (!next) throw new FieldTimeError("event_not_stored", "The switch follow-on clock-in was not stored — review the pair before retrying");
        pairId = next.id;
      }
    }
    return { eventId: inserted.id, pairId, geoCheck, autoClosedPairId, entryIds, replayed: false };
  });
}

/** Replay an offline queue: per-event results, never all-or-nothing. */
export async function replayClockEvents(
  inputs: RecordClockInput[],
): Promise<Array<ClockRecordResult | { error: string }>> {
  const out: Array<ClockRecordResult | { error: string }> = [];
  for (const input of inputs) {
    try {
      out.push(await recordClockEvent(input));
    } catch (e) {
      out.push({ error: e instanceof FieldTimeError ? e.message : "The clock event failed — fix the event and replay it" });
    }
  }
  return out;
}

/** Open-pair status for the clock page and the assistant tool. */
export async function clockStatus(
  orgId: string,
  employeePartyId: string,
): Promise<{
  clockedIn: boolean;
  since: string | null;
  projectId: string | null;
  costCodeRef: string | null;
  onBreak: boolean;
  queuedNote: false;
}> {
  await requireFieldTime(orgId);
  const open = await openPair(orgId, employeePartyId);
  if (!open) {
    return { clockedIn: false, since: null, projectId: null, costCodeRef: null, onBreak: false, queuedNote: false };
  }
  return {
    clockedIn: true,
    since: open.occurred_at,
    projectId: open.project_id,
    costCodeRef: open.cost_code_ref,
    onBreak: await breakOpen(orgId, employeePartyId, open.id),
    queuedNote: false,
  };
}


