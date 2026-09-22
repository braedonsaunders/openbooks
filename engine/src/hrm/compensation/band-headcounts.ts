import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { requireAggregateCompensationRead } from "../authorization.ts";
import { requireActorId, requireCivilDate, requireId, requireOrgId } from "../recruiting/input.ts";

/**
 * Fenced per-band holder counts.
 *
 * The compensation home loader shows one headcount per pay band: the
 * employments whose primary positioned assignment prices at the band's
 * level on the as-of date. Band configuration itself stays visible to
 * every compensation reader, but employee headcounts must match the
 * caller lens — an empty allowed set sees zero, never whole-org counts.
 *
 * The lens resolves inside this boundary through
 * requireAggregateCompensationRead (null = unrestricted), never a
 * caller-forged allowlist, and filters on the persisted
 * worker_employments.employer_subsidiary_id. Effective-dated semantics
 * mirror the loader's original query: primary assignment, live
 * position/employment versions at the date, active/on_leave only.
 */
export async function countBandHolders(query: {
  orgId: string;
  actorId: string;
  levelId: string;
  asOf: string;
}): Promise<number> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const levelId = requireId(query.levelId, "levelId");
  const asOf = requireCivilDate(query.asOf, "asOf");
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  if (allowed !== null && allowed.size === 0) return 0;
  // The allowlist crosses as JSON (bare JS arrays interpolate as row
  // constructors, never PostgreSQL arrays); an empty set is handled
  // above so this branch always matches at least one id when fenced.
  const row = (await db.execute<{ n: string }>(sql`
    select count(distinct aav.employment_id)::text as n
      from employment_assignment_versions aav
      join position_versions pv on pv.org_id = aav.org_id and pv.position_id = aav.position_id
       and pv.job_level_id = ${levelId}
       and pv.effective_from <= ${asOf}::date
       and (pv.effective_to is null or pv.effective_to >= ${asOf}::date)
       and pv.recorded_until is null
      join worker_employment_versions ev on ev.org_id = aav.org_id and ev.employment_id = aav.employment_id
       and ev.effective_from <= ${asOf}::date
       and (ev.effective_to is null or ev.effective_to >= ${asOf}::date)
       and ev.recorded_until is null and ev.status in ('active', 'on_leave')
      join worker_employments e on e.org_id = aav.org_id and e.id = aav.employment_id
     where aav.org_id = ${orgId} and aav.is_primary
       and aav.effective_from <= ${asOf}::date
       and (aav.effective_to is null or aav.effective_to >= ${asOf}::date)
       and aav.recorded_until is null
       and (${allowed === null}::boolean
            or e.employer_subsidiary_id in (
              select jsonb_array_elements_text(${JSON.stringify([...(allowed ?? [])])}::jsonb)::uuid
            ))`)).rows[0];
  return Number(row?.n ?? "0");
}
