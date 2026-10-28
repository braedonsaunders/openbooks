import { defineRoute } from "@/lib/api/route";
import { RenewalActionBody, executeRenewalAction } from "@/lib/subscriptions/renewal-actions";

export const POST = defineRoute({
  permission: "ar.create",
  feature: "advancedSubscriptions",
  body: RenewalActionBody,
  handler: ({ authz, body }) => executeRenewalAction(authz, body),
});
