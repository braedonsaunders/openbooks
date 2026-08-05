"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ENV_COOKIE_NAME, makeEnvToken, SESSION_TTL_S } from "./auth";
import { getAuthz } from "./authz";
import { resolveActiveEnv } from "./org-access";

/**
 * Switch the active workspace — any org the login identity can reach: a sibling
 * production tenant, or a sandbox of one. Validates access (resolveActiveEnv),
 * then sets the signed `ob_active_env` cookie (or clears it for the home org).
 * From then on currentUser().orgId resolves there and the whole app + RLS follow.
 */
export async function enterOrg(orgId: string): Promise<void> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  const home = {
    id: authz.user.homeUserId,
    orgId: authz.user.homeOrgId,
    isSuperAdmin: authz.user.isSuperAdmin,
  };
  const resolved = await resolveActiveEnv(home, orgId);
  if (!resolved) throw new Error("no access to that workspace");

  const jar = await cookies();
  if (resolved.orgId === home.orgId) {
    // Home is the default — represented by the absence of the cookie.
    jar.delete(ACTIVE_ENV_COOKIE_NAME);
  } else {
    jar.set(ACTIVE_ENV_COOKIE_NAME, makeEnvToken(resolved.orgId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_S,
    });
  }
  redirect("/");
}

/** Return to the home production org (clears the active-workspace cookie). */
export async function exitSandbox(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACTIVE_ENV_COOKIE_NAME);
  redirect("/");
}
