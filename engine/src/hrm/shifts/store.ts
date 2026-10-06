import { sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { canonicalJson, NonJsonValueError } from "../../platform/canonical-json.ts";
import { db, withOrgTransaction, withTransactionSavepoint } from "../../platform/db.ts";
import { lockActorCommandAuthority } from "../../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import { HrmAuthorizationError, lockEmploymentsForScope } from "../authorization.ts";
import { ShiftError, requireUuid } from "./policy.ts";

export interface ShiftActor { readonly orgId: string; readonly actorId: string }
export type ShiftPermission = "hrm.shifts.read" | "hrm.shifts.manage" | "hrm.shifts.approve" | "hrm.attendance.read" | "hrm.attendance.manage" | "hrm.self.read" | "hrm.self.request";
export type ShiftTable = "hrm_shift_templates" | "hrm_shift_assignments" | "hrm_shift_publications" | "hrm_shifts" | "hrm_shift_requests"
  | "hrm_attendance_devices" | "hrm_attendance_identities" | "hrm_attendance_batches" | "hrm_attendance_events" | "hrm_attendance_watermarks"
  | "hrm_attendance_observations" | "hrm_attendance_event_claims" | "hrm_attendance_observation_events";
export function requestHash(value: unknown): string {
  try { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
  catch (error) {
    if (error instanceof NonJsonValueError) throw new ShiftError("Roster input contains an undeclared source value — use finite whole-second controls and ordinary declared record values before saving.");
    throw error;
  }
}
export function shiftText(value: unknown, field: string, maximum = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new ShiftError(`${field} needs 1 through ${maximum} characters — enter the actual declared value.`);
  return value.trim();
}
export function shiftInteger(value: unknown, field: string, maximum = 2147483647, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new ShiftError(`${field} needs a whole number from ${minimum} through ${maximum} — review the declared value.`);
  return value as number;
}
export function one<T>(rows: T[]): T {
  if (rows.length !== 1) throw new ScopeNotFoundError();
  return rows[0]!;
}
export function expectedRevision(row: { revision: number }, expected: unknown): void {
  if (row.revision !== shiftInteger(expected, "Expected revision", 2147483647, 1)) throw new ShiftError("Roster revision changed — reload the record and review its current state before saving.");
}

/** Commands join the caller's tenant transaction; refusals roll back the complete command. */
export async function shiftTransaction<T>(actor: ShiftActor, command: () => Promise<T>): Promise<T> {
  requireUuid(actor.orgId, "Organization"); requireUuid(actor.actorId, "Actor");
  try { return await withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, command)); }
  catch (error) {
    if (error instanceof HrmAuthorizationError) throw new ScopeNotFoundError();
    const seen = new Set<object>(); let cause: unknown = error;
    while (cause && typeof cause === "object" && !seen.has(cause)) {
      seen.add(cause);
      const detail = cause as { code?: string; constraint?: string; message?: string; where?: string; cause?: unknown };
      if (detail.code === "42P01" && /hrm_(?:shift|attendance)/.test(detail.message ?? "")) throw new ShiftError("Shift planning requires the database upgrade — ask an administrator to complete the roster and attendance migration before using this workspace.");
      if (detail.code === "P0001" && /PL\/pgSQL function (?:public\.)?hrm_shift_/.test(detail.where ?? "") && detail.message) throw new ShiftError(detail.message);
      if (detail.constraint?.startsWith("hrm_shift") || detail.constraint?.startsWith("hrm_attendance")) {
        if (detail.code === "23505" || detail.code === "23P01") throw new ShiftError("A roster version, assignment interval, shift or device identity conflicts with an existing record — reload the native register and resolve the conflicting record before retrying.");
        if (detail.code === "23503") throw new ShiftError("A roster reference is unavailable for this organization and employer — reload and select its native record again.");
        if (detail.code === "23514") throw new ShiftError("Roster data violates its declared interval, lifecycle or evidence rules — review the record dates and required source values before saving.");
      }
      if (detail.code === "40001" || detail.code === "40P01") throw new ShiftError("Roster configuration changed during this command — reload and retry; no part of this command was saved.");
      cause = detail.cause;
    }
    throw error;
  }
}
export async function shiftAuthority(actor: ShiftActor, permission: ShiftPermission, subsidiaryId: string | null = null) {
  const scope = await lockActorCommandAuthority(db, actor.orgId, actor.actorId, subsidiaryId, permission);
  const attendance = permission.startsWith("hrm.attendance."), feature = attendance ? "hrmAttendance" : "hrmShiftPlanning";
  if (!await lockAndCheckOrgFeature(db, actor.orgId, "hrm") || !await lockAndCheckOrgFeature(db, actor.orgId, feature)) throw new ShiftError(`${attendance ? "Device attendance" : "Shift planning"} is disabled — enable HRM and ${attendance ? "Device attendance" : "Shift planning"} on Company Settings → Features; existing history is preserved.`);
  return scope;
}
export async function authorParty(actor: ShiftActor): Promise<string> {
  const row = one((await db.execute<{ partyId: string | null }>(sql`select party_id as "partyId" from users where org_id=${actor.orgId} and id=${actor.actorId} and is_active for share`)).rows);
  if (!row.partyId) throw new ShiftError("Roster authorship needs a native person identity — link your user to its person record before creating the request.");
  return row.partyId;
}
export async function shiftEmployment(actor: ShiftActor, employmentId: string, permission: ShiftPermission) {
  await shiftAuthority(actor, permission);
  const subject = one(await lockEmploymentsForScope(db, [requireUuid(employmentId, "Employment")], actor));
  await shiftAuthority(actor, permission, subject.employerSubsidiaryId);
  return subject;
}
export async function scopedRow<T extends Record<string, unknown> & { subsidiaryId: string }>(actor: ShiftActor, table: ShiftTable, id: string, columns: SQL, permission: ShiftPermission, write: boolean | "none"): Promise<T> {
  const scope = await shiftAuthority(actor, permission);
  const row = one((await db.execute<T>(sql`select ${columns} from ${sql.identifier(table)} where org_id=${actor.orgId} and id=${requireUuid(id, "Record")}
    ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)} ${write === "none" ? sql`` : write ? sql`for update` : sql`for share`}`)).rows) as T;
  await shiftAuthority(actor, permission, row.subsidiaryId);
  return row;
}
/** A caller-held UUID identifies one creation payload and actor across retries. */
export async function creationReplay<T>(actor: ShiftActor, table: ShiftTable, id: string, hash: string, columns: SQL): Promise<T | null> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`roster-create:${actor.orgId}:${id}`},0))`);
  const row = (await db.execute<T & { requestHash: string; createdBy: string }>(sql`select ${columns},request_hash as "requestHash",created_by as "createdBy"
    from ${sql.identifier(table)} where org_id=${actor.orgId} and id=${id}`)).rows[0];
  if (!row) return null;
  if (row.requestHash !== hash || row.createdBy !== actor.actorId) throw new ShiftError("This roster request key already has different content — reopen the creation form for a new request; the existing record is preserved.");
  const { requestHash: _hash, ...result } = row;
  return result as T;
}
export { db, sql, subsidiaryVisibleFilter };
