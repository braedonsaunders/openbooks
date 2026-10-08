import "server-only";
import { can, type Authz } from "./authz";
import { accessibleProductionOrgs, enterableSandboxes } from "./org-access";

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
  // Every reachable production organization's sandboxes are admitted in one
  // set-based read, so the shell's cost does not grow with the tenant count.
  const sandboxes = await enterableSandboxes(home, accessible.filter((o) => o.envKind === "production").map((o) => o.orgId));
  const tenants: TenantGroup[] = accessible.map((o) => ({
    productionOrgId: o.orgId,
    productionOrgName: o.name,
    envKind: o.envKind,
    sandboxes: o.envKind === "production"
      ? sandboxes.filter((sandbox) => sandbox.productionOrgId === o.orgId)
        .map(({ orgId, name, status, tier }) => ({ orgId, name, status, tier }))
      : [],
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
}
