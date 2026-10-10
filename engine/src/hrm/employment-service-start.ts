import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { requireHrmEmploymentManage } from "./authorization.ts";

export class HrmServiceStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrmServiceStartError";
  }
}

export interface EmploymentServiceStart {
  readonly employmentId: string;
  readonly serviceStart: string;
  readonly provenance: string;
  readonly changed: boolean;
}

/**
 * Correct an employment's service (seniority) date. Service start governs
 * benefit waiting periods and service-based entitlements, so recognized prior
 * service may place it before the current employment episode; it can never
 * follow the first recorded employment day. Every change is audited with its
 * evidence and reason.
 */
export async function correctEmploymentServiceStart(input: {
  orgId: string; actorId: string; employmentId: string;
  serviceStart: string; evidence: string; reason: string;
}): Promise<EmploymentServiceStart> {
  if (!isIsoCalendarDate(input.serviceStart)) throw new HrmServiceStartError("Enter the service start as a real calendar date (YYYY-MM-DD).");
  const evidence = input.evidence.trim();
  const reason = input.reason.trim();
  if (!evidence) throw new HrmServiceStartError("Record the evidence for this service date, such as the original hire record.");
  if (!reason) throw new HrmServiceStartError("Record why the service date is being corrected.");
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmEmploymentManage(db, input.orgId, input.actorId, input.employmentId);
    const current = (await db.execute<{ serviceStart: string | null; provenance: string | null }>(sql`
      select service_start::text as "serviceStart", service_start_provenance as provenance from worker_employments
      where org_id=${input.orgId} and id=${input.employmentId} for update`)).rows[0];
    if (!current) throw new HrmServiceStartError("The employment was not found in this organization.");
    const firstDay = (await db.execute<{ first: string | null }>(sql`
      select min(effective_from)::text as first from worker_employment_versions
      where org_id=${input.orgId} and employment_id=${input.employmentId} and status<>'terminated'`)).rows[0]?.first ?? null;
    if (firstDay !== null && input.serviceStart > firstDay) {
      throw new HrmServiceStartError(`Service cannot start after the first recorded employment day (${firstDay}); correct the employment history first.`);
    }
    if (current.serviceStart === input.serviceStart && current.provenance === evidence) {
      return { employmentId: input.employmentId, serviceStart: input.serviceStart, provenance: evidence, changed: false };
    }
    const updated = (await db.execute<{ id: string }>(sql`update worker_employments
      set service_start=${input.serviceStart}::date, service_start_provenance=${evidence}
      where org_id=${input.orgId} and id=${input.employmentId} returning id`)).rows;
    if (updated.length !== 1) throw new HrmServiceStartError("The service date was not saved; reload the employment and retry.");
    const audited = (await db.execute<{ id: string }>(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'worker_employments', ${input.employmentId}, 'service_start_corrected',
        ${JSON.stringify({ before: { serviceStart: current.serviceStart, provenance: current.provenance },
          after: { serviceStart: input.serviceStart, provenance: evidence }, reason })}::jsonb, ${input.actorId}) returning id`)).rows;
    if (audited.length !== 1) throw new HrmServiceStartError("The service date correction could not be audited; nothing was saved.");
    return { employmentId: input.employmentId, serviceStart: input.serviceStart, provenance: evidence, changed: true };
  });
}
