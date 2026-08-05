import "server-only";
import { redirect } from "next/navigation";
import { getAuthz, type Authz } from "./authz";

/** Gate a super-admin surface. Redirects non-super-admins away. */
export async function requireSuperAdmin(): Promise<Authz> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  if (!authz.user.isSuperAdmin) redirect("/");
  return authz;
}
