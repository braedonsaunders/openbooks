import { sql } from "drizzle-orm";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date";
import { db, type SqlExecutor } from "@openbooks/engine/platform/database";
import { lockAndCheckOrgFeature } from "@openbooks/engine/organization/features";
import { guardSubsidiaryScope, type Authz } from "./authz";
import { isUuid } from "./list-params";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";

export type RelationshipInput = {
  id?: string;
  childPartyId?: string;
  billToPartyId?: string;
  payerPartyId?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  consolidationGroupId?: string | null;
};

type NormalizedRelationshipValues = {
  childPartyId: string;
  billToPartyId: string;
  payerPartyId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  consolidationGroupId: string | null;
};

type NormalizedRelationshipInput = { errorCode: string } | { values: NormalizedRelationshipValues };

function dateValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const text = String(value);
  // Strict calendar validation: V8's Date.parse rolls February 30 into
  // March, which would pass a naive guard and reach the daterange cast as a
  // 22008 from PostgreSQL (a 500 path) instead of the dates domain error.
  return isIsoCalendarDate(text) ? text : undefined;
}

export const RELATIONSHIP_ERRORS = {
  scope: "Choose one billed customer to manage billing for.",
  invalidRecord: "Choose valid records for the billing relationship.",
  dates: "Use valid calendar dates for the billing window.",
  dateOrder: "The billing window cannot end before it starts.",
  references: "Choose customers and a group from this organization.",
  noRedirect:
    "A billing relationship must redirect billing somewhere — choose a bill-to or payer different from the customer.",
  group:
    "The consolidation group must be active and bill to this relationship’s payer — pick one of the payer’s groups, or leave it empty to bill standalone.",
  overlap:
    "This customer already bills through another payer for part of that window — close the existing window first (set its end date), then add the new one.",
  save: "The billing relationship could not be saved.",
} as const;

export type RelationshipErrorCode = keyof typeof RELATIONSHIP_ERRORS;

export async function listCustomerBillingRelationships(
  runner: SqlExecutor,
  orgId: string,
  gate: Authz,
  childPartyId: string,
): Promise<{ relationships: Record<string, unknown>[] } | null> {
  const child = (
    await runner.execute<{ subsidiaryId: string | null }>(
      sql`
    select subsidiary_id as "subsidiaryId" from parties where org_id = ${orgId} and id = ${childPartyId}
  `,
      "objects",
    )
  )[0];
  if (
    !child ||
    (gate.allowedSubsidiaryIds !== null &&
      guardSubsidiaryScope(gate, child.subsidiaryId, { orgWideNull: true }))
  )
    return null;
  const relationships = await runner.execute(
    sql`
    select r.id, r.bill_to_party_id as "billToPartyId", b.display_name as "billToName",
           r.payer_party_id as "payerPartyId", p.display_name as "payerName",
           r.consolidation_group_id as "groupId", g.code as "groupCode", g.name as "groupName",
           r.effective_from::text as "effectiveFrom", r.effective_to::text as "effectiveTo"
      from customer_billing_relationships r
      join parties b on b.id = r.bill_to_party_id and b.org_id = r.org_id
      join parties p on p.id = r.payer_party_id and p.org_id = r.org_id
      left join consolidation_groups g on g.id = r.consolidation_group_id and g.org_id = r.org_id
     where r.org_id = ${orgId} and r.child_party_id = ${childPartyId}
       ${subsidiaryVisibleFilter(sql`b.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
       ${subsidiaryVisibleFilter(sql`g.billing_subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
     order by r.effective_from desc
  `,
    "objects",
  );
  return { relationships };
}

export async function listConsolidationGroups(
  runner: SqlExecutor,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  return runner.execute(
    sql`
    select g.id, g.code, g.name, g.payer_party_id as "payerPartyId",
           g.cadence, g.cutoff_day as "cutoffDay", g.grouping,
           s.name as "billingSubsidiaryName"
      from consolidation_groups g
      join parties payer on payer.org_id = g.org_id and payer.id = g.payer_party_id
      left join subsidiaries s on s.id = g.billing_subsidiary_id and s.org_id = g.org_id
     where g.org_id = ${orgId} and g.is_active
       ${subsidiaryVisibleFilter(sql`g.billing_subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       ${subsidiaryVisibleFilter(sql`payer.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by g.code
  `,
    "objects",
  );
}

async function billedCustomerVisibility(
  tx: SqlExecutor,
  orgId: string,
  gate: Authz,
  customerId: string,
): Promise<"visible" | "missing" | "hidden"> {
  const party = (
    await tx.execute<{ subsidiaryId: string | null }>(
      sql`
    select p.subsidiary_id as "subsidiaryId"
      from parties p
     where p.org_id = ${orgId} and p.id = ${customerId}
     for share of p`,
      "objects",
    )
  )[0];
  if (!party) return "missing";
  return guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true })
    ? "hidden"
    : "visible";
}

async function normalizedInput(
  body: RelationshipInput,
  orgId: string,
  gate: Authz,
  allowed: ReadonlySet<string> | null,
  rowId: string | undefined,
  tx: SqlExecutor,
): Promise<NormalizedRelationshipInput> {
  const unrestricted = allowed === null;
  // Overlapping windows for one child are refused, never resolved
  // arbitrarily — serialize the check and the write on the child so two
  // concurrent creates cannot both pass the preflight (there is no storage
  // exclusion to arbitrate them).
  const lockChild = body.childPartyId ? String(body.childPartyId) : null;
  if (rowId && !lockChild) {
    const current = (
      await tx.execute<{ childPartyId: string }>(
        sql`
      select child_party_id as "childPartyId"
        from customer_billing_relationships where id = ${rowId} and org_id = ${orgId}`,
        "objects",
      )
    )[0];
    if (!current) return { errorCode: "save" } as const;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"billing-relationship:" + orgId + ":" + current.childPartyId}, 0))`,
    );
  } else if (lockChild) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"billing-relationship:" + orgId + ":" + lockChild}, 0))`,
    );
  }
  if (!(await lockAndCheckOrgFeature(tx, orgId, "consolidatedBilling"))) {
    return { errorCode: "featureOff" } as const;
  }
  let values = body;
  if (rowId) {
    const current = await tx.execute<RelationshipInput>(
      sql`
      select child_party_id as "childPartyId", bill_to_party_id as "billToPartyId",
             payer_party_id as "payerPartyId",
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
             consolidation_group_id as "consolidationGroupId"
        from customer_billing_relationships where id = ${rowId} and org_id = ${orgId} for update`,
      "objects",
    );
    if (!current[0]) return { errorCode: "save" } as const;
    values = { ...current[0], ...body };
    // The stored row's own customer must already be visible — a restricted
    // caller alters only their own subsidiaries' billing, and the uniform
    // 'save' answers exactly like a missing row.
    const stored = await billedCustomerVisibility(tx, orgId, gate, String(current[0].childPartyId));
    if (stored !== "visible") return { errorCode: "save" } as const;
  }
  const childPartyId = String(values.childPartyId ?? "");
  const billToPartyId = String(values.billToPartyId ?? "");
  const payerPartyId = String(values.payerPartyId ?? "");
  const effectiveFrom = dateValue(values.effectiveFrom);
  const effectiveTo = dateValue(values.effectiveTo);
  const consolidationGroupId = values.consolidationGroupId
    ? String(values.consolidationGroupId)
    : null;
  if (
    !isUuid(childPartyId) ||
    !isUuid(billToPartyId) ||
    !isUuid(payerPartyId) ||
    (consolidationGroupId && !isUuid(consolidationGroupId))
  ) {
    return { errorCode: "invalidRecord" } as const;
  }
  if (effectiveFrom === undefined || effectiveTo === undefined)
    return { errorCode: "dates" } as const;
  // The window start is always known (storage holds no open-started
  // windows); only the end may stay open.
  if (!effectiveFrom) return { errorCode: "dates" } as const;
  if (effectiveTo && effectiveTo < effectiveFrom) return { errorCode: "dateOrder" } as const;
  if (childPartyId === billToPartyId && childPartyId === payerPartyId)
    return { errorCode: "noRedirect" } as const;
  // The requested customer must be visible first: a restricted caller
  // probing a hidden or missing record reads the same uniform not-found,
  // while an unrestricted caller is unaffected.
  const requested = await billedCustomerVisibility(tx, orgId, gate, childPartyId);
  if (requested !== "visible") {
    if (unrestricted) return { errorCode: "references" } as const;
    return { errorCode: "notFound" } as const;
  }
  for (const partyId of new Set([billToPartyId, payerPartyId])) {
    const visibility = await billedCustomerVisibility(tx, orgId, gate, partyId);
    if (visibility === "hidden" || (!unrestricted && visibility === "missing")) {
      return { errorCode: "notFound" } as const;
    }
    if (visibility === "missing") return { errorCode: "references" } as const;
  }
  if (consolidationGroupId) {
    const group = (
      await tx.execute<{ billingSubsidiaryId: string | null }>(
        sql`
      select billing_subsidiary_id as "billingSubsidiaryId"
        from consolidation_groups where id = ${consolidationGroupId} and org_id = ${orgId}
       for share`,
        "objects",
      )
    )[0];
    if (!group && !unrestricted) return { errorCode: "notFound" } as const;
    if (group && guardSubsidiaryScope(gate, group.billingSubsidiaryId, { orgWideNull: true })) {
      return { errorCode: "notFound" } as const;
    }
  }
  // Record validity, unchanged for every caller alike: all three parties
  // belong to this organization, and the group — when named — is active and
  // bills to this relationship's payer. A group naming another payer would
  // silently never apply (resolution drops a group whose payer differs),
  // so it is refused by name instead of saved as applicable.
  const refs = await tx.execute(
    sql`
    select
      exists(select 1 from parties where id = ${childPartyId} and org_id = ${orgId}) as child_ok,
      exists(select 1 from parties where id = ${billToPartyId} and org_id = ${orgId}) as bill_to_ok,
      exists(select 1 from parties where id = ${payerPartyId} and org_id = ${orgId}) as payer_ok,
      ${
        consolidationGroupId
          ? sql`exists(select 1 from consolidation_groups
                      where id = ${consolidationGroupId} and org_id = ${orgId}
                        and is_active and payer_party_id = ${payerPartyId})`
          : sql`true`
      } as group_ok`,
    "objects",
  );
  if (!refs[0]?.child_ok || !refs[0]?.bill_to_ok || !refs[0]?.payer_ok || !refs[0]?.group_ok) {
    return {
      errorCode:
        consolidationGroupId && refs[0]?.child_ok && refs[0]?.bill_to_ok && refs[0]?.payer_ok
          ? "group"
          : "references",
    } as const;
  }
  const overlap = await tx.execute(
    sql`
    select 1 from customer_billing_relationships
     where org_id = ${orgId} and id is distinct from ${rowId ?? null}
       and child_party_id = ${childPartyId}
       and daterange(effective_from, effective_to, '[]') &&
           daterange(${effectiveFrom}::date, ${effectiveTo}::date, '[]')
     limit 1`,
    "objects",
  );
  if (overlap.length) return { errorCode: "overlap" } as const;
  return {
    values: {
      childPartyId,
      billToPartyId,
      payerPartyId,
      effectiveFrom,
      effectiveTo,
      consolidationGroupId,
    },
  } as const;
}

export type BillingRelationshipResult =
  { id: string; childPartyId: string } | { errorCode: string };

export async function createBillingRelationship(
  orgId: string,
  actorId: string,
  gate: Authz,
  input: RelationshipInput,
): Promise<BillingRelationshipResult> {
  return db.transaction(async (tx) => {
    const parsed = await normalizedInput(
      input,
      orgId,
      gate,
      gate.allowedSubsidiaryIds,
      undefined,
      tx,
    );
    if ("errorCode" in parsed) return parsed;
    const v = parsed.values;
    const inserted = await tx.execute(
      sql`
      insert into customer_billing_relationships
        (org_id, child_party_id, bill_to_party_id, payer_party_id, effective_from, effective_to, consolidation_group_id, created_by, updated_by)
      values (${orgId}, ${v.childPartyId}, ${v.billToPartyId}, ${v.payerPartyId}, ${v.effectiveFrom}, ${v.effectiveTo}, ${v.consolidationGroupId}, ${actorId}, ${actorId})
      returning *`,
      "objects",
    );
    const after = inserted[0];
    if (!after) throw new Error("billing relationship insert returned no row");
    const id = String(after.id);
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'customer_billing_relationships', ${id}, 'insert', ${JSON.stringify({ before: null, after })}::jsonb, ${actorId})`);
    return { id, childPartyId: v.childPartyId };
  });
}

export async function updateBillingRelationship(
  orgId: string,
  actorId: string,
  gate: Authz,
  id: string,
  input: RelationshipInput,
): Promise<BillingRelationshipResult> {
  return db.transaction(async (tx) => {
    const parsed = await normalizedInput(input, orgId, gate, gate.allowedSubsidiaryIds, id, tx);
    if ("errorCode" in parsed) return parsed;
    const v = parsed.values;
    const before = (
      await tx.execute(
        sql`select * from customer_billing_relationships where id = ${id} and org_id = ${orgId} for update`,
        "objects",
      )
    )[0];
    if (!before) return { errorCode: "save" };
    const updated = (
      await tx.execute(
        sql`update customer_billing_relationships
      set child_party_id = ${v.childPartyId}, bill_to_party_id = ${v.billToPartyId}, payer_party_id = ${v.payerPartyId},
          effective_from = ${v.effectiveFrom}, effective_to = ${v.effectiveTo}, consolidation_group_id = ${v.consolidationGroupId},
          updated_at = now(), updated_by = ${actorId}
      where id = ${id} and org_id = ${orgId} returning *`,
        "objects",
      )
    )[0];
    if (!updated) throw new Error("billing relationship update returned no row");
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'customer_billing_relationships', ${id}, 'update', ${JSON.stringify({ before, after: updated })}::jsonb, ${actorId})`);
    return { id, childPartyId: v.childPartyId };
  });
}

export async function deleteBillingRelationship(
  orgId: string,
  actorId: string,
  gate: Authz,
  id: string,
): Promise<{ ok: true; childPartyId: string } | { errorCode: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"billing-relationship:" + orgId + ":" + id}, 0))`,
    );
    if (!(await lockAndCheckOrgFeature(tx, orgId, "consolidatedBilling")))
      return { errorCode: "featureOff" };
    const before = (
      await tx.execute(
        sql`select * from customer_billing_relationships where id = ${id} and org_id = ${orgId} for update`,
        "objects",
      )
    )[0] as { child_party_id: string | null } | undefined;
    if (!before) return { errorCode: "save" };
    const stored = await billedCustomerVisibility(
      tx,
      orgId,
      gate,
      before.child_party_id ? String(before.child_party_id) : "",
    );
    if (stored !== "visible") return { errorCode: "save" };
    const removed = (
      await tx.execute(
        sql`delete from customer_billing_relationships where id = ${id} and org_id = ${orgId} returning id`,
        "objects",
      )
    )[0];
    if (!removed) throw new Error("billing relationship delete returned no row");
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'customer_billing_relationships', ${id}, 'delete', ${JSON.stringify({ before, after: null })}::jsonb, ${actorId})`);
    return { ok: true, childPartyId: String(before.child_party_id) };
  });
}
