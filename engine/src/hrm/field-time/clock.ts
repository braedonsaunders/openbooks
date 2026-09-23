/**
 * HR-20 clock service: record clock events, pair in<->out, produce entries.
 *
 * Idempotent on (org, client_event_id): a replayed offline event returns
 * the original recording, never a second row — the key is claimed with
 * INSERT … ON CONFLICT DO NOTHING inside the transaction, so concurrent
 * replays serialize and the loser reads back the winner. A reused key
 * carrying a different event conflicts by name. Sequence violations refuse
 * by name, never silently pair. Outside-geofence events are RECORDED
 * with geo_check outside and flagged — a worker must be able to clock;
 * the flag routes to the approver. Photo enforcement refuses without a
 * photo. Pairing produces submitted time entries with hours from device
 * times, rounded per the declared rule, breaks subtracted per the
 * declared rule, weeks rolled into timesheet_weeks, cost rate through
 * the prevailing-wage resolver when it prices the day.
 */

import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { FieldTimeError, isForeignKeyViolation, refuse } from "./errors.ts";
import {
  FIELD_TIME_GEOFENCE_FEATURE,
  FIELD_TIME_FEATURE,
  FIELD_TIME_PHOTO_FEATURE,
  loadFieldTimeSettings,
} from "./settings.ts";
import {
  allocateShiftNetMs,
  distributeProRata,
  hoursToQuantumUnits,
  insideCircle,
  insidePolygon,
  quantumUnitsToHours,
  roundHours,
  sameClockPayload,
  splitUtcDays,
  validateClockSequence,
  validateEventChronology,
  type ClockKind,
  type ClockPayload,
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

async function openPair(
  orgId: string,
  employeePartyId: string,
  excludeId?: string | null,
): Promise<EventRow | null> {
  // excludeId is the idempotency-claimed row of the event being
  // recorded: the claim lands before validation, so the open lookup
  // must not see the event itself as its own open pair.
  const rows = (await db.execute<EventRow>(sql`
    select id::text as id, kind, occurred_at::text as occurred_at,
           project_id::text as project_id, project_task_id::text as project_task_id,
           cost_code_ref, pair_id::text as pair_id, status, geo_check, auto_closed
      from time_clock_events
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and kind = 'clock_in' and status = 'recorded'
       and (${excludeId ?? null}::text is null or id::text != ${excludeId ?? null}::text)
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

  // The declared unpaid break is a shift rule, not a segment rule: it
  // is deducted once across all segments (see allocateShiftNetMs), so
  // a project switch mid-shift never multiplies the deduction.
  const shiftNets = allocateShiftNetMs(
    segments.map((s) => Math.max(0, s.toMs - s.fromMs)),
    segments.map((s) => s.breakMs),
    settings.unpaidBreakMinutes,
  );
  const noPayable = (): FieldTimeError =>
    new FieldTimeError(
      "no_payable_time",
      `The shift from ${input.open.occurred_at} to ${input.closeOccurredAt} nets to zero hours after breaks and rounding — no entry was posted and the clock-in stays open; review the times in Timesheets and clock out again`,
    );
  // Round ONCE per shift: rounding each midnight piece separately paid
  // 23:52-00:08 as 30 minutes under nearest-15m instead of the 15 the
  // shift earned. The exact rounded total is dealt across day pieces by
  // largest remainder, so posted entries sum to precisely the total.
  const totalNetMs = shiftNets.reduce((a, b) => a + b, 0);
  const shiftRounded = roundHours((totalNetMs / 3_600_000).toFixed(4), settings.rounding);
  const totalUnits = hoursToQuantumUnits(shiftRounded, settings.rounding);
  if (totalUnits <= 0) throw noPayable();
  interface DayCell {
    date: string;
    ms: number;
    refs: { projectId: string | null; projectTaskId: string | null; costCodeRef: string | null };
  }
  const cells: DayCell[] = [];
  for (let si = 0; si < segments.length; si++) {
    const segment = segments[si]!;
    const grossMs = Math.max(0, segment.toMs - segment.fromMs);
    if (grossMs <= 0) continue;
    const netMs = shiftNets[si]!;
    if (netMs <= 0) continue;
    const refs = si === segments.length - 1 && segments.length > 1
      ? input.closeRefs
      : { projectId: segment.projectId, projectTaskId: segment.projectTaskId, costCodeRef: segment.costCodeRef };
    // UTC midnights: the org model declares no business timezone, and
    // the rest of time tracking already days in UTC.
    const pieces = splitUtcDays(segment.fromMs, segment.toMs);
    const dealt = distributeProRata(netMs, pieces.map((p) => p.ms));
    pieces.forEach((piece, i) => {
      if (dealt[i]! > 0) cells.push({ date: piece.date, ms: dealt[i]!, refs });
    });
  }
  const cellUnits = distributeProRata(totalUnits, cells.map((c) => c.ms));
  const entryIds: string[] = [];
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci]!;
    if (cellUnits[ci]! <= 0) continue;
    const pieceHours = quantumUnitsToHours(cellUnits[ci]!, settings.rounding);
    const refs = cell.refs;
    let wageRate: string | null = null;
    let wageCurrency: string | null = null;
    if (refs.projectId && input.actorUserId) {
      try {
        const priced = await prevailingWageForTimeEntry({
          orgId: input.orgId,
          actorId: input.actorUserId,
          employeePartyId: input.employeePartyId,
          projectId: refs.projectId,
          workedOn: cell.date,
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
    await ensureWeek(input.orgId, input.employeePartyId, cell.date, input.actorUserId);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into time_entries
        (org_id, employee_party_id, worked_on, hours, project_id, project_task_id,
         cost_code_ref, status, started_at, wage_rate, wage_currency,
         clock_pair_id, created_by, updated_by)
      values
        (${input.orgId}, ${input.employeePartyId}, ${cell.date}::date, ${pieceHours},
         ${refs.projectId}, ${refs.projectTaskId}, ${refs.costCodeRef},
         'submitted', ${input.open.occurred_at}::timestamptz,
         ${wageRate}, ${wageCurrency}, ${pairId},
         ${input.actorUserId}, ${input.actorUserId})
      returning id`)).rows[0];
    if (!inserted) throw new FieldTimeError("entry_not_stored", "The clock pairing produced no entry row — retry the clock-out");
    entryIds.push(inserted.id);
  }
  if (entryIds.length === 0) {
    // A pair with no entry is a vanished shift: the close stays refused
    // (the transaction rolls back) and the clock-in stays open, instead
    // of marking paired around nothing and reporting success.
    throw new FieldTimeError(
      "no_payable_time",
      `The shift from ${input.open.occurred_at} to ${input.closeOccurredAt} nets to zero hours after breaks and rounding — no entry was posted and the clock-in stays open; review the times in Timesheets and clock out again`,
    );
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
  excludeId?: string | null,
): Promise<string | null> {
  const settings = await loadFieldTimeSettings(orgId);
  const open = await openPair(orgId, employeePartyId, excludeId);
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

  return withOrgTransaction(input.orgId, async () => {
    // Transaction-safe get-or-create on the offline idempotency key.
    // Reading the key outside the transaction let two simultaneous
    // replays both see nothing, so the second died on the unique index
    // instead of replaying. Now concurrent replays serialize on the
    // unique index: the loser inserts nothing and reads back the
    // winner's row below. geo_check starts at the column default and is
    // stamped after evaluation — it never commits un-evaluated, because
    // the stamp below runs before commit and failures roll back.
    // A foreign-key failure means the claim references something absent
    // (an unknown worker or photo): validation still runs first, so a
    // sequence refusal names the remedy exactly as before the claim
    // existed; when validation passes, the insert error stands.
    let attempted: { id: string } | undefined;
    let claimError: unknown = null;
    try {
      // The savepoint contains a failed claim: without it the aborted
      // insert would poison the transaction and every statement after
      // it — including the validation read that must still refuse by
      // name — would die with an aborted-transaction error instead.
      attempted = await withTransactionSavepoint(db, async () => (await db.execute<{ id: string }>(sql`
        insert into time_clock_events
          (org_id, employee_party_id, kind, occurred_at, device_id, source,
           project_id, project_task_id, cost_code_ref, geo, geo_check,
           photo_file_id, client_event_id, status, created_by, updated_by)
        values
          (${input.orgId}, ${input.employeePartyId}, ${input.kind}, ${input.occurredAt}::timestamptz,
           ${input.deviceId ?? null}, ${input.source},
           ${input.projectId ?? null}, ${input.projectTaskId ?? null}, ${input.costCodeRef ?? null},
           ${input.geo ? JSON.stringify(input.geo) : null}::jsonb, 'not_required',
           ${input.photoFileId ?? null}, ${input.clientEventId}, 'recorded',
           ${input.actorUserId}, ${input.actorUserId})
        on conflict (org_id, client_event_id) do nothing
        returning id::text as id`)).rows[0]);
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      claimError = error;
    }
    if (!attempted && !claimError) {
      const existing = (await db.execute<EventRow & { entries: string[]; employee_party_id: string; source: string }>(sql`
        select e.id::text as id, e.kind, e.occurred_at::text as occurred_at,
               e.employee_party_id::text as employee_party_id, e.source as source,
               e.project_id::text as project_id, e.project_task_id::text as project_task_id,
               e.cost_code_ref, e.pair_id::text as pair_id, e.status, e.geo_check, e.auto_closed,
               coalesce(array_agg(t.id::text) filter (where t.id is not null), '{}') as entries
          from time_clock_events e
          left join time_entries t on t.org_id = e.org_id and t.clock_pair_id = e.pair_id
         where e.org_id = ${input.orgId} and e.client_event_id = ${input.clientEventId}
         group by e.id limit 1`)).rows[0];
      if (!existing) {
        throw new FieldTimeError("event_not_stored", "The clock event was not stored — no row was written; retry the clock action");
      }
      const winner: ClockPayload = {
        kind: existing.kind as ClockKind,
        occurredAtMs: Date.parse(existing.occurred_at),
        employeePartyId: existing.employee_party_id,
        projectId: existing.project_id,
        projectTaskId: existing.project_task_id,
        costCodeRef: existing.cost_code_ref,
        source: existing.source,
      };
      const candidate: ClockPayload = {
        kind: input.kind,
        occurredAtMs: occurredMs,
        employeePartyId: input.employeePartyId,
        projectId: input.projectId ?? null,
        projectTaskId: input.projectTaskId ?? null,
        costCodeRef: input.costCodeRef ?? null,
        source: input.source,
      };
      if (!sameClockPayload(winner, candidate)) {
        refuse(
          "client_event_conflict",
          `The offline id ${input.clientEventId} was already used for a different clock event (${existing.kind} at ${existing.occurred_at}) — generate a fresh clientEventId for this event and retry`,
        );
      }
      return {
        eventId: existing.id,
        pairId: existing.pair_id,
        geoCheck: existing.geo_check,
        autoClosedPairId: null,
        entryIds: existing.entries,
        replayed: true,
      };
    }

    const open = await openPair(input.orgId, input.employeePartyId, attempted?.id ?? null);

    // The stale pair closes BEFORE the sequence is judged, because the
    // sequence has to be judged against the state the worker is actually
    // in. Validating first meant a pair left open past the auto-close
    // window refused the next clock-in as "Already clocked in" and the
    // auto-close below never ran -- so a worker whose device died mid
    // shift, or who simply forgot to clock out, could not clock in again
    // at all. That is precisely the case auto-close exists for.
    let autoClosedPairId: string | null = null;
    if (input.kind === "clock_in" && open) {
      autoClosedPairId = await autoCloseStale(input.orgId, input.employeePartyId, input.actorUserId, occurredMs, attempted?.id ?? null);
    }

    // Re-read only when something closed: a pair inside the window is
    // still open and must still refuse, which is the sequence rule doing
    // its job rather than being skipped.
    const current = autoClosedPairId ? await openPair(input.orgId, input.employeePartyId, attempted?.id ?? null) : open;
    const onBreak = current ? await breakOpen(input.orgId, input.employeePartyId, current.id) : false;
    validateClockSequence(input.kind, { clockedIn: !!current, onBreak });
    if (current) {
      // Chronology is judged before anything mutates: a close at or
      // before the open instant never inserts, never pairs.
      validateEventChronology(input.kind, Date.parse(current.occurred_at), occurredMs);
    }

    await checkPhotoRequirement(input);
    const geoCheck = await checkGeofence(input.orgId, input.projectId ?? null, input.geo ?? null);

    // Validation passed but the claim never landed: the insert error
    // stands, exactly as before the claim existed.
    if (!attempted) throw claimError;

    // The row was claimed up front for idempotency; stamp the evaluated
    // geofence verdict onto it. A zero-row update means the claimed row
    // is gone — fail, never continue on a phantom event.
    const claimed = (await db.execute<{ id: string }>(sql`
      update time_clock_events set geo_check = ${geoCheck}, updated_at = now()
       where org_id = ${input.orgId} and id = ${attempted.id}
      returning id::text as id`)).rows[0];
    if (!claimed) throw new FieldTimeError("event_not_stored", "The clock event was not stored — no row was written; retry the clock action");
    const inserted = claimed;

    let entryIds: string[] = [];
    let pairId: string | null = null;
    // A switch re-targets the still-open pair — it records the new
    // project refs for the next segment but never closes or posts.
    // Closing at every switch deducted the declared break and rounded
    // once per project instead of once per shift; the whole shift
    // pairs and posts when the clock-out arrives.
    if (input.kind === "switch" && current) {
      pairId = current.id;
    }
    if (input.kind === "clock_out" && current) {
      pairId = current.id;
      entryIds = await pairAndPostEntries({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        employeePartyId: input.employeePartyId,
        open: current,
        closeOccurredAt: input.occurredAt,
        closeRefs: {
          projectId: input.projectId ?? current.project_id,
          projectTaskId: input.projectTaskId ?? current.project_task_id,
          costCodeRef: input.costCodeRef ?? current.cost_code_ref,
        },
        autoClosed: false,
      });
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
  const current = await openPair(orgId, employeePartyId);
  if (!current) {
    return { clockedIn: false, since: null, projectId: null, costCodeRef: null, onBreak: false, queuedNote: false };
  }
  return {
    clockedIn: true,
    since: current.occurred_at,
    projectId: current.project_id,
    costCodeRef: current.cost_code_ref,
    onBreak: await breakOpen(orgId, employeePartyId, current.id),
    queuedNote: false,
  };
}


