import "server-only";
import { NextResponse } from "next/server";
import { isFeatureEnabled } from "./features";
import { requireFeatureEnabled } from "./feature-gates";

/** Page boundary: a disabled module explains itself on the feature-required page. */
export async function requirePropertyManagementFeature(
  orgId: string,
): Promise<void> {
  await requireFeatureEnabled(orgId, "propertyManagement");
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
