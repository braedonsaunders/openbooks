import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { requireHrmCertificationsRead } from "../authorization.ts";
import { HrmQualificationError } from "./errors.ts";
import {
  HRM_CERTIFICATIONS_FEATURE,
  assertQualificationsFeature,
  requireId,
  type SqlExecutor,
} from "./shared.ts";
import { DEFAULT_ALERT_LEAD_DAYS, loadSettings } from "./types.ts";

/**
 * Expiry alerts (HR-14, hrm_qualification_alerts + notifications).
 *
 * The daily scan computes due alerts at 30/14/7/1 days by default (the
 * org's alert schedule in hrm_qualification_settings; a type's
 * renewal_lead_days overrides the schedule for that type) and writes
 * alert rows + notifications idempotently: the alert row's
 * UNIQUE(qualification_id, lead_days) is the idempotency key, and a
 * notification is written only when the row is newly inserted — so a
 * second scheduler run changes nothing. Crossing expiry writes one
 * expired_noticed event (guarded by a prior-event check under an
 * advisory scan lock, so replicas cannot double-notice).
 *
 * The person sees their own alerts on /me; the manager sees their
 * team's (holder users + line-manager users are notified; the alert
 * rows are additionally readable through the team scope). Until HR-15's
 * inbox consumes hrm_qualification_alerts, delivery is the shared
 * notifications table through the same columns writeNotification uses.
 */

export interface QualificationAlert {
  readonly id: string;
  readonly qualificationId: string;
  readonly employmentId: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly leadDays: number;
  readonly dueOn: string;
  readonly sentAt: string | null;
  readonly channel: string;
}

export interface AlertScanSummary {
  readonly orgId: string;
  readonly alertsWritten: number;
  readonly notificationsWritten: number;
  readonly expiredNoticed: number;
}

type DueRow = {
  qualification_id: string;
  employment_id: string;
  type_code: string;
  type_name: string;
  expires_on: string;
  holder_party_id: string | null;
};

function scheduleForType(
  renewalLeadDays: number,
  orgSchedule: readonly number[],
): number[] {
  // A type's lead days override the org schedule for that type; a type
  // still on a scheduled value keeps the schedule (indistinguishable
  // from explicit, and firing the schedule is correct either way).
  if (orgSchedule.includes(renewalLeadDays)) return [...orgSchedule];
  return [renewalLeadDays];
}

/** Orgs with the full alerts chain on (hrm → hrmCertifications → hrmCertificationAlerts). */
export async function listAlertEligibleOrgs(exec: SqlExecutor): Promise<string[]> {
  const rows = (await exec.execute<{ id: string }>(sql`
    select id::text as id from orgs
     where coalesce((settings->'features'->>'hrm')::boolean, false)
       and coalesce((settings->'features'->>'hrmCertifications')::boolean, false)
       and coalesce((settings->'features'->>'hrmCertificationAlerts')::boolean, false)
  `)).rows;
  return rows.map((row) => row.id);
}

/**
 * The daily scan entrypoint (worker duty). One bounded transaction per
 * eligible org: the advisory lock inside serializes same-org scanners
 * across replicas, and the org's alerts + notices commit together — a
 * failed org rolls back without touching the others.
 */
export async function runQualificationAlertScan(now: Date): Promise<AlertScanSummary[]> {
  const orgIds = await listAlertEligibleOrgs(db);
  const summaries: AlertScanSummary[] = [];
  for (const orgId of orgIds) {
    summaries.push(await scanOneOrg(orgId, now));
  }
  return summaries;
}

async function scanOneOrg(orgId: string, now: Date): Promise<AlertScanSummary> {
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    // One scanner per org at a time across replicas: the
    // expired_noticed guard below is check-then-insert, and without the
    // lock two replicas could both notice the same crossing.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hrm-qualification-alert-scan'))`);
    const today = await businessToday(orgId);
    const settings = await loadSettings(tx, orgId);
    const orgSchedule = settings.alertLeadDays.length > 0 ? settings.alertLeadDays : [...DEFAULT_ALERT_LEAD_DAYS];
    let alertsWritten = 0;
    let notificationsWritten = 0;
    let expiredNoticed = 0;
    // Stored-valid qualifications with a dated expiry. Pending rows
    // need verification, not expiry alerts; revoked rows need nothing.
    const due = (await tx.execute<DueRow & { renewal_lead_days: number }>(sql`
      select q.id::text as qualification_id, q.employment_id::text as employment_id,
             t.code as type_code, t.name as type_name,
             q.expires_on::text, t.renewal_lead_days,
             e.worker_party_id::text as holder_party_id
        from hrm_worker_qualifications q
        join hrm_qualification_types t
          on t.org_id = q.org_id and t.id = q.type_id and t.is_active
        join worker_employments e
          on e.org_id = q.org_id and e.id = q.employment_id
       where q.org_id = ${orgId}::uuid
         and q.status = 'valid'
         and q.expires_on is not null
    `)).rows;
    for (const row of due) {
      const daysLeft = daysBetween(today, row.expires_on);
      if (daysLeft < 0) {
        // Crossed expiry: one expired_noticed event, then one notice.
        const noticed = (await tx.execute<{ id: string }>(sql`
          select id from hrm_qualification_events
           where org_id = ${orgId}::uuid and qualification_id = ${row.qualification_id}::uuid
             and kind = 'expired_noticed'
           limit 1
        `)).rows[0];
        if (noticed) continue;
        await tx.execute(sql`
          insert into hrm_qualification_events
            (org_id, qualification_id, kind, reason)
          values (${orgId}::uuid, ${row.qualification_id}::uuid, 'expired_noticed',
                  ${`${row.type_name} expired ${row.expires_on} while still held — renew it or remove the worker from gated work.`})
        `);
        expiredNoticed += 1;
        notificationsWritten += await notifyHolders(
          tx, orgId, row,
          `Qualification expired — ${row.type_name}`,
          `${row.type_name} expired ${row.expires_on}. Renew it before gated work is refused.`,
          "/hrm/qualifications",
        );
        continue;
      }
      const schedule = scheduleForType(row.renewal_lead_days, orgSchedule);
      if (!schedule.includes(daysLeft)) continue;
      // The UNIQUE(qualification_id, lead_days) is the idempotency key:
      // a re-run hits the conflict arm and changes nothing — and the
      // notification below fires only on a fresh insert.
      const alertId = (await tx.execute<{ id: string }>(sql`
        insert into hrm_qualification_alerts
          (org_id, qualification_id, lead_days, due_on, channel, created_by)
        values (${orgId}::uuid, ${row.qualification_id}::uuid, ${daysLeft},
                ${row.expires_on}::date, 'inbox', null)
        on conflict (qualification_id, lead_days) do nothing
        returning id
      `)).rows[0]?.id;
      if (!alertId) continue;
      alertsWritten += 1;
      await tx.execute(sql`
        update hrm_qualification_alerts set sent_at = now()
         where id = ${alertId}::uuid
      `);
      notificationsWritten += await notifyHolders(
        tx, orgId, row,
        `Qualification expiring — ${row.type_name}`,
        `${row.type_name} expires ${row.expires_on} (${daysLeft} days). Renew it before gated work is refused.`,
        "/hrm/qualifications",
      );
    }
    void now;
    return { orgId, alertsWritten, notificationsWritten, expiredNoticed };
  });
}

function daysBetween(todayYmd: string, laterYmd: string): number {
  const ms = Date.parse(`${laterYmd}T00:00:00Z`) - Date.parse(`${todayYmd}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * Notify the holder's users plus their line managers' users. Returns
 * the notification count. Users missing (no login for the party) mean
 * the alert row still exists for /me and team reads — sent_at is set
 * because the alert itself is recorded; delivery follows the login.
 */
async function notifyHolders(
  exec: SqlExecutor,
  orgId: string,
  row: DueRow,
  title: string,
  body: string,
  href: string,
): Promise<number> {
  if (!row.holder_party_id) return 0;
  const holders = (await exec.execute<{ id: string }>(sql`
    select id::text as id from users
     where org_id = ${orgId}::uuid and party_id = ${row.holder_party_id}::uuid
  `)).rows;
  // The holder's line managers as of today (same structural predicate
  // as loadTeamEmploymentIdsForManager, inverted: holder → managers).
  const today = await businessToday(orgId);
  const managerPartyIds = (await exec.execute<{ party_id: string }>(sql`
    select distinct m.worker_party_id::text as party_id
      from reporting_relationships r
      join worker_employments holder
        on holder.org_id = r.org_id and holder.id = r.employment_id
      join worker_employments m
        on m.org_id = r.org_id and m.id = r.manager_employment_id
     where r.org_id = ${orgId}::uuid
       and holder.worker_party_id = ${row.holder_party_id}::uuid
       and r.kind = 'line' and r.recorded_until is null
       and r.effective_from <= ${today}::date
       and (r.effective_to is null or r.effective_to > ${today}::date)
  `)).rows;
  let managerUserIds: { id: string }[] = [];
  if (managerPartyIds.length > 0) {
    managerUserIds = (await exec.execute<{ id: string }>(sql`
      select id::text as id from users
       where org_id = ${orgId}::uuid
         and party_id in (select jsonb_array_elements_text(${JSON.stringify(managerPartyIds.map((r) => r.party_id))}::jsonb)::uuid)
    `)).rows;
  }
  const userIds = [...new Set([...holders, ...managerUserIds].map((u) => u.id))];
  let count = 0;
  for (const userId of userIds) {
    // Same columns as the shared writeNotification path (kind, title,
    // body, href, org + user scope): the row surfaces in /notifications
    // and as an inbox item with zero extra plumbing.
    const inserted = (await exec.execute<{ id: string }>(sql`
      insert into notifications (org_id, user_id, kind, title, body, href)
      values (${orgId}::uuid, ${userId}::uuid, 'hrm_qualification_expiry',
              ${title}, ${body}, ${href})
      returning id
    `)).rows[0]?.id;
    if (!inserted) {
      throw new HrmQualificationError("The expiry notice was not stored — no row was written; retry the action.");
    }
    count += 1;
  }
  return count;
}

export interface ListAlertsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId?: string;
  readonly unsentOnly?: boolean;
}

export async function listAlerts(
  exec: SqlExecutor,
  input: ListAlertsInput,
): Promise<QualificationAlert[]> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  await requireHrmCertificationsRead(exec, orgId, actorId);
  await assertQualificationsFeature(exec, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification alerts");
  const rows = (await exec.execute<{
    id: string;
    qualification_id: string;
    employment_id: string;
    type_code: string;
    type_name: string;
    lead_days: number;
    due_on: string;
    sent_at: string | null;
    channel: string;
  }>(sql`
    select a.id::text as id, a.qualification_id::text as qualification_id,
           q.employment_id::text as employment_id,
           t.code as type_code, t.name as type_name,
           a.lead_days, a.due_on::text, a.sent_at::text, a.channel
      from hrm_qualification_alerts a
      join hrm_worker_qualifications q
        on q.org_id = a.org_id and q.id = a.qualification_id
      join hrm_qualification_types t
        on t.org_id = a.org_id and t.id = q.type_id
     where a.org_id = ${orgId}::uuid
       and (${input.employmentId ?? null}::uuid is null or q.employment_id = ${input.employmentId ?? null}::uuid)
       and (${input.unsentOnly !== true}::boolean or a.sent_at is null)
     order by a.due_on, t.code
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    qualificationId: row.qualification_id,
    employmentId: row.employment_id,
    typeCode: row.type_code,
    typeName: row.type_name,
    leadDays: row.lead_days,
    dueOn: row.due_on,
    sentAt: row.sent_at,
    channel: row.channel,
  }));
}

export { db };
