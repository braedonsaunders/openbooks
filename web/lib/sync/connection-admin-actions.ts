import "server-only";
import { canonicalConnectionMappingConfig } from "@openbooks/engine/sync/connection-settings";
import {
  ConnectionMappingError,
  decodeEntityMappings,
} from "@openbooks/engine/sync/entity-mapping-contract";
import { sealJson } from "@openbooks/engine/platform/secrets";
import {
  buildSource,
  sourceType,
  validateSourceConfig,
  validateSourceSecret,
} from "@openbooks/engine/sync/connection";
import {
  createConnectionRecord,
  loadConnectionProbeRow,
  writeConnectionProbeOutcome,
} from "@openbooks/engine/sync/connection-admin";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  callerOwnedConfigRefusal,
  connectionConfigUrlRefusal,
  declaredSourceConfig,
} from "../../app/api/platform/connections/_connector-guard";
import { storageIdentityError } from "../../app/api/platform/connections/_storage-identity";

export type ConnectionAdminOutcome = { status: number; body: Record<string, unknown> };

/** Create a connector through the same validation and audited writer used by the setup route. */
export async function createConnectionAction(
  actor: { orgId: string; userId: string },
  body: {
    source: string;
    displayName?: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
  },
): Promise<ConnectionAdminOutcome> {
  const { orgId, userId: actorId } = actor;
  const manifest = sourceType(body.source);
  if (!manifest) return { status: 400, body: { error: "unknown source type" } };

  const displayName = body.displayName?.trim() || manifest.displayName;
  const suppliedConfig = body.config ?? {};
  const ownedError = callerOwnedConfigRefusal(suppliedConfig);
  if (ownedError)
    return { status: 400, body: { error: ownedError, errorCode: "OAUTH_IDENTITY_REFUSED" } };
  let config = declaredSourceConfig(manifest, suppliedConfig);
  try {
    config = canonicalConnectionMappingConfig(config, manifest.mappingGroups ?? []);
  } catch (cause) {
    if (cause instanceof ConnectionMappingError)
      return { status: cause.status, body: { error: cause.message } };
    console.error("[platform/connections] mapping config validation failed", cause);
    return { status: 400, body: { error: "Connection mappings are unavailable" } };
  }
  const urlError = await connectionConfigUrlRefusal(config);
  if (urlError)
    return { status: 400, body: { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" } };
  const configError = validateSourceConfig(manifest, config, { today: await businessToday(orgId) });
  if (configError) return { status: 400, body: { error: configError } };
  if (
    Object.values(decodeEntityMappings(config.entityMappings).entities).some((rows) => rows.length)
  )
    return {
      status: 422,
      body: {
        error: "Save the connection first, then select its source and native mapping fields",
      },
    };

  const provided: Record<string, string> = {};
  for (const field of manifest.secretFields) {
    const value = body.secrets?.[field.key];
    if (value !== undefined && value !== "") {
      const secretError = validateSourceSecret(manifest.source, field.key, value);
      if (secretError) return { status: 400, body: { error: secretError } };
      provided[field.key] = value;
    }
  }
  const hasAllSecrets = manifest.secretFields.every(
    (field) => !field.required || provided[field.key],
  );
  if (manifest.source === "qbd" && !hasAllSecrets)
    return { status: 400, body: { error: "Web Connector password is required" } };
  const secrets = Object.keys(provided).length
    ? sealJson(provided, { orgId, purpose: "connection.secrets" })
    : null;
  const status =
    manifest.authKind === "oauth2"
      ? "unconfigured"
      : secrets && hasAllSecrets
        ? "active"
        : "unconfigured";
  try {
    const id = await createConnectionRecord({
      orgId,
      actorId,
      source: manifest.source,
      displayName,
      authKind: manifest.authKind,
      status,
      config,
      secrets,
    });
    return { status: 200, body: { id } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "create failed";
    if (/connections_org_name/.test(message))
      return { status: 409, body: { error: "a connection with that name already exists" } };
    throw error;
  }
}

/** Probe and record the result for the same connection version observed by the session route. */
export async function testConnectionAction(
  orgId: string,
  id: string,
): Promise<ConnectionAdminOutcome> {
  const row = await loadConnectionProbeRow(orgId, id).catch((error) => {
    if (storageIdentityError(error)) return null;
    throw error;
  });
  if (!row) return { status: 404, body: { error: "not_found" } };
  const urlError = await connectionConfigUrlRefusal(row.config);
  if (urlError)
    return { status: 422, body: { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" } };
  const stale = (): ConnectionAdminOutcome => ({
    status: 409,
    body: {
      error: "connection changed during the test; retry against the current configuration",
      errorCode: "CONNECTION_CHANGED",
    },
  });
  try {
    const source = buildSource(row);
    if (source.ping) {
      const result = await source.ping();
      const matched = await writeConnectionProbeOutcome(
        orgId,
        id,
        row,
        result.ok ? "active" : "error",
        result.ok ? null : (result.detail ?? "connection ping failed"),
      );
      if (!matched) return stale();
      return {
        status: result.ok ? 200 : 422,
        body: { ok: result.ok, detail: result.detail },
      };
    }
    const trialBalance = await source.trialBalance();
    const matched = await writeConnectionProbeOutcome(orgId, id, row, "active", null);
    if (!matched) return stale();
    return {
      status: 200,
      body: { ok: true, detail: `${trialBalance.length} accounts in trial balance` },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "connection test failed";
    const matched = await writeConnectionProbeOutcome(orgId, id, row, "error", message);
    if (!matched) return stale();
    return { status: 422, body: { ok: false, error: message } };
  }
}
