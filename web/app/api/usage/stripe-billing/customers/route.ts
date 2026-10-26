import { db } from "@openbooks/engine/platform/database";
import { listStripeBillingCustomers } from "@openbooks/engine/billing/usage/stripe-billing-read";
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
    const customers = await listStripeBillingCustomers(db, {
      orgId: authz.user.orgId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return Response.json({ customers });
  },
});
