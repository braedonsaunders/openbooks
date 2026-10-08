import "server-only";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { can, type Authz } from "./authz";
import { accessibleProductionOrgs, resolveActiveEnv } from "./org-access";

/**
 * Data for the workspace switcher (inside the account menu). Lists every
 * production tenant the login can reach, each with its sandboxes. A sandbox is a
 * separate tenant, so switching between production and its sandboxes — or
 * between two production tenants — is one uniform list.
 */
export interface EnvOption {
  orgId: string;
  name: string;
  status: string;
  tier: string;
}

export interface TenantGroup {
  productionOrgId: string;
  productionOrgName: string;
  envKind: "production" | "preview";
  sandboxes: EnvOption[];
}

export interface WorkspaceEnvironments {
  currentOrgId: string;
  envKind: "production" | "sandbox" | "preview";
  /** Display label for the active env (used as the account-menu subtext). */
  currentName: string;
  homeOrgId: string;
  /** May manage/enter sandboxes (holds admin.sandboxes.manage or super admin). */
  canManage: boolean;
  isSuperAdmin: boolean;
  tenants: TenantGroup[];
}

export async function shellEnvironments(authz: Authz): Promise<WorkspaceEnvironments> {
  const home = {
    id: authz.user.homeUserId,
    orgId: authz.user.homeOrgId,
    isSuperAdmin: authz.user.isSuperAdmin,
  };
  const canManage = authz.user.isSuperAdmin || can(authz, "admin.sandboxes.manage");
  const accessible = await accessibleProductionOrgs(home);

  // bypass: user-keyed-lookup — the environment switcher lists sandboxes of every organization this person can reach.
  return withBypassContext(async () => {
    // Each reachable organization resolves independently; read them together
    // so the shell waits for the slowest one rather than their sum.
    const tenants: TenantGroup[] = await Promise.all(accessible.map(async (o) => {
      let sandboxes: EnvOption[] = [];
      if (o.envKind === "production") {
        const candidates = (await db.execute<{ orgId: string; name: string; status: string; tier: string }>(sql`
          select org_id as "orgId", name, status, tier
            from sandboxes where production_org_id = ${o.orgId}
           order by created_at`)).rows;
        // The switcher must not advertise an environment that the request
        // resolver would refuse (for example, a cross-tenant super-admin with
        // no explicit mapped identity in the sandbox's production org).
        const enterable = await Promise.all(candidates.map(async (sandbox) =>
          (await resolveActiveEnv(home, sandbox.orgId)) ? sandbox : null,
        ));
        sandboxes = enterable.filter((sandbox): sandbox is EnvOption => sandbox !== null);
      }
      return {
        productionOrgId: o.orgId,
        productionOrgName: o.name,
        envKind: o.envKind,
        sandboxes,
      };
    }));
    const currentName =
      authz.user.envKind === "production" || authz.user.envKind === "preview"
        ? tenants.find((t) => t.productionOrgId === authz.user.productionOrgId)?.productionOrgName ??
          "Production"
        : authz.user.sandboxName ?? "Sandbox";
    return {
      currentOrgId: authz.user.orgId,
      envKind: authz.user.envKind,
      currentName,
      homeOrgId: authz.user.homeOrgId,
      canManage,
      isSuperAdmin: authz.user.isSuperAdmin,
      tenants,
    };
  });
}
