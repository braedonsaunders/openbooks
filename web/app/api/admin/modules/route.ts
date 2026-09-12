import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import {
  MODULE_VERSION_APPROVAL_SUBJECT,
  ModuleLifecycleError,
  cancelModuleApprovalRequest,
  deactivateModule,
  reactivateModule,
} from "@openbooks/engine/src/modules/lifecycle.ts";
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { can, guardPermission, resolveUserAuthz } from "../../../../lib/authz";
import { isUuid, parseListParams, pickString } from "../../../../lib/list-params";

import { applyModule, diffModule, installModuleStaged, rollbackModule } from "@/lib/application/modules";
import { ApplicationError } from "@/lib/application/errors";
import { resolveActiveEnv } from "@/lib/org-access";
import { ModuleInstallError } from "@openbooks/engine/src/modules/installer.ts";
import { describeRehearsal, discardRehearsal, promoteRehearsal, stageModuleRehearsal, ModuleRehearsalError } from "@openbooks/engine/src/modules/rehearsal.ts";

export const runtime = "nodejs";

/**
 * Module lifecycle surface for admins and agents.
 *
 * GET lists the org's modules with their live version and pending-approval
 * count; `?key=` adds versions, pending gates, and the full audit evidence
 * (before/after envelopes included — agents need the bytes, not a summary).
 *
 * POST mutates through the lifecycle functions only — deactivate, reactivate,
 * cancel a pending approval request. Approvals themselves are decided in the
 * approvals worklist through decideGate (quorum, delegation, signatures);
 * this route never approves, so there is no second decision path. Every
 * mutation audits with actor + before/after + reason inside the lifecycle.
 *
 * Gated by `apps.manage`, with no feature flag. The `apps` feature governs
 * the apps runtime; installed modules project into live surfaces whether or
 * not that flag is on, so gating this door on it would hide the controls for
 * projections that are still rendering.
 */

type ModuleListRow = {
  key: string;
  name: string;
  description: string | null;
  status: string;
  grantedPermissions: unknown;
  updatedAt: string;
  version: string | null;
  versionStatus: string | null;
  manifest: unknown;
  pendingCount: unknown;
}

function summarize(row: ModuleListRow) {
  const manifest =
    typeof row.manifest === "object" && row.manifest !== null
      ? (row.manifest as { contributions?: unknown })
      : null;
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    versionStatus: row.versionStatus,
    contributionCount: Array.isArray(manifest?.contributions) ? manifest.contributions.length : 0,
    grantedPermissions: Array.isArray(row.grantedPermissions) ? row.grantedPermissions : [],
    pendingApprovals: Number(row.pendingCount ?? 0),
    updatedAt: row.updatedAt,
  };
}

/** List modules, with the same search/status/pagination contract as the page. */
export async function GET(req: Request) {
  const gate = await guardPermission("apps.manage");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;

  const url = new URL(req.url);
  const sp: Record<string, string | undefined> = {};
  for (const [k, v] of url.searchParams) sp[k] = v;
  const params = parseListParams(sp, { sort: "name", allowedSorts: ["name"] as const, perPage: 50 });
  const status = pickString(sp.status);
  const key = pickString(sp.key);

  const where = sql`m.org_id = ${orgId}
    ${status ? sql` and m.status = ${status}` : sql``}
    ${params.q ? sql` and (m.name ilike ${"%" + params.q + "%"} or m.key ilike ${"%" + params.q + "%"})` : sql``}
    ${key ? sql` and m.key = ${key}` : sql``}`;

  const [rows, totalRow] = await Promise.all([
    db.execute<ModuleListRow>(sql`
      select m.key, m.name, m.description, m.status,
             m.granted_permissions as "grantedPermissions", m.updated_at as "updatedAt",
             v.version, v.status as "versionStatus", v.manifest,
             (select count(*) from flow_gates g
               where g.org_id = m.org_id
                 and g.subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
                 and g.subject_id = m.id
                 and g.status = 'pending') as "pendingCount"
        from modules m
        left join module_versions v on v.id = m.active_version_id and v.org_id = m.org_id
       where ${where}
       order by m.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute<{ n: unknown }>(sql`select count(*) as n from modules m where ${where}`),
  ]);

  const modules = rows.rows.map(summarize);
  if (key) {
    const found = modules.find((m) => m.key === key);
    if (!found) return NextResponse.json({ error: "module not found" }, { status: 404 });
    const moduleId = (
      await db.execute<{ id: string }>(sql`
        select id from modules where org_id = ${orgId} and key = ${key} limit 1`)
    ).rows[0]?.id;
    if (!moduleId) return NextResponse.json({ error: "module not found" }, { status: 404 });
    const [versions, gates, audit] = await Promise.all([
      db.execute(sql`
        select id, version, status, manifest, created_at as "createdAt", updated_at as "updatedAt"
          from module_versions where org_id = ${orgId} and module_id = ${moduleId}
          order by created_at desc`),
      db.execute(sql`
        select g.id as "gateId", coalesce(r.context->>'version', '') as version,
               coalesce(r.context->>'op', '') as op, g.status, g.created_at as "createdAt"
          from flow_gates g
          join flow_runs r on r.org_id = g.org_id and r.id = g.run_id
         where g.org_id = ${orgId}
           and g.subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
           and g.subject_id = ${moduleId}
           and g.status = 'pending'
         order by g.created_at`),
      db.execute(sql`
        select a.table_name as "tableName", a.row_id as "rowId", a.action, a.changes,
               a.actor_id as "actorId", a.at
          from audit_log a
         where a.org_id = ${orgId}
           and ((a.table_name = 'modules' and a.row_id = ${moduleId})
                or (a.table_name = 'module_versions'
                    and a.row_id in (select id from module_versions
                                     where org_id = ${orgId} and module_id = ${moduleId})))
         order by a.at desc limit 50`),
    ]);
    return NextResponse.json({
      module: {
        ...found,
        versions: versions.rows,
        pendingGates: gates.rows,
        audit: audit.rows,
      },
    });
  }
  return NextResponse.json({
    modules,
    total: Number(totalRow.rows[0]?.n ?? 0),
    page: params.page,
    perPage: params.perPage,
  });
}

const ACTIONS = ["deactivate", "reactivate", "cancelApproval", "install", "diff", "apply", "rollback", "stageRehearsal", "describeRehearsal", "discardRehearsal", "promoteRehearsal"] as const;

/** Lifecycle mutations — deactivate, reactivate, or cancel a pending request. */
export async function POST(req: Request) {
  const gate = await guardPermission("apps.manage");
  if (gate instanceof NextResponse) return gate;
  const actorId = gate.user.id;
  const orgId = gate.user.orgId;

  const parsed = await parseJsonBody(req, jsonObject);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action)) {
    return NextResponse.json({ error: "unknown module action" }, { status: 400 });
  }
  if (body.reason != null && typeof body.reason !== "string") {
    return NextResponse.json({ error: "reason must be text" }, { status: 400 });
  }
  const reason = body.reason === undefined || body.reason === null ? undefined : String(body.reason).trim();
  if (reason !== undefined && (reason.length === 0 || reason.length > 500)) {
    return NextResponse.json({ error: "reason must be 1–500 characters when given" }, { status: 400 });
  }

  if (["install", "diff", "stageRehearsal"].includes(body.action) && typeof body.key === "string"
    && body.manifest && typeof body.manifest === "object" && !Array.isArray(body.manifest)
    && (body.manifest as Record<string, unknown>).key !== body.key) {
    return NextResponse.json({ error: "Manifest key must match the selected module" }, { status: 400 });
  }

  try {
    const context = { authz: gate, source: "api" as const, requestId: crypto.randomUUID(), apiKeyId: null };
    if (["install", "diff", "apply", "rollback"].includes(body.action)) {
      if (body.action === "install") return NextResponse.json(await installModuleStaged(context, { manifest: body.manifest, reason }));
      if (body.action === "diff") return NextResponse.json(await diffModule(context, { manifest: body.manifest }));
      if (body.action === "apply") {
        if (typeof body.gateId !== "string" || typeof body.signature !== "string" || !body.signature.trim()) {
          return NextResponse.json({ error: "gateId and signature are required" }, { status: 400 });
        }
        return NextResponse.json(await applyModule(context, { gateId: body.gateId, signature: body.signature.trim(), comment: reason }));
      }
      if (typeof body.key !== "string" || (body.versionId != null && (typeof body.versionId !== "string" || !isUuid(body.versionId)))) {
        return NextResponse.json({ error: "key and a valid versionId are required" }, { status: 400 });
      }
      return NextResponse.json(await rollbackModule(context, { key: body.key, versionId: body.versionId as string | undefined, reason }));
    }
    if (body.action.endsWith("Rehearsal")) {
      if (!can(gate, "admin.customization.manage") || !can(gate, "admin.sandboxes.manage") || gate.user.envKind !== "production") {
        return NextResponse.json({ error: "Manage rehearsals from production with customization and sandbox permissions" }, { status: 403 });
      }
      if (typeof body.sandboxOrgId !== "string" || !isUuid(body.sandboxOrgId)) {
        return NextResponse.json({ error: "sandboxOrgId must be a uuid" }, { status: 400 });
      }
      const sandbox = await resolveActiveEnv({ id: gate.user.homeUserId, orgId: gate.user.homeOrgId, isSuperAdmin: gate.user.isSuperAdmin }, body.sandboxOrgId);
      if (!sandbox || sandbox.envKind !== "sandbox" || sandbox.productionOrgId !== orgId) {
        return NextResponse.json({ error: "sandbox is not available to this actor and organization" }, { status: 403 });
      }
      if (body.action !== "stageRehearsal" && typeof body.key !== "string") {
        return NextResponse.json({ error: "key is required" }, { status: 400 });
      }
      // Resolve the real sandbox identity and its current grants through the
      // same environment resolver used by the workspace switcher.
      const result = await withBypassContext(async () => {
        const sandboxAuth = await resolveUserAuthz({ ...gate.user, id: sandbox.actingUserId, orgId: sandbox.orgId, envKind: "sandbox" });
        if (!can(sandboxAuth, "admin.customization.manage")) throw new ModuleRehearsalError("Sandbox customization permission is required", 403);
        const options = { productionOrgId: orgId, sandboxOrgId: sandbox.orgId, actorId: sandbox.actingUserId, key: body.key as string, reason };
        if (body.action === "stageRehearsal") return stageModuleRehearsal({ ...options, manifest: body.manifest, installerEffectivePermissions: [...sandboxAuth.permissions] });
        if (body.action === "describeRehearsal") return describeRehearsal(options);
        if (body.action === "discardRehearsal") return discardRehearsal(options);
        return promoteRehearsal({ ...options, actorId, installerEffectivePermissions: [...gate.permissions] });
      });
      return NextResponse.json(result);
    }
    if (body.action === "cancelApproval") {
      if (typeof body.moduleId !== "string" || !isUuid(body.moduleId)) {
        return NextResponse.json({ error: "moduleId must be a uuid" }, { status: 400 });
      }
      const result = await cancelModuleApprovalRequest({ orgId, actorId, moduleId: body.moduleId, reason });
      return NextResponse.json(result);
    }
    if (typeof body.key !== "string" || body.key.length === 0 || body.key.length > 64) {
      return NextResponse.json({ error: "key must be a 1–64 character module key" }, { status: 400 });
    }
    const result =
      body.action === "deactivate"
        ? await deactivateModule({ orgId, actorId, key: body.key, reason })
        : await reactivateModule({ orgId, actorId, key: body.key, reason });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ModuleLifecycleError || error instanceof ModuleRehearsalError || error instanceof ModuleInstallError || error instanceof ApplicationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
