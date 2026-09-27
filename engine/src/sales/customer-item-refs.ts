import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { InventoryError, type Runner } from "../inventory/contracts.ts";

export class CustomerItemRefusal extends InventoryError {
  constructor(
    message: string,
    readonly code: string,
    readonly remedy: string,
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "CustomerItemRefusal";
  }
}

const FEATURES_REMEDY = "turn on Customer part numbers in Company Settings → Features";

export async function assertCustomerPartNumbersEnabled(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "customerPartNumbers", runner))) {
    throw new CustomerItemRefusal(
      `customer part numbers are turned off for this organization; ${FEATURES_REMEDY}`,
      "customer_part_numbers_disabled",
      FEATURES_REMEDY,
    );
  }
}

/** Validate both references against the tenant and ensure the party is an
 * actual customer. Setup and import writers call this before persisting. */
export async function validateCustomerItemRef(
  runner: Runner,
  orgId: string,
  customerId: string,
  itemId: string,
): Promise<void> {
  await assertCustomerPartNumbersEnabled(runner, orgId);
  const rows = (await runner.execute<{ customer_id: string; item_id: string }>(sql`
    select p.id as customer_id, i.id as item_id
      from parties p
      join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active
      join items i on i.org_id = p.org_id and i.id = ${itemId}
     where p.org_id = ${orgId} and p.id = ${customerId}
     limit 1`)).rows;
  if (!rows[0]) {
    throw new CustomerItemRefusal(
      "customer part number must reference a customer party and item in this organization",
      "customer_item_reference_out_of_scope",
      "select an existing customer and item from this organization",
    );
  }
}

export async function listCustomerItemRefs(
  runner: Runner,
  orgId: string,
  customerId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<Array<{ id: string; customerId: string; itemId: string; customerSku: string; description: string | null; itemCode: string | null; itemName: string }>> {
  await assertCustomerPartNumbersEnabled(runner, orgId);
  const subsidiaries = allowedSubsidiaryIds == null ? null : [...allowedSubsidiaryIds];
  const scope = subsidiaries === null
    ? sql`true`
    : subsidiaries.length > 0
      ? sql`(p.subsidiary_id is null or p.subsidiary_id = any(${sql.param(subsidiaries)}::uuid[]))`
      : sql`p.subsidiary_id is null`;
  return (await runner.execute(sql`
    select cir.id, cir.customer_id as "customerId", cir.item_id as "itemId",
           cir.customer_sku as "customerSku", cir.description,
           i.code as "itemCode", i.name as "itemName"
      from customer_item_refs cir
      join parties p on p.id = cir.customer_id and p.org_id = cir.org_id
      join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active
      join items i on i.id = cir.item_id and i.org_id = cir.org_id
     where cir.org_id = ${orgId} and cir.customer_id = ${customerId} and ${scope}
     order by cir.customer_sku, cir.id`)).rows as Array<{
       id: string; customerId: string; itemId: string; customerSku: string;
       description: string | null; itemCode: string | null; itemName: string;
     }>;
}
