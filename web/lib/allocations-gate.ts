import "server-only";
import { NextResponse } from "next/server";
import { guardPermission, type Authz } from "./authz";
import { orgFeatureState } from "./features";
import { permissionSetCovers } from "./permissions";

/**
 * Allocations feature gate (A8).
 *
 * Reads the explicit `allocations` flag from the org's feature state
 * directly instead of `isFeatureEnabled`: the governed `allocations`
 * registry entry lands with A10 (platform slice), and `featureEnabled`
 * fails closed for unknown keys. Once A10's entry (default OFF) lands,
 * this returns exactly what `isFeatureEnabled(orgId, 'allocations')`
 * returns, so routes need no rewiring.
 */
export async function isAllocationsEnabled(orgId: string): Promise<boolean> {
  const state = await orgFeatureState(orgId);
  return state?.["allocations"] === true;
}

/** Feature-off looks like a missing route (the Setup precedent). */
export function allocationsNotFound(): NextResponse {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/**
 * Route gate: session permission first, then the `allocations` feature.
 * Returns the Authz or the response the handler should send directly:
 *
 *   const gate = await guardAllocations("allocations.manage");
 *   if (gate instanceof NextResponse) return gate;
 */
export async function guardAllocations(perm: string): Promise<Authz | NextResponse> {
  const gate = await guardPermission(perm);
  if (gate instanceof NextResponse) return gate;
  if (!(await isAllocationsEnabled(gate.user.orgId))) return allocationsNotFound();
  return gate;
}

/** Second-permission checks on an already-gated request (e.g. `gl.post`). Pure. */
export function gateCan(gate: Authz, perm: string): boolean {
  return permissionSetCovers(gate.permissions, perm);
}

export function missingPermission(perm: string): NextResponse {
  return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 });
}
