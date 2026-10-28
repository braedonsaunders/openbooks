import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { db } from "@openbooks/engine/platform/database";
import {
  ConsolidatedBillingError,
  resolveEffectiveBillingParties,
} from "@openbooks/engine/billing";
import { withScopeSnapshot } from "@openbooks/engine/organization/authority";
import { can } from "../../../lib/authz";
import { listScopedPartyOptions } from "../../../lib/scoped-options";
import { isUuid } from "../../../lib/list-params";
import {
  createBillingRelationship,
  deleteBillingRelationship,
  listConsolidationGroups,
  listCustomerBillingRelationships,
  RELATIONSHIP_ERRORS,
  updateBillingRelationship,
  type RelationshipErrorCode,
} from "@/lib/billing-relationships";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";

export const runtime = "nodejs";

const relationshipDate = z.union([z.string(), z.null()]);

const relationshipCreateBody = z.strictObject({
  childPartyId: uuidString(),
  billToPartyId: uuidString(),
  payerPartyId: uuidString(),
  effectiveFrom: relationshipDate,
  effectiveTo: relationshipDate,
  consolidationGroupId: uuidString().nullable().optional(),
});

const relationshipPatchBody = z.strictObject({
  id: uuidString(),
  childPartyId: uuidString().optional(),
  billToPartyId: uuidString().optional(),
  payerPartyId: uuidString().optional(),
  effectiveFrom: relationshipDate.optional(),
  effectiveTo: relationshipDate.optional(),
  consolidationGroupId: uuidString().nullable().optional(),
});

/** Uniform not-found for record-level scope denials on this surface. */
function scopeNotFound() {
  return notFound("billing relationship");
}

function refused(code: RelationshipErrorCode, status = 400) {
  return NextResponse.json(
    { errorCode: code, error: RELATIONSHIP_ERRORS[code] ?? RELATIONSHIP_ERRORS.save },
    { status },
  );
}

/**
 * Billing relationships on one customer drawer — the hierarchy edges that
 * separate the service-to child from the bill-to recipient and the AR
 * payer, with the consolidation group the charge consolidates through.
 */
export const GET = defineRoute({
  permission: "parties.read",
  feature: "consolidatedBilling",
  handler: async ({ request: req, authz: gate }) => {
    const { orgId } = gate.user;
    const url = new URL(req.url);
    const childPartyId = url.searchParams.get("childPartyId") ?? "";
    if (!isUuid(childPartyId)) return scopeNotFound();
    return withScopeSnapshot(orgId, async () => {
      const today = await businessToday(orgId);
      // Sequential: the snapshot holds one connection, and overlapping
      // queries on it are deprecated by the driver.
      const customerRelationships = await listCustomerBillingRelationships(
        db,
        orgId,
        gate,
        childPartyId,
      );
      if (!customerRelationships) return scopeNotFound();
      const relationships = customerRelationships.relationships;
      const children = await db.execute(
        sql`
      select r.child_party_id as "childPartyId", c.display_name as "childName",
             r.bill_to_party_id as "billToPartyId", r.payer_party_id as "payerPartyId",
             r.effective_from::text as "effectiveFrom", r.effective_to::text as "effectiveTo",
             g.code as "groupCode"
        from customer_billing_relationships r
        join parties c on c.id = r.child_party_id and c.org_id = r.org_id
        join parties b on b.id = r.bill_to_party_id and b.org_id = r.org_id
        join parties p on p.id = r.payer_party_id and p.org_id = r.org_id
        left join consolidation_groups g on g.id = r.consolidation_group_id and g.org_id = r.org_id
       where r.org_id = ${orgId} and (r.bill_to_party_id = ${childPartyId} or r.payer_party_id = ${childPartyId})
         ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
         ${subsidiaryVisibleFilter(sql`b.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
         ${subsidiaryVisibleFilter(sql`g.billing_subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
       order by c.display_name, r.effective_from desc
       limit 200`,
        "objects",
      );
      const groups = await listConsolidationGroups(db, orgId, gate.allowedSubsidiaryIds);
      const parties = await listScopedPartyOptions(orgId, gate.allowedSubsidiaryIds, {
        role: "customer",
        activeOnly: true,
      });
      let summary: Record<string, unknown>;
      try {
        const parties0 = await resolveEffectiveBillingParties(orgId, childPartyId, today, null);
        const targetPartyIds = [...new Set([parties0.billToPartyId, parties0.payerPartyId])];
        const names = await db.execute<{ id: string; name: string }>(
          sql`
        select p.id, p.display_name as name from parties p
         where p.org_id = ${orgId} and p.id in (${parties0.billToPartyId}, ${parties0.payerPartyId})
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}`,
          "objects",
        );
        if (names.length !== targetPartyIds.length) return scopeNotFound();
        const byId = new Map(names.map((n) => [n.id, n.name]));
        const group = parties0.consolidationGroupId
          ? (
              await db.execute<{ code: string; name: string; cadence: string }>(
                sql`
            select code, name, cadence from consolidation_groups
             where org_id = ${orgId} and id = ${parties0.consolidationGroupId}
               ${subsidiaryVisibleFilter(sql`billing_subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}`,
                "objects",
              )
            )[0]
          : null;
        if (parties0.consolidationGroupId && !group) return scopeNotFound();
        summary = {
          billToPartyId: parties0.billToPartyId,
          billToName: byId.get(parties0.billToPartyId) ?? "",
          payerPartyId: parties0.payerPartyId,
          payerName: byId.get(parties0.payerPartyId) ?? "",
          consolidationGroupId: parties0.consolidationGroupId,
          groupCode: group?.code ?? null,
          groupName: group?.name ?? null,
          groupCadence: group?.cadence ?? null,
        };
      } catch (error) {
        if (error instanceof ConsolidatedBillingError) return apiErrorResponse(error);
        throw error;
      }
      return NextResponse.json({
        summary,
        relationships,
        children,
        groups,
        parties: parties.map((p) => ({ id: p.id, name: p.display_name })),
        canManage: can(gate, "documents.manage"),
      });
    });
  },
});

export const POST = defineRoute({
  permission: "documents.manage",
  feature: "consolidatedBilling",
  body: relationshipCreateBody,
  invalidBodyStatus: 400,
  handler: async ({ authz: gate, body }) => {
    const outcome = await createBillingRelationship(gate.user.orgId, gate.user.id, gate, body);
    if (!("id" in outcome)) {
      if (outcome.errorCode === "notFound") return scopeNotFound();
      if (outcome.errorCode === "featureOff") {
        return NextResponse.json(
          {
            errorCode: outcome.errorCode,
            error:
              "Consolidated billing was turned off before this change could be saved — turn it back on under Company Settings → Features, then retry.",
          },
          { status: 409 },
        );
      }
      return refused(outcome.errorCode as RelationshipErrorCode);
    }
    return NextResponse.json({ id: outcome.id });
  },
});

export const PATCH = defineRoute({
  permission: "documents.manage",
  feature: "consolidatedBilling",
  body: relationshipPatchBody,
  invalidBodyStatus: 400,
  handler: async ({ authz: gate, body }) => {
    const { id, ...input } = body;
    const outcome = await updateBillingRelationship(gate.user.orgId, gate.user.id, gate, id, input);
    if (!("id" in outcome)) {
      if (outcome.errorCode === "save" || outcome.errorCode === "notFound")
        return NextResponse.json({ errorCode: outcome.errorCode }, { status: 404 });
      if (outcome.errorCode === "featureOff") {
        return NextResponse.json(
          {
            errorCode: outcome.errorCode,
            error:
              "Consolidated billing was turned off before this change could be saved — turn it back on under Company Settings → Features, then retry.",
          },
          { status: 409 },
        );
      }
      return refused(outcome.errorCode as RelationshipErrorCode);
    }
    return NextResponse.json({ id: outcome.id });
  },
});

export const DELETE = defineRoute({
  permission: "documents.manage",
  feature: "consolidatedBilling",
  handler: async ({ request: req, authz: gate }) => {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!isUuid(id)) return NextResponse.json({ errorCode: "save" }, { status: 404 });
    const outcome = await deleteBillingRelationship(gate.user.orgId, gate.user.id, gate, id);
    if ("errorCode" in outcome) {
      if (outcome.errorCode === "featureOff") {
        return NextResponse.json(
          {
            errorCode: outcome.errorCode,
            error:
              "Consolidated billing was turned off before this change could be saved — turn it back on under Company Settings → Features, then retry.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ errorCode: outcome.errorCode }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  },
});
