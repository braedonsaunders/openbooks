import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getAuthz, type Authz } from "./authz";

/** Gate a super-admin surface. Redirects non-super-admins away. */
export async function requireSuperAdmin(): Promise<Authz> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  if (!authz.user.isSuperAdmin) redirect("/");
  return authz;
}

/**
 * API-route twin of requireSuperAdmin: returns the resolved Authz for a
 * platform super-admin, or the 401/403 JSON response the handler sends.
 *
 *   const gate = await guardSuperAdmin();
 *   if (gate instanceof NextResponse) return gate;
 */
export async function guardSuperAdmin(): Promise<Authz | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!authz.user.isSuperAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return authz;
}
