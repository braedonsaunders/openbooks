import { NextResponse } from "next/server";
import { automationRecipes } from "@openbooks/engine/src/automations/services.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { automationErrorResponse } from "../_lib";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

/** Shipped recipe templates for the builder's recipe picker. */
export async function GET() {
  const gate = await guardPermission("automations.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return notFound("record");
  }
  try {
    return NextResponse.json({ recipes: automationRecipes() });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
