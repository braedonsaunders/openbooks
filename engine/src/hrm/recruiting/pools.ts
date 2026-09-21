import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManageOrg } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { isUniqueViolation, requireActorId, requireId, requireOrgId } from "./input.ts";
import { pgTextArray, requireDepthFeature } from "./depth.ts";

/**
 * Canonical talent-pool service (HR-18, 0229): named pools of past
 * candidates with tag-based rediscovery.
 *
 * - Pools are Setup-flavored configuration (deactivation is deletion here:
 *   a pool with no members deletes cleanly; members follow the pool).
 * - Membership is UNIQUE per (pool, candidate) — storage backstops the
 *   double-add race, and the service names the remedy.
 * - rediscover matches pool members to an OPEN requisition by DECLARED
 *   tags (candidate.tags ∩ requisition tags): a read, never a write, and
 *   deliberately no AI (HR-21 owns ranking). It returns names only for
 *   holders of the read grant — contact PII never rides this shape.
 */

export interface TalentPoolDTO {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly memberCount: number;
}

export type PoolMemberDTO = {
  readonly candidateId: string;
  readonly displayName: string;
  readonly tags: readonly string[];
  readonly addedAt: string;
  readonly note: string | null;
}

export interface RediscoveryMatch {
  readonly candidateId: string;
  readonly displayName: string;
  readonly matchedTags: readonly string[];
  readonly memberNote: string | null;
}

type PoolRow = {
  id: string;
  name: string;
  description: string | null;
};

function requirePoolName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a talent pool needs a non-blank name — name the bench it holds");
  }
  return name.trim();
}

async function memberCount(exec: SqlExecutor, orgId: string, poolId: string): Promise<number> {
  const row = (await exec.execute<{ count: string }>(sql`
    select count(*)::text as count from hrm_talent_pool_members
     where org_id = ${orgId} and pool_id = ${poolId}
  `)).rows[0];
  return Number(row?.count ?? 0);
}

export async function listTalentPools(query: {
  orgId: string;
  actorId: string;
}): Promise<readonly TalentPoolDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    const rows = (await db.execute<PoolRow>(sql`
      select id, name, description from hrm_talent_pools where org_id = ${orgId} order by name
    `)).rows;
    return Promise.all(
      rows.map(async (row) => ({ ...row, memberCount: await memberCount(db, orgId, row.id) })),
    );
  });
}

export async function createTalentPool(query: {
  orgId: string;
  actorId: string;
  name: unknown;
  description?: unknown;
}): Promise<TalentPoolDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const name = requirePoolName(query.name);
  const description =
    query.description == null || String(query.description).trim().length === 0
      ? null
      : String(query.description);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    try {
      const row = (await db.execute<PoolRow>(sql`
        insert into hrm_talent_pools (org_id, name, description, created_by, updated_by)
        values (${orgId}, ${name}, ${description}, ${actorId}, ${actorId})
        returning id, name, description
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the pool was not stored — no row was written; retry the request");
      return { ...row, memberCount: 0 };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          `a talent pool named ${name} already exists — add to the existing pool instead of duplicating it`,
        );
      }
      throw error;
    }
  });
}

export async function deleteTalentPool(query: {
  orgId: string;
  actorId: string;
  poolId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const poolId = requireId(query.poolId, "poolId");
  await withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    // Memberships follow the pool (CASCADE); the candidates themselves are
    // untouched — deleting a pool never deletes a person.
    const deleted = (await db.execute<{ id: string }>(sql`
      delete from hrm_talent_pools where org_id = ${orgId} and id = ${poolId} returning id
    `)).rows[0];
    if (!deleted) {
      throw new RecruitingError("NOT_FOUND", "talent pool is not visible in this organization — it may belong to another org");
    }
  });
}

function requireTags(tags: unknown, what: string): string[] {
  if (!Array.isArray(tags)) {
    throw new RecruitingError("INVALID_INPUT", `${what} tags must be a list of strings — declare the tags explicitly`);
  }
  const cleaned = tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0);
  return [...new Set(cleaned)];
}

export async function addPoolMember(query: {
  orgId: string;
  actorId: string;
  poolId: string;
  candidateId: string;
  note?: unknown;
}): Promise<PoolMemberDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const poolId = requireId(query.poolId, "poolId");
  const candidateId = requireId(query.candidateId, "candidateId");
  const note =
    query.note == null || String(query.note).trim().length === 0 ? null : String(query.note);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    const pool = (await db.execute<{ one: number }>(sql`
      select 1 as one from hrm_talent_pools where org_id = ${orgId} and id = ${poolId}
    `)).rows[0];
    if (!pool) throw new RecruitingError("NOT_FOUND", "talent pool is not visible in this organization");
    const candidate = (await db.execute<{ displayName: string; tags: string[] }>(sql`
      select display_name as "displayName", tags from hrm_candidates
       where org_id = ${orgId} and id = ${candidateId}
    `)).rows[0];
    if (!candidate) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
    }
    try {
      const row = (await db.execute<{ addedAt: string }>(sql`
        insert into hrm_talent_pool_members (org_id, pool_id, candidate_id, added_by, note)
        values (${orgId}, ${poolId}, ${candidateId}, ${actorId}, ${note})
        returning added_at as "addedAt"
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the membership was not stored — no row was written; retry the request");
      return {
        candidateId,
        displayName: candidate.displayName,
        tags: candidate.tags ?? [],
        addedAt: row.addedAt,
        note,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          "this candidate is already in that pool — one membership per (pool, candidate); update the note instead of re-adding",
        );
      }
      throw error;
    }
  });
}

export async function removePoolMember(query: {
  orgId: string;
  actorId: string;
  poolId: string;
  candidateId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const poolId = requireId(query.poolId, "poolId");
  const candidateId = requireId(query.candidateId, "candidateId");
  await withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    const removed = (await db.execute<{ id: string }>(sql`
      delete from hrm_talent_pool_members
       where org_id = ${orgId} and pool_id = ${poolId} and candidate_id = ${candidateId}
      returning id
    `)).rows[0];
    if (!removed) {
      throw new RecruitingError("NOT_FOUND", "that membership does not exist — the candidate may already have been removed from the pool");
    }
  });
}

export async function listPoolMembers(query: {
  orgId: string;
  actorId: string;
  poolId: string;
}): Promise<readonly PoolMemberDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const poolId = requireId(query.poolId, "poolId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    const rows = (await db.execute<PoolMemberDTO>(sql`
      select m.candidate_id as "candidateId", c.display_name as "displayName",
             c.tags as tags, m.added_at as "addedAt", m.note as note
        from hrm_talent_pool_members m
        join hrm_candidates c on c.org_id = m.org_id and c.id = m.candidate_id
       where m.org_id = ${orgId} and m.pool_id = ${poolId}
       order by c.display_name
    `)).rows;
    return rows;
  });
}

export async function tagCandidate(query: {
  orgId: string;
  actorId: string;
  candidateId: string;
  tags: unknown;
}): Promise<readonly string[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const candidateId = requireId(query.candidateId, "candidateId");
  const tags = requireTags(query.tags, "candidate");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    const updated = (await db.execute<{ tags: string[] }>(sql`
      update hrm_candidates
         set tags = ${pgTextArray(tags)}::text[], updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${candidateId}
      returning tags
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization — it may belong to another org");
    }
    return updated.tags ?? [];
  });
}

/**
 * Rediscovery: match pool members to an OPEN requisition by declared tags.
 * A read that returns names + matched tags only — no contact PII, no
 * scoring, no AI. Empty requisition tags match nothing (tag the opening
 * before rediscovering it).
 */
export async function rediscoverForRequisition(query: {
  orgId: string;
  actorId: string;
  poolId: string;
  requisitionId: string;
  requisitionTags: unknown;
}): Promise<readonly RediscoveryMatch[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const poolId = requireId(query.poolId, "poolId");
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  const wanted = requireTags(query.requisitionTags, "requisition");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmTalentPool");
    const requisition = (await db.execute<{ status: string }>(sql`
      select status from hrm_requisitions where org_id = ${orgId} and id = ${requisitionId}
    `)).rows[0];
    if (!requisition) {
      throw new RecruitingError("NOT_FOUND", "requisition is not visible in this organization");
    }
    if (requisition.status !== "open") {
      throw new RecruitingError(
        "REFUSED",
        `a ${requisition.status} requisition takes no rediscovery — open it before matching the pool against it`,
      );
    }
    if (wanted.length === 0) {
      throw new RecruitingError(
        "INVALID_INPUT",
        "rediscovery matches on declared tags — tag the opening before matching the pool against it",
      );
    }
    const pool = (await db.execute<{ one: number }>(sql`
      select 1 as one from hrm_talent_pools where org_id = ${orgId} and id = ${poolId}
    `)).rows[0];
    if (!pool) throw new RecruitingError("NOT_FOUND", "talent pool is not visible in this organization");
    const members = (await db.execute<{
      candidateId: string;
      displayName: string;
      tags: string[];
      note: string | null;
    }>(sql`
      select m.candidate_id as "candidateId", c.display_name as "displayName",
             c.tags as tags, m.note as note
        from hrm_talent_pool_members m
        join hrm_candidates c on c.org_id = m.org_id and c.id = m.candidate_id
       where m.org_id = ${orgId} and m.pool_id = ${poolId}
    `)).rows;
    const wantedSet = new Set(wanted.map((tag) => tag.toLowerCase()));
    return members
      .map((member) => {
        const matched = (member.tags ?? []).filter((tag) => wantedSet.has(tag.toLowerCase()));
        return {
          candidateId: member.candidateId,
          displayName: member.displayName,
          matchedTags: matched,
          memberNote: member.note,
        };
      })
      .filter((match) => match.matchedTags.length > 0)
      .sort((a, b) => b.matchedTags.length - a.matchedTags.length || a.displayName.localeCompare(b.displayName));
  });
}

/** Pure tag-overlap core for unit tests. */
export function matchTags(candidateTags: readonly string[], wantedTags: readonly string[]): readonly string[] {
  const wanted = new Set(wantedTags.map((tag) => tag.toLowerCase()));
  return candidateTags.filter((tag) => wanted.has(tag.toLowerCase()));
}
