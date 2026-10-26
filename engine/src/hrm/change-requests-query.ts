import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { HrmChangeRequestError } from "./change-requests-payload.ts";
import {
  type RequestRow,
  type ChangeRequestDTO,
  toDTO,
  REQUEST_COLUMNS,
  requireOrgId,
  requireActorId,
  requireId,
  requireRequestReadAccess,
} from "./change-requests-core.ts";

export interface GetChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
}

/** Read one request; the kind-aware read gate owns visibility. */
export async function getChangeRequest(query: GetChangeRequestQuery): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  return withOrgTransaction(orgId, async () => {
    const rows = await db.execute<RequestRow>(
      sql`
      select ${REQUEST_COLUMNS} from hrm_employment_change_requests
       where org_id = ${orgId} and id = ${requestId}
    `,
      "objects",
    );
    const row = rows[0];
    if (!row) {
      throw new HrmChangeRequestError(
        "NOT_FOUND",
        "employment change request not found in this organization — check the request id",
      );
    }
    await requireRequestReadAccess(db, orgId, actorId, row.employment_id, row.payload);
    return toDTO(row);
  });
}

export interface ListChangeRequestsQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId?: string;
  readonly status?: string;
  readonly limit?: number;
}

const LIST_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "withdrawn",
  "applied",
] as const;

function invalidStatusError(status: unknown): HrmChangeRequestError {
  return new HrmChangeRequestError(
    "INVALID_PAYLOAD",
    `unknown request status ${JSON.stringify(status)} — filter by one of ${LIST_STATUSES.join(", ")}`,
  );
}

/**
 * Visibility predicates shared by the list and the count, over the same
 * `r` (request) / `e` (employment) aliases: restricted HR sees only its
 * legal entities, plus its own profile proposals when self-service read is
 * granted. A count that filtered differently would disagree with the rows
 * it claims to count, so both queries resolve scope here.
 */
async function resolveRequestScope(orgId: string, actorId: string) {
  const canReadEmployment = await actorHasPermission(db, orgId, actorId, "hrm.employment.read");
  const canReadOwnProfile = await actorHasPermission(db, orgId, actorId, "hrm.self.read");
  if (!canReadEmployment && !canReadOwnProfile) {
    throw new HrmAuthorizationError(
      "Employment access requires the hrm.employment.read permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  const allowedSubsidiaries = await actorAllowedSubsidiaryIds(db, orgId, actorId);
  const partyId = canReadOwnProfile
    ? ((
        await db.execute<{ party_id: string | null }>(
          sql`
        select party_id::text as party_id from users where org_id = ${orgId} and id = ${actorId}`,
          "objects",
        )
      )[0]?.party_id ?? null)
    : null;
  const employerFilter =
    allowedSubsidiaries === null
      ? sql`true`
      : allowedSubsidiaries.size === 0
        ? sql`false`
        : sql`e.employer_subsidiary_id = any(${`{${[...allowedSubsidiaries].join(",")}}`}::uuid[])`;
  return {
    subsidiaryFilter: canReadEmployment ? employerFilter : sql`false`,
    ownProfileFilter:
      partyId === null
        ? sql`false`
        : sql`(r.payload ->> 'kind' in ('profile_change', 'bank_change')
             and e.worker_party_id = ${partyId}::uuid and ${employerFilter})`,
  };
}

function requestVisibilityWhere(
  query: CountChangeRequestsQuery,
  orgId: string,
  scope: Awaited<ReturnType<typeof resolveRequestScope>>,
) {
  return sql`r.org_id = ${orgId}
    ${query.employmentId ? sql`and r.employment_id = ${query.employmentId}` : sql``}
    ${query.status ? sql`and r.status = ${query.status}` : sql``}
    and exists (
      select 1 from worker_employments e
      where e.org_id = r.org_id and e.id = r.employment_id
        and (${scope.subsidiaryFilter} or ${scope.ownProfileFilter})
    )`;
}

function requestListLimit(query: ListChangeRequestsQuery): number {
  if (query.status !== undefined && !(LIST_STATUSES as readonly string[]).includes(query.status)) {
    throw invalidStatusError(query.status);
  }
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new HrmChangeRequestError("INVALID_PAYLOAD", "limit must be an integer from 1 to 500");
  }
  return limit;
}

/**
 * List requests newest-first with access predicates applied before the
 * limit. Restricted HR sees only its legal entities, plus its own profile
 * proposals when self-service read is granted.
 */
export async function listChangeRequests(
  query: ListChangeRequestsQuery,
): Promise<ChangeRequestDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const limit = requestListLimit(query);
  return withOrgTransaction(orgId, async () => {
    const scope = await resolveRequestScope(orgId, actorId);
    const rows = await db.execute<RequestRow>(
      sql`
      select ${REQUEST_COLUMNS} from hrm_employment_change_requests r
       where ${requestVisibilityWhere(query, orgId, scope)}
       order by r.created_at desc, r.id desc
       limit ${limit}
    `,
      "objects",
    );
    return rows.map(toDTO);
  });
}

export interface CountChangeRequestsQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId?: string;
  readonly status?: string;
}

/**
 * Exact scope-checked total for a status-filtered queue figure. The
 * dashboard pending tile must not count a bounded preview whose older rows
 * can fall outside the fetch window; this shares resolveRequestScope with
 * the list so the total can never disagree with the rows about visibility.
 */
export async function countChangeRequests(query: CountChangeRequestsQuery): Promise<number> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (query.status !== undefined && !(LIST_STATUSES as readonly string[]).includes(query.status)) {
    throw invalidStatusError(query.status);
  }
  return withOrgTransaction(orgId, async () => {
    const scope = await resolveRequestScope(orgId, actorId);
    const rows = await db.execute<{ n: string }>(
      sql`
      select count(*) as n from hrm_employment_change_requests r
       where ${requestVisibilityWhere(query, orgId, scope)}
    `,
      "objects",
    );
    return Number(rows[0]?.n ?? 0);
  });
}

/** One scoped statement resolves the exact queue total and its bounded preview. */
export async function listChangeRequestsWithTotal(
  query: ListChangeRequestsQuery,
): Promise<{ rows: ChangeRequestDTO[]; total: number }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const limit = requestListLimit(query);
  return withOrgTransaction(orgId, async () => {
    const scope = await resolveRequestScope(orgId, actorId);
    const result = await db.execute<{ n: string; rows: RequestRow[] }>(
      sql`
      with visible as materialized (
        select r.id, r.created_at from hrm_employment_change_requests r
        where ${requestVisibilityWhere(query, orgId, scope)}
      ), page as (
        select ${REQUEST_COLUMNS} from hrm_employment_change_requests r
        where r.org_id = ${orgId} and r.id in (
          select id from visible order by created_at desc, id desc limit ${limit}
        )
      )
      select (select count(*)::text from visible) as n,
        coalesce((select jsonb_agg(to_jsonb(page) order by page.created_at desc, page.id desc)
          from page), '[]'::jsonb) as rows
    `,
      "objects",
    );
    const row = result[0];
    if (!row)
      throw new HrmChangeRequestError("REFUSED", "change request queue could not be resolved");
    return { total: Number(row.n), rows: row.rows.map(toDTO) };
  });
}

// --- Release: decide (flip + snapshot) and apply (canonical writes) ---------
//
// Called by the flows adapter's releaseApproval INSIDE the decide savepoint,
// so any throw rolls the gate flip, the decision snapshot, and every
// canonical write back together and the gate stays pending. A request that
// already left pending_approval is a no-op (idempotent release contract in
// flows/types.ts): the first resolution won and this retry changes nothing.
