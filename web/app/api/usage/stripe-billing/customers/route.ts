import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { defineRoute } from "@/lib/api/route";

/**
 * Customer choices for the Stripe Billing link picker: id, name and email,
 * restricted to the caller's subsidiary scope. Usage-billing operators link
 * Stripe customers here without leaving the Payment providers card.
 */
export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ authz }) => {
    const ids = authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds];
    const scope = ids === null ? sql``
      : ids.length > 0
        ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${ids.join(",")}}`}::uuid[]))`
        : sql`and false`;
    const customers = await db.execute<{ id: string; name: string; email: string | null }>(sql`
      select p.id, coalesce(nullif(p.display_name, ''), p.email, p.id) as name, p.email as email
        from parties p
       where p.org_id = ${authz.user.orgId} and p.is_active
         and exists (select 1 from customer_roles cr
           where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)
         ${scope}
       order by name limit 500`, "objects");
    return Response.json({ customers });
  },
});
