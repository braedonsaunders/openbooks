import { defineRoute } from "@/lib/api/route";
import { rateBookBody, saveItemRateBook } from "@/lib/item-rate-book-service";

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "projects",
  scope: "unrestricted",
  body: rateBookBody,
  handler: async ({ body, authz }) => saveItemRateBook(body, authz),
});
