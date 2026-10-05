import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
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
    const allowed = authz.allowedSubsidiaryIds;
    const ids = allowed === null ? null : [...allowed];
    const customers = (await db.execute<{ id: string; name: string; email: string | null }>(sql`
      select p.id, coalesce(nullif(p.display_name, ''), p.email, p.id) as name, p.email as email
        from parties p
       where p.org_id = ${authz.user.orgId} and p.kind = 'customer' and p.is_active
         ${allowed === null ? sql`` : ids!.length > 0
           ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${ids.join(",")}}`}::uuid[]))`
           : sql`and false`}
       order by name limit 500`)).rows;
    return Response.json({ customers });
  },
});
