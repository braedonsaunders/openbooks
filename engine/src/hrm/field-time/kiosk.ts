/**
 * HR-20 kiosk service: device registration, PIN identify with lockout,
 * and kiosk clock events through the clock service.
 *
 * Kiosk routes are device-token routes with no session: the bearer
 * token in the URL path authenticates the DEVICE, and the worker's PIN
 * identifies the PERSON. A wrong PIN five times locks that worker's
 * kiosk identity for fifteen minutes — the refusal names the unlock
 * time, and nothing about the lock is silent.
 */

import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { FieldTimeError, refuse } from "./errors.ts";
import { FIELD_TIME_FEATURE, FIELD_TIME_KIOSK_FEATURE } from "./settings.ts";
import { hashDeviceToken, hashPin, issueDeviceToken, verifyPin } from "./pins.ts";
import { recordClockEvent, type ClockRecordResult, type RecordClockInput } from "./clock.ts";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

async function requireKioskFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, FIELD_TIME_FEATURE))) {
    refuse(
      "field_time_off",
      "Field time is turned off — turn on fieldTime in Company Settings → Features to use kiosk clock-in",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, FIELD_TIME_KIOSK_FEATURE))) {
    refuse(
      "field_time_kiosk_off",
      "Kiosk clock-in is turned off — turn on fieldTimeKiosk in Company Settings → Features to use kiosk clock-in",
    );
  }
}

export interface KioskRow {
  id: string;
  orgId: string;
  name: string;
  locationId: string | null;
  projectId: string | null;
  pinRequired: boolean;
  photoRequired: boolean;
  isActive: boolean;
  lastSeenAt: string | null;
}

export async function registerKiosk(input: {
  orgId: string;
  actorUserId: string;
  name: string;
  locationId?: string | null;
  projectId?: string | null;
  pinRequired?: boolean;
  photoRequired?: boolean;
}): Promise<{ kiosk: KioskRow; token: string }> {
  await requireKioskFeature(input.orgId);
  if (!input.name || input.name.trim() === "") {
    refuse("kiosk_name_required", "The kiosk needs a name — name the device after its site or gate and retry");
  }
  const { token, tokenHash } = issueDeviceToken();
  const row = (await db.execute<KioskRow>(sql`
    insert into time_kiosks
      (org_id, name, location_id, project_id, pin_required, photo_required,
       device_token_hash, created_by, updated_by)
    values
      (${input.orgId}, ${input.name.trim()}, ${input.locationId ?? null},
       ${input.projectId ?? null}, ${input.pinRequired !== false},
       ${input.photoRequired === true}, ${tokenHash},
       ${input.actorUserId}, ${input.actorUserId})
    returning id::text as id, org_id::text as "orgId", name,
              location_id::text as "locationId", project_id::text as "projectId",
              pin_required as "pinRequired", photo_required as "photoRequired",
              is_active as "isActive", last_seen_at::text as "lastSeenAt"`)).rows[0];
  if (!row) throw new FieldTimeError("kiosk_not_stored", "The kiosk was not stored — no row was written; retry the registration");
  return { kiosk: row, token };
}

/** Retire a kiosk: deactivated AND its token rotated so a held URL dies. */
export async function revokeKiosk(orgId: string, kioskId: string, actorUserId: string): Promise<void> {
  await requireKioskFeature(orgId);
  const rotated = issueDeviceToken().tokenHash;
  const moved = (await db.execute<{ n: number }>(sql`
    update time_kiosks
       set is_active = false, device_token_hash = ${rotated}, updated_at = now(), updated_by = ${actorUserId}
     where org_id = ${orgId} and id = ${kioskId} and is_active`)).rowCount ?? 0;
  if (moved !== 1) {
    refuse("kiosk_unknown", "The kiosk is unknown or already retired — reload the kiosk list");
  }
}

export async function resolveKioskByToken(deviceToken: string): Promise<KioskRow> {
  const hash = hashDeviceToken(deviceToken);
  const row = (await db.execute<(KioskRow & { org_id: string })>(sql`
    select id::text as id, org_id::text as "orgId", org_id::text as org_id, name,
           location_id::text as "locationId", project_id::text as "projectId",
           pin_required as "pinRequired", photo_required as "photoRequired",
           is_active as "isActive", last_seen_at::text as "lastSeenAt"
      from time_kiosks where device_token_hash = ${hash}`)).rows[0];
  if (!row || !row.isActive) {
    refuse("kiosk_unknown", "This kiosk link is unknown or retired — ask a manager for a current kiosk link");
  }
  const kiosk = row!;
  await requireKioskFeature(kiosk.orgId);
  await db.execute(sql`update time_kiosks set last_seen_at = now() where id = ${kiosk.id}`);
  return kiosk;
}

/**
 * Identify the worker behind a PIN on a kiosk. Five wrong attempts lock
 * the worker's kiosk identity for fifteen minutes.
 */
export async function identifyByPin(input: {
  kiosk: KioskRow;
  employeePartyId: string;
  pin: string;
}): Promise<string> {
  const row = (await db.execute<{ pin_hash: string; failed_attempts: number; locked_until: string | null }>(sql`
    select pin_hash, failed_attempts, locked_until::text as locked_until
      from worker_clock_pins
     where org_id = ${input.kiosk.orgId} and employee_party_id = ${input.employeePartyId}`)).rows[0];
  if (!row) {
    refuse(
      "pin_not_set",
      "No kiosk PIN is set for this worker — ask a manager to set a PIN before using the kiosk",
    );
  }
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    refuse(
      "pin_locked",
      `Too many wrong PINs — kiosk sign-in for this worker unlocks at ${row.locked_until}; ask a manager to reset the PIN`,
    );
  }
  if (!verifyPin(input.pin, row.pin_hash)) {
    const attempts = row.failed_attempts + 1;
    const locked = attempts >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
      : null;
    await db.execute(sql`
      update worker_clock_pins
         set failed_attempts = ${attempts}, locked_until = ${locked}::timestamptz, updated_at = now()
       where org_id = ${input.kiosk.orgId} and employee_party_id = ${input.employeePartyId}`);
    if (locked) {
      refuse(
        "pin_locked",
        `Too many wrong PINs — kiosk sign-in for this worker unlocks at ${locked}; ask a manager to reset the PIN`,
      );
    }
    refuse(
      "pin_wrong",
      `Wrong PIN — ${MAX_ATTEMPTS - attempts} attempts remain before kiosk sign-in locks for ${LOCK_MINUTES} minutes`,
    );
  }
  await db.execute(sql`
    update worker_clock_pins
       set failed_attempts = 0, locked_until = null, updated_at = now()
     where org_id = ${input.kiosk.orgId} and employee_party_id = ${input.employeePartyId}`);
  return input.employeePartyId;
}

/** Set (or reset, clearing lockout) a worker's kiosk PIN. */
export async function setWorkerPin(input: {
  orgId: string;
  actorUserId: string;
  employeePartyId: string;
  pin: string;
}): Promise<void> {
  await requireKioskFeature(input.orgId);
  // hashPin refuses non-numeric PINs by name before anything is stored.
  const pinHash = hashPin(input.pin);
  await withOrgTransaction(input.orgId, async () => {
    const moved = (await db.execute<{ n: number }>(sql`
      update worker_clock_pins
         set pin_hash = ${pinHash}, failed_attempts = 0, locked_until = null, updated_at = now()
       where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}`)).rowCount ?? 0;
    if (moved !== 1) {
      await db.execute(sql`
        insert into worker_clock_pins (org_id, employee_party_id, pin_hash)
        values (${input.orgId}, ${input.employeePartyId}, ${pinHash})`);
    }
  });
}

/**
 * Record a kiosk clock event: the kiosk pins the project when it is
 * dedicated to one, and kiosk photo/PIN switches enforce on the event.
 */
export async function kioskClockEvent(input: {
  kiosk: KioskRow;
  employeePartyId: string;
  kind: RecordClockInput["kind"];
  occurredAt: string;
  projectId?: string | null;
  projectTaskId?: string | null;
  costCodeRef?: string | null;
  geo?: RecordClockInput["geo"];
  photoFileId?: string | null;
  clientEventId: string;
}): Promise<ClockRecordResult> {
  if (input.kiosk.pinRequired && !input.employeePartyId) {
    refuse("pin_required", "This kiosk requires a PIN — enter the worker PIN before clocking");
  }
  return recordClockEvent({
    orgId: input.kiosk.orgId,
    actorUserId: null,
    employeePartyId: input.employeePartyId,
    kind: input.kind,
    occurredAt: input.occurredAt,
    deviceId: `kiosk:${input.kiosk.id}`,
    source: "kiosk",
    projectId: input.kiosk.projectId ?? input.projectId ?? null,
    projectTaskId: input.projectTaskId ?? null,
    costCodeRef: input.costCodeRef ?? null,
    geo: input.geo ?? null,
    photoFileId: input.photoFileId ?? null,
    clientEventId: input.clientEventId,
    kioskId: input.kiosk.id,
  });
}
