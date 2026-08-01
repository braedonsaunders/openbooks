import "server-only";
import type { Authz } from "../authz";
import { can } from "../authz";
import type { ApiKeyAuth } from "../api-auth";
import { forbidden } from "./errors";

export type ApplicationOperationSource = "api" | "mcp" | "assistant";

/** Authenticated actor and policy context shared by every external adapter. */
export interface ApplicationContext {
  authz: Authz;
  source: ApplicationOperationSource;
  requestId: string;
  apiKeyId: string | null;
}

export function applicationContextFromApiKey(
  auth: ApiKeyAuth,
  source: ApplicationOperationSource,
  requestId: string,
): ApplicationContext {
  return {
    authz: {
      user: auth.user,
      permissions: auth.permissions,
      allowedSubsidiaryIds: auth.allowedSubsidiaryIds,
    },
    source,
    requestId,
    apiKeyId: auth.keyId,
  };
}

/** Session-authenticated adapter used by the in-app assistant. */
export function applicationContextFromSession(
  authz: Authz,
  source: "assistant",
  requestId: string,
): ApplicationContext {
  return { authz, source, requestId, apiKeyId: null };
}

export function assertApplicationPermission(
  context: ApplicationContext,
  permission: string,
): void {
  if (!can(context.authz, permission)) throw forbidden(permission);
}

export function assertSubsidiaryAccess(
  context: ApplicationContext,
  subsidiaryId: string | null | undefined,
): void {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (subsidiaryId && allowed !== null && !allowed.has(subsidiaryId)) {
    throw forbidden("subsidiary.restricted");
  }
}
