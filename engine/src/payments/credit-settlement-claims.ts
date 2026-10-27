import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { CreditApplicationConflictError, PaymentError } from "../payments-core/payment-errors.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";

export interface CreditSettlementResult {
  /** Ids of the `applications` rows written, in input order. */
  applicationIds: string[];
  /** Total settled, in the credits' transaction currency. */
  amount: string;
}

export interface EndpointRow extends Record<string, unknown> {
  id: string;
  document_kind: string | null;
  account_id: string;
  subsidiary_id: string;
  book_id: string;
  document_subsidiary_id: string | null;
  posting_date: string;
  entry_number: string;
}

/**
 * Lock every journal line a credit settlement touches, refusing a line that no
 * longer exists and hiding one outside the caller's subsidiary scope.
 */
export async function lockSettlementEndpoints(
  orgId: string,
  endpointIds: string[],
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<EndpointRow[]> {
  const endpoints = await db.execute<EndpointRow>(
    sql`
    select jl.id, jl.account_id, jl.subsidiary_id, je.book_id,
           endpoint_document.kind as document_kind,
           endpoint_document.subsidiary_id as document_subsidiary_id,
           je.posting_date::text as posting_date,
           coalesce(endpoint_document.document_number, je.entry_number) as entry_number
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      left join documents endpoint_document on endpoint_document.id = je.source_document_id and endpoint_document.org_id = je.org_id
     where jl.org_id = ${orgId} and jl.id in ${endpointIds}
     order by jl.id
     for update of jl
  `,
    "objects",
  );
  if (endpoints.length !== endpointIds.length) {
    throw new PaymentError(
      "a credit or open item in this settlement no longer exists; reload the credits and reselect",
    );
  }
  if (
    endpoints.some(
      (row) =>
        !subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id) ||
        (row.document_subsidiary_id !== null &&
          !subsidiaryScopeAllows(allowedSubsidiaryIds, row.document_subsidiary_id)),
    )
  ) {
    throw new ScopeNotFoundError();
  }
  return endpoints;
}

/**
 * Resolve an Idempotency-Key that already settled: replay the first result when
 * the request image is unchanged, refuse a changed payload or another
 * organization's key by name, and return null for a fresh key.
 */
export async function replayCreditSettlementClaim(
  orgId: string,
  idempotencyKey: string,
  matchImage: unknown,
): Promise<CreditSettlementResult | null> {
  // The claim reads ACROSS organizations through the sanctioned bypass
  // context: under RLS the ambient org filter hides another tenant's
  // application row, so without this the foreign-key detection never fires
  // and the collision surfaces later as a raw primary-key violation — a
  // correct refusal arriving as an internal error instead of the named
  // 409. The row is never returned to the caller; only its org_id is.
  // bypass: cross-org-by-design — an idempotency key owned by another organization must be seen to be refused by name.
  const priorOwner = await withBypassContext(
    async () =>
      (
        await db.execute<{ org_id: string }>(
          sql`
      select org_id from applications where id = ${idempotencyKey}
    `,
          "objects",
        )
      )[0]?.org_id,
  );
  if (priorOwner !== undefined) {
    if (priorOwner !== orgId) throw new CreditApplicationConflictError("foreign-key");
    const prior = (
      await db.execute<{ match: unknown; result: unknown }>(
        sql`
        select changes->'match' as match, (changes->'after'->'result') as result
          from audit_log
         where org_id = ${orgId} and table_name = 'applications'
           and row_id = ${idempotencyKey} and request_id = ${idempotencyKey}
           and action = 'insert'
         order by at asc
         limit 1
      `,
        "objects",
      )
    )[0];
    if (
      !prior ||
      !prior.match ||
      typeof prior.match !== "object" ||
      canonicalJson(prior.match) !== canonicalJson(matchImage) ||
      !prior.result ||
      typeof prior.result !== "object" ||
      !Array.isArray((prior.result as CreditSettlementResult).applicationIds)
    ) {
      throw new CreditApplicationConflictError("changed-payload");
    }
    return prior.result as CreditSettlementResult;
  }
  return null;
}
