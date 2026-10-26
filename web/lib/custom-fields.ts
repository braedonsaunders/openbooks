import "server-only";

import { permissionSetCovers } from "@openbooks/engine/organization/permissions";
import type { CustomFieldViewer } from "@openbooks/engine/records/custom-fields";

export * from "@openbooks/engine/records/custom-fields";

/**
 * The custom-field viewer for an authorized actor. Managers (holders of
 * admin.custom_fields.manage, including super administrators through the
 * wildcard grant) see every field; everyone else sees fields whose audience
 * lists one of their role keys. Derived from the live grants on the request's
 * authority, never from a saved permission set.
 */
export function customFieldViewerFor(authz: {
  user: { roles: ReadonlyArray<{ key: string }> };
  permissions: ReadonlySet<string>;
}): CustomFieldViewer {
  return {
    roleKeys: authz.user.roles.map(({ key }) => key),
    canManageCustomFields: permissionSetCovers(authz.permissions, "admin.custom_fields.manage"),
  };
}
