import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { isFeatureEnabled } from "./features";

export async function requirePropertyManagementFeature(
  orgId: string,
): Promise<void> {
  if (!(await isFeatureEnabled(orgId, "propertyManagement")))
    redirect("/admin/setup/features");
}

export async function guardPropertyManagementFeature(
  orgId: string,
): Promise<NextResponse | null> {
  if (await isFeatureEnabled(orgId, "propertyManagement")) return null;
  return NextResponse.json(
    { error: "property management feature is disabled" },
    { status: 404 },
  );
}
