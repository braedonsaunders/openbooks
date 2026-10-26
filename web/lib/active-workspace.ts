import "server-only";

import { cookies } from "next/headers";
import { ACTIVE_ENV_COOKIE_NAME, makeEnvToken, SESSION_TTL_S } from "./auth";
import { secureCookiesEnabled } from "./auth-policy";
import type { Authz } from "./authz-core";
import { isUuid } from "./list-params";
import { resolveActiveEnv } from "./org-access";

export type WorkspaceSwitchResult =
  { ok: true; orgId: string } | { ok: false; reason: "invalid" | "no-access" };

/**
 * Switch the active workspace: any organization the login identity can reach,
 * whether a sibling production tenant or a sandbox of one. Access is decided
 * entirely by resolveActiveEnv, the same resolver currentUser() runs on every
 * request, so sandbox entry requires admin.sandboxes.manage (or super admin)
 * server-side and a stale cookie cannot keep a member inside once that
 * permission is revoked.
 *
 * The signed `ob_active_env` cookie names the workspace; the home organization
 * is represented by its absence. Callers reach this through the stable
 * POST /api/me/workspace endpoint rather than a server action, so a browser tab
 * rendered by an earlier deployment can still switch workspaces.
 */
export async function switchActiveWorkspace(
  authz: Authz,
  orgId: unknown,
): Promise<WorkspaceSwitchResult> {
  if (typeof orgId !== "string" || !isUuid(orgId)) return { ok: false, reason: "invalid" };
  const home = {
    id: authz.user.homeUserId,
    orgId: authz.user.homeOrgId,
    isSuperAdmin: authz.user.isSuperAdmin,
  };
  const resolved = await resolveActiveEnv(home, orgId);
  if (!resolved) return { ok: false, reason: "no-access" };

  const jar = await cookies();
  if (resolved.orgId === home.orgId) {
    jar.delete(ACTIVE_ENV_COOKIE_NAME);
  } else {
    jar.set(ACTIVE_ENV_COOKIE_NAME, makeEnvToken(resolved.orgId), {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookiesEnabled(),
      path: "/",
      maxAge: SESSION_TTL_S,
    });
  }
  return { ok: true, orgId: resolved.orgId };
}
