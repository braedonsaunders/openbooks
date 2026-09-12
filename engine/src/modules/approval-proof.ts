import { actorHasPermission } from "../actor-permissions.ts";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../db.ts";

export function stableModuleJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableModuleJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableModuleJson(child)}`)
    .join(",")}}`;
}

/** The projection boundary consumes persisted, signed approval evidence, never a caller boolean. */
export async function assertModuleApproval(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    actorId: string;
    manifest: Record<string, unknown>;
    approvalRunId?: string;
    grants: readonly string[];
    rehearsalProductionOrgId?: string;
  },
): Promise<void> {
  if (!(await actorHasPermission(tx, opts.orgId, opts.actorId, "admin.customization.manage"))) {
    throw new Error("admin.customization.manage is required to activate a module");
  }
  for (const permission of opts.grants) {
    if (!(await actorHasPermission(tx, opts.orgId, opts.actorId, permission))) {
      throw new Error(`module activation authority no longer covers ${permission}`);
    }
  }
  const pending = (
    await tx.execute<{ id: string }>(sql`
    select g.id from flow_gates g join modules m on m.org_id = g.org_id and m.id = g.subject_id
    where m.org_id = ${opts.orgId} and m.key = ${opts.manifest.key as string}
      and g.subject_kind = 'module_version' and g.status = 'pending' limit 1`)
  ).rows[0];
  if (pending)
    throw new Error(
      "module has a proposal awaiting approval; cancel it before changing the live version",
    );
  const permissions = opts.manifest.permissions as unknown[];
  const contributions = opts.manifest.contributions as { kind: string }[];
  const requiresApproval =
    permissions.length > 0 || contributions.some((c) => c.kind !== "page");
  if (!requiresApproval && !opts.approvalRunId) return;

  if (opts.rehearsalProductionOrgId) {
    const sandbox = (
      await tx.execute<{ id: string }>(sql`
      select o.id from orgs o join sandboxes s on s.org_id = o.id
      where o.id = ${opts.orgId} and o.env_kind = 'sandbox'
        and o.sandbox_of = ${opts.rehearsalProductionOrgId}
        and s.production_org_id = ${opts.rehearsalProductionOrgId} and s.status = 'ready'
      limit 1`)
    ).rows[0];
    if (!sandbox)
      throw new Error(
        "module rehearsal requires a ready sandbox linked to the production org",
      );
    return;
  }

  if (!opts.approvalRunId) {
    // Re-applying the exact approved live version is safe, including enabling
    // its preserved projections after deactivation. This cannot widen grants.
    const current = (
      await tx.execute<{
        manifest: unknown;
        granted_permissions: string[];
      }>(sql`
      select v.manifest, m.granted_permissions from modules m
      join module_versions v on v.org_id = m.org_id and v.id = m.active_version_id
      where m.org_id = ${opts.orgId} and m.key = ${opts.manifest.key as string}
        and v.status = 'active' limit 1`)
    ).rows[0];
    if (
      current &&
      stableModuleJson(current.manifest) === stableModuleJson(opts.manifest) &&
      stableModuleJson(current.granted_permissions) ===
        stableModuleJson(opts.grants)
    )
      return;
    throw new Error("module activation requires a signed approval");
  }
  const run = (
    await tx.execute<{
      context: {
        manifest: unknown;
        granted: string[];
        requesterId: string;
        baseVersionId: string | null;
      };
      active_version_id: string | null;
      subject_id: string;
    }>(sql`
    select r.context, r.subject_id, m.active_version_id from flow_runs r
    join modules m on m.org_id = r.org_id and m.id = r.subject_id
    where r.org_id = ${opts.orgId} and r.id = ${opts.approvalRunId}
      and r.subject_kind = 'module_version' and r.status in ('waiting', 'failed')
      and m.key = ${opts.manifest.key as string} limit 1`)
  ).rows[0];
  if (
    !run ||
    run.context.requesterId === opts.actorId ||
    run.active_version_id !== run.context.baseVersionId ||
    stableModuleJson(run.context.manifest) !==
      stableModuleJson(opts.manifest) ||
    stableModuleJson(run.context.granted) !== stableModuleJson(opts.grants)
  ) {
    throw new Error(
      "approval does not authorize this module version and grant",
    );
  }
  if (!(await actorHasPermission(tx, opts.orgId, run.context.requesterId, "admin.customization.manage"))) {
    throw new Error("module requester no longer holds admin.customization.manage");
  }
  for (const permission of opts.grants) {
    if (!(await actorHasPermission(tx, opts.orgId, run.context.requesterId, permission))) {
      throw new Error(`module requester authority no longer covers ${permission}`);
    }
  }
  const gates = (
    await tx.execute<{
      status: string;
      decided_by: string | null;
      signature: string | null;
    }>(sql`
    select status, decided_by, signature from flow_gates
    where org_id = ${opts.orgId} and run_id = ${opts.approvalRunId} and subject_kind = 'module_version'`)
  ).rows;
  const approved = gates.filter((gate) => gate.status === "approved");
  if (
    !approved.length ||
    gates.some((gate) => !["approved", "cancelled"].includes(gate.status)) ||
    !approved.some((gate) => gate.decided_by === opts.actorId) ||
    approved.some(
      (gate) =>
        gate.decided_by === run.context.requesterId ||
        (requiresApproval && !gate.signature?.trim()),
    )
  ) {
    throw new Error(
      "module activation requires a resolved signed approval quorum",
    );
  }
}
