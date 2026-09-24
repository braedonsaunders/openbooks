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
import { db, withBypassContext, withOrgTransaction } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { assertUnrestrictedScope, lockProjectForScope, ScopeNotFoundError } from "../../organization/subsidiary-scope.ts";
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

export type KioskRow = {
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

export type KioskWorker = {
  id: string;
  name: string;
};

/**
 * Active employment for kiosk purposes: the party holds an employment whose
 * live version (recorded_until is null) is active or on leave. Offered has
 * not started, suspended is not active, terminated has ended — none of them
 * clock. Status is the declared lifecycle; effective windows are HR detail
 * the clock does not second-guess.
 */
async function hasActiveEmployment(orgId: string, partyId: string): Promise<boolean> {
  const row = (await db.execute<{ one: number }>(sql`
    select 1 as one
      from worker_employments e
      join worker_employment_versions v
        on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
     where e.org_id = ${orgId} and e.worker_party_id = ${partyId}
       and v.status in ('active', 'on_leave')
     limit 1`)).rows[0];
  return !!row;
}

/**
 * Workers the terminal may offer: active parties with an active employment,
 * ordered by name. No row cap — the terminal searches this list client-side,
 * so a cap would silently hide workers past it. Customers, vendors, and
 * ended employments never appear. Deliberately NOT scoped to the kiosk's
 * location: assignment-location data may be incomplete, and hiding a worker
 * from the terminal denies their clock-in.
 */
export async function listKioskWorkers(orgId: string): Promise<KioskWorker[]> {
  return withOrgTransaction(orgId, async () => {
    return (await db.execute<KioskWorker>(sql`
      select p.id::text as id, p.display_name as name
        from parties p
       where p.org_id = ${orgId} and p.is_active
         and exists (
           select 1
             from worker_employments e
             join worker_employment_versions v
               on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
            where e.org_id = p.org_id and e.worker_party_id = p.id
              and v.status in ('active', 'on_leave')
         )
       order by p.display_name, p.id`)).rows;
  });
}

export async function registerKiosk(input: {
  orgId: string;
  actorUserId: string;
  name: string;
  locationId?: string | null;
  projectId?: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  pinRequired?: boolean;
  photoRequired?: boolean;
}): Promise<{ kiosk: KioskRow; token: string }> {
  await requireKioskFeature(input.orgId);
  if (!input.name || input.name.trim() === "") {
    refuse("kiosk_name_required", "The kiosk needs a name — name the device after its site or gate and retry");
  }
  const { token, tokenHash } = issueDeviceToken();
  const row = await withOrgTransaction(input.orgId, async () => {
    if (input.projectId) {
      await lockProjectForScope(db, input.orgId, input.projectId, input.allowedSubsidiaryIds, "share");
    } else {
      assertUnrestrictedScope(input.allowedSubsidiaryIds);
    }
    return (await db.execute<KioskRow>(sql`
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
  });
  if (!row) throw new FieldTimeError("kiosk_not_stored", "The kiosk was not stored — no row was written; retry the registration");
  return { kiosk: row, token };
}

/** Retire a kiosk: deactivated AND its token rotated so a held URL dies. */
export async function revokeKiosk(input: {
  orgId: string;
  kioskId: string;
  actorUserId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<void> {
  const { orgId, kioskId, actorUserId, allowedSubsidiaryIds } = input;
  await requireKioskFeature(orgId);
  const rotated = issueDeviceToken().tokenHash;
  await withOrgTransaction(orgId, async () => {
    const kiosk = (await db.execute<{ project_id: string | null }>(sql`
      select project_id from time_kiosks where org_id = ${orgId} and id = ${kioskId} and is_active for update`)).rows[0];
    if (!kiosk) refuse("kiosk_unknown", "The kiosk is unknown or already retired — reload the kiosk list");
    if (kiosk.project_id) {
      await lockProjectForScope(db, orgId, kiosk.project_id, allowedSubsidiaryIds, "share");
    } else {
      assertUnrestrictedScope(allowedSubsidiaryIds);
    }
    const moved = (await db.execute(sql`
      update time_kiosks
         set is_active = false, device_token_hash = ${rotated}, updated_at = now(), updated_by = ${actorUserId}
       where org_id = ${orgId} and id = ${kioskId} and is_active`)).rowCount ?? 0;
    if (moved !== 1) refuse("kiosk_unknown", "The kiosk is unknown or already retired — reload the kiosk list");
  });
}

export async function resolveKioskByToken(deviceToken: string): Promise<KioskRow> {
  const hash = hashDeviceToken(deviceToken);
  // The device token binds the kiosk but not the org: resolve the row under
  // bypass (the recruiting booking-link precedent), because a sessionless
  // device carries no org context and under FORCE RLS the unscoped read
  // below would resolve nothing — every kiosk request would 404.
  const found = await withBypassContext(async () => {
    const rows = (await db.execute<(KioskRow & { org_id: string })>(sql`
      select id::text as id, org_id::text as "orgId", org_id::text as org_id, name,
             location_id::text as "locationId", project_id::text as "projectId",
             pin_required as "pinRequired", photo_required as "photoRequired",
             is_active as "isActive", last_seen_at::text as "lastSeenAt"
        from time_kiosks where device_token_hash = ${hash}`)).rows;
    return rows[0] ?? null;
  });
  if (!found || !found.isActive) {
    refuse("kiosk_unknown", "This kiosk link is unknown or retired — ask a manager for a current kiosk link");
  }
  return withOrgTransaction(found.orgId, async () => {
    // Re-read scoped to the resolved org: the bypass row proves the token
    // exists, this read proves the kiosk belongs to this org and is live —
    // a bypass-resolved row is never trusted across orgs.
    const scoped = (await db.execute<KioskRow>(sql`
      select id::text as id, org_id::text as "orgId", name,
             location_id::text as "locationId", project_id::text as "projectId",
             pin_required as "pinRequired", photo_required as "photoRequired",
             is_active as "isActive", last_seen_at::text as "lastSeenAt"
        from time_kiosks
       where org_id = ${found.orgId} and id = ${found.id} and is_active`)).rows[0];
    if (!scoped) {
      refuse("kiosk_unknown", "This kiosk link is unknown or retired — ask a manager for a current kiosk link");
    }
    await requireKioskFeature(found.orgId);
    await db.execute(sql`update time_kiosks set last_seen_at = now() where id = ${found.id} and org_id = ${found.orgId}`);
    return scoped;
  });
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
  // The kiosk device carries no session: scope the PIN read and the lockout
  // writes to the kiosk's org, or under FORCE RLS the lookup resolves
  // nothing and every worker meets pin_not_set.
  return withOrgTransaction(input.kiosk.orgId, async () => {
    // Employment before PIN: a customer or vendor must meet not_employee,
    // never a PIN prompt — and a PIN row alone never makes someone a worker.
    if (!(await hasActiveEmployment(input.kiosk.orgId, input.employeePartyId))) {
      refuse(
        "not_employee",
        "This person has no active employment in this organization — kiosk sign-in is for employees; ask a manager to check the worker's employment",
      );
    }
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
  });
}

/** Set (or reset, clearing lockout) a worker's kiosk PIN. */
export async function setWorkerPin(input: {
  orgId: string;
  actorUserId: string;
  employeePartyId: string;
  pin: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<void> {
  await requireKioskFeature(input.orgId);
  // hashPin refuses non-numeric PINs by name before anything is stored.
  const pinHash = hashPin(input.pin);
  await withOrgTransaction(input.orgId, async () => {
    const party = (await db.execute<{ id: string }>(sql`
      select id from parties where org_id = ${input.orgId} and id = ${input.employeePartyId} and is_active for update`)).rows[0];
    if (!party) throw new ScopeNotFoundError();
    const employments = (await db.execute<{ employer_subsidiary_id: string | null }>(sql`
      select e.employer_subsidiary_id
        from worker_employments e
        join worker_employment_versions v
          on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
       where e.org_id = ${input.orgId} and e.worker_party_id = ${input.employeePartyId}
         and v.status in ('active', 'on_leave')
       order by e.id
       for update of e`)).rows;
    if (!employments.length) {
      refuse(
        "not_employee",
        "Kiosk PINs are for active employees — this person has no active employment in this organization; create the employment before setting a PIN",
      );
    }
    if (input.allowedSubsidiaryIds !== null && employments.some(({ employer_subsidiary_id }) => !employer_subsidiary_id || !input.allowedSubsidiaryIds!.has(employer_subsidiary_id))) {
      throw new ScopeNotFoundError();
    }
    // A PIN row is kiosk authority: never mint one for a non-employee, or
    // the identify check below would admit a customer or vendor.
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
