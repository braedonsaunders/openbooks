export interface PreferenceUser {
  id: string;
  orgId: string;
  envKind: "production" | "sandbox" | "preview";
  homeUserId: string;
  homeOrgId: string;
}

/**
 * Production organization switching retains the home identity, whose personal
 * preferences live in its home organization. Sandboxes and previews use their
 * active environment's acting user row.
 */
export function preferenceUserIdentity(user: PreferenceUser): { id: string; orgId: string } {
  if (
    user.envKind === "production" &&
    user.id === user.homeUserId &&
    user.orgId !== user.homeOrgId
  ) {
    return { id: user.homeUserId, orgId: user.homeOrgId };
  }
  return { id: user.id, orgId: user.orgId };
}
