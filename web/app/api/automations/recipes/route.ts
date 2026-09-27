import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { automationRecipes } from "@openbooks/engine/src/automations/services.ts";
import { automationErrorResponse } from "../_lib";


export { runtime } from "@/lib/api/route";

/** Shipped recipe templates for the builder's recipe picker. */
export const GET = defineRoute({
  permission: "automations.read",
  feature: "automations",
  handler: async ({ authz: _gate }) => {
    try {
      return NextResponse.json({ recipes: automationRecipes() });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
