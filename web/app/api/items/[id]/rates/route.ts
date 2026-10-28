import { defineRoute } from "@/lib/api/route";
import { uuidId } from "@/lib/api/json";
import { z } from "zod";
import {
  getItemRateVersions,
  itemRatesBody,
  saveItemRateVersion,
} from "@/lib/item-rate-version-service";

const itemParams = z.object({ id: uuidId });

export const GET = defineRoute({
  permission: "items.read",
  feature: "projects",
  params: itemParams,
  handler: async ({ params: { id }, authz }) => getItemRateVersions(id, authz),
});

export const POST = defineRoute({
  permission: "items.manage",
  feature: "projects",
  scope: "unrestricted",
  params: itemParams,
  body: itemRatesBody,
  handler: async ({ params: { id }, body, authz }) => saveItemRateVersion(id, body, authz),
});
