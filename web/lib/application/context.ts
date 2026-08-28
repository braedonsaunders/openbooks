import "server-only";
import type { Authz } from "../authz";
import { can } from "../authz";
import type { ApiKeyAuth } from "../api-auth";
import type { ApiRequestAudit } from "./api-key-audit";
import { forbidden } from "./errors";

export type ApplicationOperationSource = "api" | "mcp" | "assistant";

/** Authenticated actor and policy context shared by every external adapter. */
export interface ApplicationContext {
  authz: Authz;
  source: ApplicationOperationSource;
  requestId: string;
  apiKeyId: string | null;
  /**
   * Transport key/request correlation for API-key-authenticated requests.
   * `executeIdempotent` writes the material command's atomic execution event
   * through it; the transport wrapper consumes the claimed marker and adds its
   * own event only for outcomes that ran no fresh command.
   */
  requestAudit?: ApiRequestAudit;
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
    requestAudit: auth.audit,
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
  // `null` is the explicit unrestricted sentinel. Every other context is
  // restricted, so an unresolved subsidiary (null/undefined/empty) must fail
  // closed just like an id outside the allowed set.
  if (
    allowed !== null &&
    (subsidiaryId === null ||
      subsidiaryId === undefined ||
      subsidiaryId === "" ||
      !allowed.has(subsidiaryId))
  ) {
    throw forbidden("subsidiary.restricted");
  }
}
