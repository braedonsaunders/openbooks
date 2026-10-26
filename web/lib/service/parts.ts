import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { ServiceError } from "@openbooks/engine/service/errors";
import { recordVisitPart, type VisitPartInput } from "@openbooks/engine/service/completion";
import { jobCurrency } from "@openbooks/engine/service/jobs";
import { getServiceVisit, listServiceStockLocations } from "@openbooks/engine/service/reads";
import type { Authz } from "../authz";
import { resolveItemPrice } from "../item-pricing";

type PartRequest = Omit<VisitPartInput, "unitPrice">;

/**
 * Record a part on a visit at the customer's native selling price. A billed
 * part with no price for the customer, currency and date refuses rather than
 * billing at zero; a part the customer is not billed for records no price.
 * Technicians record parts without seeing prices.
 */
export async function recordPricedVisitPart(
  actor: { orgId: string; actorId: string },
  input: { visitId: string; expectedRevision: number; part: PartRequest },
): Promise<{ partId: string; visitRevision: number }> {
  const detail = await getServiceVisit({ ...actor, visitId: input.visitId });
  let unitPrice = "0";
  if (input.part.billable) {
    const owner = (
      await db.execute<{ customerPartyId: string; subsidiaryId: string }>(
        sql`
      select coalesce(j.customer_party_id, r.customer_party_id) as "customerPartyId", v.subsidiary_id as "subsidiaryId"
        from service_visits v
        left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
        left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
       where v.org_id = ${actor.orgId} and v.id = ${detail.visit.id}`,
        "objects",
      )
    )[0];
    if (!owner)
      throw new ServiceError("The visit was not found.", {
        status: 404,
        code: "service_not_found",
      });
    const [currency, today] = await Promise.all([
      jobCurrency(actor.orgId, owner.subsidiaryId, owner.customerPartyId),
      businessToday(actor.orgId),
    ]);
    const price = await resolveItemPrice({
      orgId: actor.orgId,
      itemId: input.part.itemId,
      customerId: owner.customerPartyId,
      currency,
      lineQuantity: String(input.part.quantity),
      onDate: today,
    });
    if (!price) {
      throw new ServiceError("This part has no selling price for the customer.", {
        code: "service_configuration_missing",
        remedy:
          "Set the item’s selling price (or the customer’s price level) in Items, or record the part as not billed.",
      });
    }
    unitPrice = price.unitPrice;
  }
  return recordVisitPart({
    ...actor,
    visitId: input.visitId,
    expectedRevision: input.expectedRevision,
    part: { ...input.part, unitPrice },
  });
}

export type StockLocationOption = { id: string; code: string; name: string };

/** Active stock locations a part may come from, vans and warehouses alike. */
export async function serviceStockLocations(authz: Authz): Promise<StockLocationOption[]> {
  return listServiceStockLocations(authz.user.orgId, authz.allowedSubsidiaryIds);
}

export type PartItemOption = { id: string; code: string | null; name: string; kind: string };

/** Active items a technician may record as a part, searched by code or name. */
export async function servicePartItems(orgId: string, query: string): Promise<PartItemOption[]> {
  const pattern = `%${query.trim()}%`;
  return await db.execute<PartItemOption>(
    sql`select id, code, name, kind from items
     where org_id = ${orgId} and is_active and kind in ('inventory', 'non_inventory', 'assembly', 'kit', 'other_charge')
       and (${query.trim()} = '' or name ilike ${pattern} or coalesce(code, '') ilike ${pattern})
     order by name, id limit 50`,
    "objects",
  );
}
