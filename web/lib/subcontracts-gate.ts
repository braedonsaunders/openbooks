import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { isFeatureEnabled } from "./features";

/**
 * Subcontracts route/page gate, resolved through the canonical feature
 * switchboard (web/lib/features.ts → the registry's `featureEnabled`: a
 * non-boolean stored value falls back to the registry default, and the
 * `requiresAll: ['projects']` chain keeps subcontracts off while the
 * Projects parent is off). The previous inline
 * `coalesce((settings->'features'->>'…')::boolean, …)` SQL re-implemented
 * both the defaults and the parent dependency, and mis-resolved non-boolean
 * imports ('yes' casts to TRUE in Postgres; other spellings threw 22P02 and
 * the guarded routes 500'd).
 */
async function enabled(orgId: string): Promise<boolean> {
  return isFeatureEnabled(orgId, "subcontracts");
}

export async function requireSubcontractsFeature(orgId: string): Promise<void> {
  if (!(await enabled(orgId))) redirect("/admin/setup/features");
}

export async function guardSubcontractsFeature(orgId: string): Promise<NextResponse | null> {
  if (await enabled(orgId)) return null;
  return NextResponse.json({ error: "subcontracts feature is disabled" }, { status: 404 });
}
