import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { listConnections, SOURCE_TYPES } from "@openbooks/engine/sync/connection";
import { loadConnectionDashboardData } from "@openbooks/engine/sync/connection-admin";
import { can, guardPermission, type Authz } from "@/lib/authz";
import { createConnectionAction } from "@/lib/sync/connection-admin-actions";

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
    outOfPeriodDatePolicy: c.outOfPeriodDatePolicy,
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
  const result = await createConnectionAction(
    { orgId: gate.user.orgId, userId: gate.user.id },
    body,
  );
  return NextResponse.json(result.body, { status: result.status });
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
