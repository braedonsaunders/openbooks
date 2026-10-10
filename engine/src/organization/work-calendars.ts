import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { isIsoCalendarDate } from '../platform/iso-date.ts';
import { canonicalJson } from '../platform/canonical-json.ts';
import { lockActorCommandAuthority } from './actor-command-authority.ts';
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from './org-feature-lock.ts';

export class WorkCalendarError extends Error {
  constructor(message: string, readonly status = 422, readonly code = 'work_calendar_refused', readonly remedy = 'Review Work calendars in Company Setup.') {
    super(message); this.name = 'WorkCalendarError';
  }
}
export interface WorkCalendarInput {
  id: string; name: string; description?: string | null; workingDays: Record<string, boolean>;
  holidays: string[]; isDefault: boolean; reason: string; expectedRevision?: string;
}
type Calendar = { id: string; name: string; description: string | null; workingDays: Record<string, boolean>; holidays: string[]; isDefault: boolean; revision: string };
const columns = sql`id,name,description,working_days as "workingDays",holidays,is_default as "isDefault",xmin::text as revision`;

async function authority(tx: SqlExecutor, orgId: string, actorId: string) {
  if (!isUuid(actorId) || !(await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows.length)
    throw new WorkCalendarError('Work calendar not found.', 404, 'not_found');
  if (await lockActorCommandAuthority(tx, orgId, actorId, null, 'admin.setup.manage') !== null)
    throw new WorkCalendarError('Company calendars require access to every legal entity.', 404, 'not_found');
  await acquireOrgFeatureGateLock(tx, orgId);
  const manufacturing = await lockAndCheckOrgFeature(tx, orgId, 'manufacturing');
  const scheduling = await lockAndCheckOrgFeature(tx, orgId, 'projectScheduling');
  if (!manufacturing && !scheduling) throw new WorkCalendarError('Work calendars are unavailable.', 404, 'feature_disabled', 'Enable Manufacturing or Project Scheduling in Company Settings → Features.');
}

/** Shared company calendars use the existing schedule records; project-owned calendars retain their project editor. */
export async function saveCompanyWorkCalendar(tx: SqlExecutor, orgId: string, actorId: string, raw: WorkCalendarInput): Promise<Calendar & { replayed: boolean }> {
  await authority(tx, orgId, actorId);
  if (!isUuid(raw.id) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 120
    || typeof raw.reason !== 'string' || raw.reason.trim().length < 5 || raw.reason.trim().length > 500
    || typeof raw.isDefault !== 'boolean' || raw.description != null && (typeof raw.description !== 'string' || raw.description.length > 2000)
    || !raw.workingDays || Array.isArray(raw.workingDays) || Object.keys(raw.workingDays).length !== 7
    || !['0','1','2','3','4','5','6'].every(day => typeof raw.workingDays[day] === 'boolean')
    || !Array.isArray(raw.holidays) || raw.holidays.length > 1000 || raw.holidays.some(day => !isIsoCalendarDate(day))
    || raw.expectedRevision !== undefined && !/^\d+$/.test(raw.expectedRevision))
    throw new WorkCalendarError('Provide a name, all seven weekday choices, valid closure dates, and a reason of 5–500 characters.');
  const input = { name: raw.name.trim(), description: raw.description?.trim() || null, workingDays: raw.workingDays, holidays: [...new Set(raw.holidays)].sort(), isDefault: raw.isDefault };
  // Serialize default selection within the company, including concurrent first calendars.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks.company-work-calendar:${orgId}`},0))`);
  const before = (await tx.execute<Calendar>(sql`select ${columns} from schedule_calendars where org_id=${orgId} and id=${raw.id} and project_id is null for update`)).rows[0];
  if (!before && (await tx.execute(sql`select id from schedule_calendars where org_id=${orgId} and id=${raw.id} and project_id is not null`)).rows.length)
    throw new WorkCalendarError('Company work calendar not found.',404,'not_found','Edit project-specific calendars from their project schedule.');
  if (raw.expectedRevision === undefined && before) {
    const original = (await tx.execute<{ request: unknown }>(sql`select changes->'request' as request from audit_log where org_id=${orgId} and table_name='schedule_calendars' and row_id=${raw.id} and action='insert' order by at,id limit 1`)).rows[0];
    if (!original || canonicalJson(original.request) !== canonicalJson({ ...input, reason: raw.reason.trim() }))
      throw new WorkCalendarError('This creation key already belongs to a different calendar request.', 409, 'work_calendar_idempotency_conflict', 'Reload the original calendar or start a new calendar.');
    return { ...before, replayed: true };
  }
  if (raw.expectedRevision !== undefined && (!before || before.revision !== raw.expectedRevision))
    throw new WorkCalendarError('The calendar changed after it was opened.', 409, 'work_calendar_stale', 'Reload the current calendar before saving your changes.');
  if (raw.isDefault) {
    const priorDefaults = (await tx.execute<Calendar>(sql`select ${columns} from schedule_calendars where org_id=${orgId} and project_id is null and is_default and id<>${raw.id} order by id for update`)).rows;
    for (const previous of priorDefaults) {
      const cleared = (await tx.execute<Calendar>(sql`update schedule_calendars set is_default=false,updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${previous.id} and project_id is null and is_default returning ${columns}`)).rows[0];
      if (!cleared) throw new WorkCalendarError('The previous default could not be changed.', 409, 'work_calendar_stale', 'Reload and retry; no calendar changed.');
      await audit(tx, orgId, actorId, previous.id, previous, cleared, raw.reason.trim());
    }
  }
  const after = before
    ? (await tx.execute<Calendar>(sql`update schedule_calendars set name=${input.name},description=${input.description},working_days=${JSON.stringify(input.workingDays)}::jsonb,holidays=${JSON.stringify(input.holidays)}::jsonb,is_default=${input.isDefault},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${raw.id} and project_id is null returning ${columns}`)).rows[0]
    : (await tx.execute<Calendar>(sql`insert into schedule_calendars(id,org_id,name,description,working_days,holidays,is_default,created_by,updated_by) values(${raw.id},${orgId},${input.name},${input.description},${JSON.stringify(input.workingDays)}::jsonb,${JSON.stringify(input.holidays)}::jsonb,${input.isDefault},${actorId},${actorId}) returning ${columns}`)).rows[0];
  if (!after) throw new WorkCalendarError('The calendar was not saved.', 409, 'work_calendar_write_failed', 'Reload and retry; no calendar changed.');
  await audit(tx, orgId, actorId, raw.id, before ?? null, after, raw.reason.trim(), before ? undefined : { ...input, reason: raw.reason.trim() });
  return { ...after, replayed: false };
}

async function audit(tx: SqlExecutor, orgId: string, actorId: string, id: string, before: unknown, after: unknown, reason: string, request?: unknown) {
  const written = await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'schedule_calendars',${id},${before === null ? 'insert' : 'update'},${JSON.stringify({ before, after, reason, ...(request ? { request } : {}) })}::jsonb,${actorId}) returning id`);
  if (written.rows.length !== 1) throw new WorkCalendarError('The calendar audit was not saved.', 409, 'work_calendar_write_failed', 'Retry; no calendar changed.');
}
