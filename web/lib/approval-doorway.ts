import { can, type Authz } from "./authz";

/** Entry to the tenant-authored Flow approval worklist. */
export function maySeeUnion(authz: Authz): boolean {
  return can(authz, "flows.approve");
}
