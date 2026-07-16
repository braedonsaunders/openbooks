import "server-only";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { can, type Authz } from "./authz";
import { accessibleProductionOrgs } from "./org-access";

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

  return withBypassContext(async () => {
    const tenants: TenantGroup[] = [];
    for (const o of accessible) {
      let sandboxes: EnvOption[] = [];
      if (canManage) {
        const rows = (await db.execute(sql`
          select org_id as "orgId", name, status, tier
            from sandboxes where production_org_id = ${o.orgId}
           order by created_at`)) as any;
        sandboxes = rows.rows as EnvOption[];
      }
      tenants.push({ productionOrgId: o.orgId, productionOrgName: o.name, sandboxes });
    }
    const currentName =
      authz.user.envKind === "production"
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
