import "server-only";
import { NextResponse } from "next/server";
import { can, getAuthz, type Authz } from "../authz";

/** The service permissions, staff first. */
export const SERVICE_STAFF_PERMISSIONS = [
  "service.read",
  "service.manage",
  "service.dispatch",
] as const;
export const SERVICE_ALL_PERMISSIONS = [...SERVICE_STAFF_PERMISSIONS, "service.self"] as const;

/**
 * Route authorization for service endpoints: the caller holds any one of the
 * named grants. The engine command repeats the decision under its row locks
 * with the record's legal entity and, for technicians, their own bookings,
 * so this gate only answers early for callers who can never succeed.
 */
export function authorizeService(...permissions: readonly string[]) {
  return async (): Promise<Authz | NextResponse> => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (permissions.some((permission) => can(authz, permission))) return authz;
    return NextResponse.json(
      { error: `missing permission: ${permissions.join(" or ")}` },
      { status: 403 },
    );
  };
}

/** The engine actor for a signed-in user. */
export function serviceActor(authz: Authz): { orgId: string; actorId: string } {
  return { orgId: authz.user.orgId, actorId: authz.user.id };
}

export function canAny(authz: Authz, permissions: readonly string[]): boolean {
  return permissions.some((permission) => can(authz, permission));
}

/** What the signed-in user may do in the service area; the engine enforces each again. */
export interface ServiceCapabilities {
  readonly read: boolean;
  readonly manage: boolean;
  readonly dispatch: boolean;
  readonly self: boolean;
  readonly invoice: boolean;
  readonly estimates: boolean;
}

export function serviceCapabilities(authz: Authz): ServiceCapabilities {
  const manage = can(authz, "service.manage");
  const dispatch = can(authz, "service.dispatch");
  return {
    read: manage || dispatch || can(authz, "service.read"),
    manage,
    dispatch,
    self: can(authz, "service.self"),
    invoice: manage && can(authz, "ar.create"),
    estimates: can(authz, "estimates.create"),
  };
}
