import { canonicalConnectionMappingConfig } from "@openbooks/engine/sync/connection-settings";
import {
  ConnectionMappingError,
  decodeEntityMappings,
} from "@openbooks/engine/sync/entity-mapping-contract";
import { apiErrorResponse } from "@/lib/api/error-response";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sealJson } from "@openbooks/engine/platform/secrets";
import {
  listConnections,
  sourceType,
  SOURCE_TYPES,
  validateSourceConfig,
  validateSourceSecret,
} from "@openbooks/engine/sync/connection";
import {
  createConnectionRecord,
  loadConnectionDashboardData,
} from "@openbooks/engine/sync/connection-admin";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { can, guardPermission, type Authz } from "@/lib/authz";
import {
  callerOwnedConfigRefusal,
  connectionConfigUrlRefusal,
  declaredSourceConfig,
} from "./_connector-guard";

export const runtime = "nodejs";

// Each connector manifest defines its own config keys and nested value types.
const connectionCreateBody = z
  .object({
    source: z.string().trim().min(1),
    displayName: z.string().optional(),
    config: z.record(z.string(), z.json()).optional(),
    secrets: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Strip the sealed credential blob before anything leaves the server. */
function toClient(c: Awaited<ReturnType<typeof listConnections>>[number]) {
  return {
    id: c.id,
    source: c.source,
    displayName: c.displayName,
    authKind: c.authKind,
    status: c.status,
    config: c.config,
    mirrorEnabled: c.mirrorEnabled,
    mirrorSchedule: c.mirrorSchedule,
    postedChangePolicy: c.postedChangePolicy,
    postedChangeAuthorizedAt: c.postedChangeAuthorizedAt,
    cursor: c.cursor,
    lastRunAt: c.lastRunAt,
    lastError: c.lastError,
    hasSecrets: Boolean(c.secrets),
  };
}

/**
 * List this tenant's connections + the catalogue of source types you can add.
 *
 * Reading the console is the `sync.run` grant (running a sync starts with
 * seeing it); configuring connections stays `admin.setup.manage`. The
 * payload carries `canManage` so the console hides its Add/Edit/Delete
 * controls from run-only callers instead of letting every edit fail.
 */
async function listConnectionRoutes(gate: Authz) {
  // Either grant reads the console (see the route's authorize); a caller
  // with neither sees the sync.run 403. `canManage` mirrors the configure
  // grant so the console hides its edit controls from run-only callers.
  const canManage = can(gate, "admin.setup.manage");
  const orgId = gate.user.orgId;
  const dashboard = await loadConnectionDashboardData(orgId);
  const { connections: rows, runs, latestRuns, currencies, qbdStatuses } = dashboard;
  const qbdByConnection = new Map(qbdStatuses.map((row) => [row.connectionId, row]));
  const runHealth = new Map<
    string,
    { mirror?: Record<string, unknown>; attachments?: Record<string, unknown> }
  >();
  for (const run of latestRuns) {
    const connectionId = typeof run.connectionId === "string" ? run.connectionId : null;
    if (!connectionId) continue;
    const health = runHealth.get(connectionId) ?? {};
    if (run.kind === "incremental" && !health.mirror) health.mirror = run;
    const stats = run.stats as { attachments?: unknown } | null;
    const progress = run.progress as { phase?: string } | null;
    const includesAttachments =
      run.kind === "attachments" || stats?.attachments != null || progress?.phase === "attachments";
    if (
      includesAttachments &&
      (!health.attachments || String(run.startedAt) > String(health.attachments.startedAt))
    ) {
      const summary = stats?.attachments as { failures?: number } | undefined;
      health.attachments = {
        ...run,
        status: run.kind !== "attachments" && summary?.failures === 0 ? "ok" : run.status,
      };
    }
    runHealth.set(connectionId, health);
  }
  const resolvedKeys = new Set(
    dashboard.resolvedDeletions.map((row) => `${row.connectionId}:${row.sourceRef}`),
  );
  return NextResponse.json({
    connections: rows.map((row) => ({
      ...toClient(row),
      qbdStatus: qbdByConnection.get(row.id) ?? null,
      runHealth: runHealth.get(row.id) ?? {},
      unresolvedSourceDeletions: (() => {
        const latest = runHealth.get(row.id)?.mirror;
        const stats = latest?.stats as { deletedAtSource?: unknown[] } | undefined;
        return (stats?.deletedAtSource ?? [])
          .map(String)
          .filter((sourceRef) => !resolvedKeys.has(`${row.id}:${sourceRef}`));
      })(),
    })),
    runs,
    currencies,
    canManage,
    sourceTypes: SOURCE_TYPES.map((s) => ({
      source: s.source,
      displayName: s.displayName,
      authKind: s.authKind,
      blurb: s.blurb,
      configFields: s.configFields,
      attachmentUnavailableReason: s.attachmentUnavailableReason,
      mappingGroups: s.mappingGroups ?? [],
      syncCapabilities: s.syncCapabilities,
      secretFields: s.secretFields.map((f) => ({ ...f })),
      oauthSetup: s.oauthSetup ?? null,
    })),
  });
}

/** Create a connection. Secrets are sealed at rest and never echoed back. */
async function createConnectionRoute(gate: Authz, body: z.output<typeof connectionCreateBody>) {
  const orgId = gate.user.orgId;
  const actorId = gate.user.id;
  const manifest = sourceType(String(body.source ?? ""));
  if (!manifest) return NextResponse.json({ error: "unknown source type" }, { status: 400 });

  const displayName = String(body.displayName ?? "").trim() || manifest.displayName;
  const suppliedConfig =
    body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? body.config
      : {};
  const ownedError = callerOwnedConfigRefusal(suppliedConfig);
  if (ownedError) {
    return NextResponse.json(
      { error: ownedError, errorCode: "OAUTH_IDENTITY_REFUSED" },
      { status: 400 },
    );
  }
  let config = declaredSourceConfig(manifest, suppliedConfig);
  try {
    config = canonicalConnectionMappingConfig(config, manifest.mappingGroups ?? []);
  } catch (cause) {
    // Mapping defects are typed 400 at their origin with the offending key;
    // anything else (a corrupt saved shape) answers the static fallback.
    if (cause instanceof ConnectionMappingError) return apiErrorResponse(cause);
    console.error("[platform/connections] mapping config validation failed", cause);
    return NextResponse.json({ error: "Connection mappings are unavailable" }, { status: 400 });
  }
  const urlError = await connectionConfigUrlRefusal(config);
  if (urlError) {
    return NextResponse.json(
      { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" },
      { status: 400 },
    );
  }

  const configError = validateSourceConfig(manifest, config, { today: await businessToday(orgId) });
  if (configError) return NextResponse.json({ error: configError }, { status: 400 });
  if (
    Object.values(decodeEntityMappings(config.entityMappings).entities).some((rows) => rows.length)
  )
    return NextResponse.json(
      { error: "Save the connection first, then select its source and native mapping fields" },
      { status: 422 },
    );

  // Seal any provided secret fields (all-or-nothing per field).
  const provided: Record<string, string> = {};
  for (const f of manifest.secretFields) {
    const v = body.secrets?.[f.key];
    if (v !== undefined && v !== null && String(v) !== "") {
      const secretError = validateSourceSecret(manifest.source, f.key, String(v));
      if (secretError) return NextResponse.json({ error: secretError }, { status: 400 });
      provided[f.key] = String(v);
    }
  }
  const hasAllSecrets = manifest.secretFields.every((f) => !f.required || provided[f.key]);
  if (manifest.source === "qbd" && !hasAllSecrets) {
    return NextResponse.json({ error: "Web Connector password is required" }, { status: 400 });
  }
  const sealed =
    Object.keys(provided).length > 0
      ? sealJson(provided, { orgId, purpose: "connection.secrets" })
      : null;
  // OAuth connections still need the consent flow before they can run, even
  // once their app credentials are saved — so they start "unconfigured".
  const status =
    manifest.authKind === "oauth2"
      ? "unconfigured"
      : sealed && hasAllSecrets
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
      secrets: sealed,
    });
    return NextResponse.json({ id });
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? "create failed";
    // Unique (org, displayName) collision → friendly message.
    if (/connections_org_name/.test(msg)) {
      return NextResponse.json(
        { error: "a connection with that name already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const GET = defineRoute({
  authorize: async () => {
    const configure = await guardPermission("admin.setup.manage");
    if (!(configure instanceof NextResponse)) return configure;
    return guardPermission("sync.run");
  },
  feature: {
    none: "Connection setup and synchronization permissions provide the access boundary for this org-wide platform surface.",
  },
  scope: "unrestricted",
  handler: async ({ authz }) => listConnectionRoutes(authz),
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "Connection setup permission governs this org-wide platform configuration." },
  scope: "unrestricted",
  body: connectionCreateBody,
  handler: async ({ authz, body }) => createConnectionRoute(authz, body),
});
