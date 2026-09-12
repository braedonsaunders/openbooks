import { stableModuleJson } from "./approval-proof.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg, type SqlExecutor } from "../db.ts";
import { decideGate, GateError, type DecideGateResult } from "../flows/gates.ts";
import {
  resolveAssigneeUsers,
  verifyUser,
} from "../flows/targets.ts";
import { actorHasPermission } from "../actor-permissions.ts";
import { isCataloguePermission, permissionSetCovers } from "../permissions.ts";
import {
  MODULE_PLATFORM_PERMISSIONS_MIRROR,
  isModulePermission,
} from "./module-catalogue.ts";
import {
  ModuleCapabilityError,
  addedModuleCapabilities,
  assertModuleSeparationOfDuties,
  resolveModuleGrants,
} from "./capabilities.ts";
import {
  installModule,
  ModuleInstallError,
  uninstallModule,
  upgradeModule,
  validateModuleInstallManifest,
} from "./installer.ts";

/** Module proposals use the existing gate worklist. Gate decisions, activation,
 * projections and audit evidence share one tenant transaction. */

export class ModuleLifecycleError extends GateError {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModuleLifecycleError";
    this.status = status;
  }
}

/** FlowGates subject kind for module approvals. Not a document kind, so the engine treats it fail-closed. */
export const MODULE_VERSION_APPROVAL_SUBJECT = "module_version";

/** Name of the single org-wide system flow lifecycle gates hang off. */
export const MODULE_APPROVAL_FLOW_NAME = "Module version approvals";

/** Gate node in the system flow graph every lifecycle gate references. */
const MODULE_APPROVAL_NODE_ID = "module-approval";

const MAX_ASSIGNEES = 20;

/** Slug shape the storage CHECK enforces (0107; 0110 only widens length to 1). */
const SLUG = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/;

export type ModuleApprovalAssignee =
  { type: "user"; userId: string } | { type: "role"; role: string };

interface ApprovalProposal {
  op: "install" | "upgrade";
  key: string;
  name: string;
  version: string;
  manifest: unknown;
  granted: string[];
  withheld: string[];
  requested: string[];
  addsCapabilities: string[];
  requesterId: string;
  reason: string;
}

export interface RequestModuleApprovalOptions {
  orgId: string;
  requesterId: string;
  /** Raw proposal. The installer re-validates it at activation; this is the fast path, not the boundary. */
  manifest: unknown;
  /** Admin-approved subset of the request. Defaults to everything requested. Must be a subset of requested. */
  grantedPermissions?: string[];
  /**
   * The requesting actor's resolved permission set. Required, no default:
   * the staged grant is approved ∩ requested ∩ effective, and a caller that
   * cannot state its authority must not propose.
   */
  installerEffectivePermissions: readonly string[];
  /** Who may approve. Must resolve to at least one in-org user or the request fails closed. */
  assignees: ModuleApprovalAssignee[];
  quorum?: "any" | "all";
  /** Pass through to the gate: approval then requires a typed attestation (the 3c signed-apply seam). */
  signatureRequired?: boolean;
  /** Deprecated compatibility option. Module approvals always require a distinct approver. */
  allowSelfApproval?: boolean;
  /** Why: recorded on every audit row this request writes. */
  reason?: string;
  rollback?: { restoredFromVersionId: string; replacedVersionId: string };
}

export interface ModuleApprovalRequest {
  moduleId: string;
  runId: string;
  flowId: string;
  gateIds: string[];
  granted: string[];
  withheld: string[];
  /** Requested capabilities beyond the live version's (empty for a narrowing repeat). Shown to the approver. */
  addsCapabilities: string[];
  /** True when an identical pending proposal already owned a gate: no new rows were written. */
  replayed: boolean;
}

export interface DecideModuleApprovalOptions {
  gateId: string;
  decision: "approved" | "rejected";
  userId: string;
  comment?: string;
  signature?: string;
  /**
   * The deciding actor's resolved permission set. When supplied, the recorded
   * grant narrows to granted ∩ effective (fail-closed). Defaults to
   * preserving the approved grant: the gate approval itself is the authority.
   */
  approverEffectivePermissions?: readonly string[];
  allowSelfApproval?: boolean;
}

export interface ModuleApprovalDecision {
  resumed: "approve" | "reject" | null;
  moduleId: string;
  versionId: string | null;
  versionStatus: string | null;
  runStatus: "waiting" | "completed";
}

async function writeAudit(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    table: string;
    rowId: string;
    action: "insert" | "update";
    event: string;
    reason: string;
    before: unknown;
    after: unknown;
    actorId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${opts.orgId}, ${opts.table}, ${opts.rowId}, ${opts.action},
            ${JSON.stringify({ event: opts.event, reason: opts.reason, before: opts.before, after: opts.after })}::jsonb,
            ${opts.actorId})`);
}

type ModuleRow = {
  id: string;
  kind: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  active_version_id: string | null;
  granted_permissions: string[];
};

type ApprovalRunContext = {
  kind: "module_approval";
  op: "install" | "upgrade";
  moduleKey: string;
  version: string;
  manifest: unknown;
  granted: string[];
  withheld: string[];
  requested: string[];
  addsCapabilities: string[];
  requesterId: string;
  reason: string;
  baseVersionId: string | null;
  rollback?: { restoredFromVersionId: string; replacedVersionId: string };
};

/**
 * Fast-path proposal shape check. Naming defects early with a ModuleLifecycleError;
 * canonical strictness stays the installer's job at activation.
 */
function readProposalShape(raw: unknown): {
  key: string;
  name: string;
  version: string;
  permissions: string[];
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ModuleLifecycleError(
      "invalid proposal: manifest must be an object",
    );
  }
  const m = raw as Record<string, unknown>;
  if (
    typeof m.key !== "string" ||
    !SLUG.test(m.key) ||
    m.key.length < 1 ||
    m.key.length > 64
  ) {
    throw new ModuleLifecycleError(
      "invalid proposal: key must be a 1–64 char slug (a-z, 0-9, -)",
    );
  }
  if (typeof m.name !== "string" || m.name.length < 1 || m.name.length > 120) {
    throw new ModuleLifecycleError(
      "invalid proposal: name must be 1–120 chars",
    );
  }
  if (
    typeof m.version !== "string" ||
    m.version.length > 32 ||
    !VERSION.test(m.version)
  ) {
    throw new ModuleLifecycleError(
      "invalid proposal: version must look like 1.0.0",
    );
  }
  const permissions = m.permissions ?? [];
  if (
    !Array.isArray(permissions) ||
    permissions.length > 50 ||
    permissions.some((p) => typeof p !== "string")
  ) {
    throw new ModuleLifecycleError(
      "invalid proposal: permissions must be a list of at most 50 permission strings",
    );
  }
  const contributions = m.contributions ?? [];
  if (!Array.isArray(contributions) || contributions.length > 200) {
    throw new ModuleLifecycleError(
      "invalid proposal: contributions must be a list of at most 200 entries",
    );
  }
  return {
    key: m.key,
    name: m.name,
    version: m.version,
    permissions: permissions as string[],
  };
}

function resolveProposalGrants(opts: {
  requested: string[];
  grantedPermissions?: string[];
  installerEffectivePermissions: readonly string[];
}): { granted: string[]; withheld: string[] } {
  const approved = opts.grantedPermissions ?? opts.requested;
  if (!Array.isArray(approved) || approved.some((p) => typeof p !== "string")) {
    throw new ModuleLifecycleError(
      "invalid proposal: grantedPermissions must be a list of permission strings",
    );
  }
  if (
    !opts.installerEffectivePermissions ||
    !Array.isArray(opts.installerEffectivePermissions) ||
    opts.installerEffectivePermissions.some((p) => typeof p !== "string")
  ) {
    throw new ModuleLifecycleError(
      "invalid proposal: installerEffectivePermissions (the requesting actor's resolved permission set) is required",
    );
  }
  // Same two engine-closed layers as the installer: platform catalogue, then
  // the module vocabulary mirror. No caller input influences either check.
  for (const p of opts.requested) {
    if (!isCataloguePermission(p)) {
      throw new ModuleLifecycleError(
        `invalid proposal: unknown permission: ${p}`,
      );
    }
    if (!isModulePermission(p)) {
      throw new ModuleLifecycleError(
        `invalid proposal: permission "${p}" is outside the module vocabulary`,
      );
    }
  }
  try {
    const { granted, withheld } = resolveModuleGrants({
      requested: opts.requested,
      approved: approved as string[],
      installerEffective: opts.installerEffectivePermissions,
      knownPermissions: MODULE_PLATFORM_PERMISSIONS_MIRROR,
    });
    return { granted, withheld };
  } catch (error) {
    if (error instanceof ModuleCapabilityError) {
      throw new ModuleLifecycleError(`invalid proposal: ${error.message}`, 400);
    }
    throw error;
  }
}

/** The org-wide system flow lifecycle gates hang off; created once, reused forever. */
async function ensureApprovalFlow(
  tx: SqlExecutor,
  orgId: string,
): Promise<string> {
  const existing = (
    await tx.execute<{ id: string }>(sql`
      select id from flows
       where org_id = ${orgId} and subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
         and name = ${MODULE_APPROVAL_FLOW_NAME}
       limit 1`)
  ).rows[0];
  if (existing) return existing.id;
  // Minimal gate graph in the exact shape seedApprovalFlow proves parses:
  // the run is inserted directly (never planned from a trigger), and resume
  // plans from the gate node, whose branch edges are intentionally absent —
  // an approval carries no authored side effects; activation is the wrapper's job.
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: "trigger",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", trigger: { trigger: "on_submit" } },
      },
      {
        id: MODULE_APPROVAL_NODE_ID,
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: {
            title: "Module version approval",
            assignees: [{ type: "role", role: "admin" }],
            mode: "any",
          },
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "trigger",
        target: MODULE_APPROVAL_NODE_ID,
        sourceHandle: "next",
      },
    ],
  };
  const inserted = (
    await tx.execute<{ id: string }>(sql`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${randomUUID()}, ${orgId}, ${MODULE_APPROVAL_FLOW_NAME}, ${MODULE_VERSION_APPROVAL_SUBJECT},
              true, ${JSON.stringify(graph)}::jsonb)
      on conflict do nothing
      returning id`)
  ).rows[0];
  if (inserted) return inserted.id;
  const raced = (
    await tx.execute<{ id: string }>(sql`
      select id from flows
       where org_id = ${orgId} and subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
         and name = ${MODULE_APPROVAL_FLOW_NAME}
       limit 1`)
  ).rows[0];
  if (!raced)
    throw new ModuleLifecycleError(
      "module approval flow could not be recorded",
      500,
    );
  return raced.id;
}

function gateTitle(proposal: ApprovalProposal): string {
  const base = `Module ${proposal.op}: ${proposal.key} ${proposal.version}`;
  if (proposal.op === "upgrade" && proposal.addsCapabilities.length > 0) {
    return `${base} (adds ${proposal.addsCapabilities.join(", ").slice(0, 80)})`.slice(
      0,
      200,
    );
  }
  return base.slice(0, 200);
}

async function pendingGates(
  tx: SqlExecutor,
  opts: { orgId: string; moduleId: string },
): Promise<{ gateId: string; runId: string; version: string }[]> {
  return (
    await tx.execute<{ gateId: string; runId: string; version: string }>(sql`
      select g.id as "gateId", g.run_id as "runId",
             coalesce((r.context->>'version'), '') as version
        from flow_gates g
        join flow_runs r on r.org_id = g.org_id and r.id = g.run_id
       where g.org_id = ${opts.orgId}
         and g.subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
         and g.subject_id = ${opts.moduleId}
         and g.status = 'pending'
       order by g.created_at`)
  ).rows;
}

async function requestApproval(
  op: "install" | "upgrade",
  opts: RequestModuleApprovalOptions & { key?: string },
): Promise<ModuleApprovalRequest> {
  const canonical = validateModuleInstallManifest(opts.manifest);
  const shape = readProposalShape(canonical);
  opts = { ...opts, manifest: canonical };
  if (op === "upgrade" && shape.key !== opts.key) {
    throw new ModuleLifecycleError(
      `upgrade target is module "${opts.key}" but the manifest declares "${shape.key}"`,
    );
  }
  const key = op === "upgrade" ? opts.key! : shape.key;
  const reason =
    opts.reason && opts.reason.length > 0
      ? opts.reason
      : op === "upgrade"
        ? "upgrade"
        : "install";
  if (
    !opts.assignees ||
    opts.assignees.length < 1 ||
    opts.assignees.length > MAX_ASSIGNEES
  ) {
    throw new ModuleLifecycleError(
      `invalid proposal: assignees must name 1–${MAX_ASSIGNEES} approver targets`,
    );
  }
  const quorum = opts.quorum ?? "any";
  if (quorum !== "any" && quorum !== "all") {
    throw new ModuleLifecycleError(
      'invalid proposal: quorum must be "any" or "all"',
    );
  }
  const { granted, withheld } = resolveProposalGrants({
    requested: shape.permissions,
    grantedPermissions: opts.grantedPermissions,
    installerEffectivePermissions: opts.installerEffectivePermissions,
  });

  return await withOrg(opts.orgId, async () => {
    const tx = db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + opts.orgId}, 0))`,
    );
    const requester = await verifyUser(opts.orgId, opts.requesterId);
    if (!requester) {
      throw new ModuleLifecycleError(
        "unknown requester: not an active user in this org",
        403,
      );
    }
    let moduleRow =
      (
        await tx.execute<ModuleRow>(sql`
        select id, kind, key, name, description, status, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and key = ${key}
          for update`)
      ).rows[0] ?? null;

    if (moduleRow && moduleRow.kind !== "module") throw new ModuleLifecycleError("app-backed modules use the Apps lifecycle", 409);
    if (op === "upgrade" && !moduleRow) {
      throw new ModuleLifecycleError(
        `module "${key}" is not installed; install it before requesting an upgrade`,
        404,
      );
    }
    if (op === "install" && moduleRow && moduleRow.active_version_id !== null) {
      throw new ModuleLifecycleError(
        `module "${key}" already has an active version; request an upgrade instead`,
        409,
      );
    }

    if (op === "upgrade" && moduleRow) {
      const existing = (
        await tx.execute<{ id: string }>(sql`
        select id from module_versions where org_id = ${opts.orgId}
          and module_id = ${moduleRow.id} and version = ${shape.version} limit 1`)
      ).rows[0];
      if (existing)
        throw new ModuleLifecycleError(
          "an upgrade must append a new version label",
          409,
        );
    }

    // Idempotent replay: the same proposal already owns a pending gate.
    if (moduleRow) {
      const pending = await pendingGates(tx, {
        orgId: opts.orgId,
        moduleId: moduleRow.id,
      });
      if (pending.length > 0) {
        const same = pending.filter((g) => g.version === shape.version);
        if (same.length > 0) {
          const runId = same[0]!.runId;
          const run = (
            await tx.execute<{
              context: ApprovalRunContext;
              flow_id: string;
            }>(sql`
              select context, flow_id from flow_runs where org_id = ${opts.orgId} and id = ${runId} limit 1`)
          ).rows[0];
          if (
            !run ||
            stableModuleJson(run.context.manifest) !==
              stableModuleJson(opts.manifest) ||
            JSON.stringify(run.context.granted) !== JSON.stringify(granted) ||
            run.context.requesterId !== opts.requesterId
          ) {
            throw new ModuleLifecycleError(
              "a different proposal already uses this version label",
              409,
            );
          }
          return {
            moduleId: moduleRow.id,
            runId,
            flowId: run?.flow_id ?? "",
            gateIds: same.map((g) => g.gateId),
            granted: (run?.context.granted as string[] | undefined) ?? granted,
            withheld:
              (run?.context.withheld as string[] | undefined) ?? withheld,
            addsCapabilities:
              (run?.context.addsCapabilities as string[] | undefined) ?? [],
            replayed: true,
          };
        }
        throw new ModuleLifecycleError(
          `module "${key}" already has a proposal (version ${pending[0]!.version || "unknown"}) awaiting approval; ` +
            `cancel it before proposing version ${shape.version}`,
          409,
        );
      }
    }

    // Capability delta the approver must see: everything for an install, the
    // lattice-reported additions for an upgrade.
    let addsCapabilities: string[];
    if (op === "install") {
      addsCapabilities = [...shape.permissions].sort();
    } else {
      const activeManifest = (
        await tx.execute<{ manifest: unknown }>(sql`
          select manifest from module_versions
           where org_id = ${opts.orgId} and id = ${moduleRow!.active_version_id}`)
      ).rows[0]?.manifest;
      const prev =
        typeof activeManifest === "object" &&
        activeManifest !== null &&
        Array.isArray((activeManifest as { permissions?: unknown }).permissions)
          ? (activeManifest as { permissions: unknown[] }).permissions.filter(
              (p): p is string => typeof p === "string",
            )
          : [];
      addsCapabilities = addedModuleCapabilities(prev, shape.permissions);
    }

    const proposal: ApprovalProposal = {
      op,
      key,
      name: shape.name,
      version: shape.version,
      manifest: opts.manifest,
      granted,
      withheld,
      requested: shape.permissions,
      addsCapabilities,
      requesterId: opts.requesterId,
      reason,
    };

    // Stage the modules row for a first install: identity + resolved grant,
    // NULL active version — a proposal, never an install. Upgrade proposals
    // stage nothing; the live version keeps serving until approval lands.
    let createdModule = false;
    if (op === "install" && !moduleRow) {
      const rawManifest = opts.manifest as Record<string, unknown>;
      const description =
        typeof rawManifest.description === "string"
          ? (rawManifest.description as string)
          : null;
      createdModule =
        (
          await tx.execute<{ id: string }>(sql`
            insert into modules (org_id, key, name, description, status, granted_permissions, created_by, updated_by)
            values (${opts.orgId}, ${key}, ${shape.name}, ${description},
                    'installed', ${JSON.stringify(granted)}::jsonb, ${opts.requesterId}, ${opts.requesterId})
            on conflict (org_id, key) do nothing
            returning id`)
        ).rows.length > 0;
      moduleRow = (
        await tx.execute<ModuleRow>(sql`
          select id, kind, key, name, description, status, active_version_id, granted_permissions
            from modules where org_id = ${opts.orgId} and key = ${key}
            for update`)
      ).rows[0]!;
      await writeAudit(tx, {
        orgId: opts.orgId,
        table: "modules",
        rowId: moduleRow.id,
        action: createdModule ? "insert" : "update",
        event: "module_install_staged",
        reason,
        before: createdModule
          ? null
          : {
              status: moduleRow.status,
              active_version_id: moduleRow.active_version_id,
            },
        after: {
          key,
          name: shape.name,
          status: moduleRow.status,
          active_version_id: null,
          granted_permissions: granted,
        },
        actorId: opts.requesterId,
      });
    }
    const moduleId = moduleRow!.id;

    const flowId = await ensureApprovalFlow(tx, opts.orgId);
    const runId = randomUUID();
    const context: ApprovalRunContext = {
      kind: "module_approval",
      baseVersionId: moduleRow!.active_version_id,
      ...(opts.rollback ? { rollback: opts.rollback } : {}),
      op,
      moduleKey: key,
      version: shape.version,
      manifest: opts.manifest,
      granted,
      withheld,
      requested: shape.permissions,
      addsCapabilities,
      requesterId: opts.requesterId,
      reason,
    };
    await tx.execute(sql`
      insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status, context, created_by)
      values (${runId}, ${opts.orgId}, ${flowId}, ${MODULE_VERSION_APPROVAL_SUBJECT}, ${moduleId},
              'manual', 'waiting', ${JSON.stringify(context)}::jsonb, ${opts.requesterId})`);

    // Resolve approver targets now (mirrors createGate): role membership is
    // read at request time, zero resolved assignees fails closed.
    const resolvedAssignees = await resolveAssigneeUsers(opts.assignees, {
      orgId: opts.orgId,
      submitterUserId: opts.requesterId,
      values: {},
    });
    const assignees = resolvedAssignees.filter(
      (user) => user.id !== opts.requesterId,
    );
    if (assignees.length === 0) {
      throw new ModuleLifecycleError(
        "invalid proposal: assignees resolved to zero approvers",
        400,
      );
    }
    const title = gateTitle(proposal);
    const groupKey = `${runId}:${MODULE_APPROVAL_NODE_ID}`;
    // One row per assignee (a loop, not unnest: drizzle binds a bare JS
    // array as a row constructor, not a Postgres array). Small N (≤20).
    const gateIds: string[] = [];
    for (const assignee of assignees) {
      const inserted = (
        await tx.execute<{ id: string }>(sql`
          insert into flow_gates
            (org_id, flow_id, run_id, node_id, subject_kind, subject_id, title,
             assignee_user_id, group_key, quorum, status, signature_required, created_by)
          values (${opts.orgId}, ${flowId}, ${runId}, ${MODULE_APPROVAL_NODE_ID},
                  ${MODULE_VERSION_APPROVAL_SUBJECT}, ${moduleId}, ${title},
                  ${assignee.id}, ${groupKey}, ${quorum}, 'pending', ${shape.permissions.length > 0 || canonical.contributions.some((c) => c.kind !== "page") || opts.signatureRequired === true},
                  ${opts.requesterId})
          on conflict (run_id, node_id, assignee_user_id) do nothing
          returning id`)
      ).rows[0];
      if (inserted) gateIds.push(inserted.id);
    }
    if (gateIds.length === 0) {
      throw new ModuleLifecycleError(
        "module approval gate could not be recorded",
        500,
      );
    }
    const grantLine =
      `Requests ${shape.permissions.length} permission(s): ` +
      `${granted.length} granted${withheld.length > 0 ? `, ${withheld.length} withheld (${withheld.join(", ")})` : ""}.`;
    for (const assignee of assignees) {
      await tx.execute(sql`
        insert into notifications (org_id, user_id, kind, title, body, href)
        values (${opts.orgId}, ${assignee.id},
               'approval', ${`Approval requested: ${title}`},
               ${`${shape.name} ${shape.version} staged by ${requester.name}. ${grantLine} Reason: ${reason}`},
               '/approvals')`);
    }

    await writeAudit(tx, {
      orgId: opts.orgId,
      table: "modules",
      rowId: moduleId,
      action: "update",
      event:
        op === "upgrade"
          ? "module_upgrade_approval_requested"
          : "module_install_approval_requested",
      reason,
      before: {
        key,
        status: moduleRow!.status,
        active_version_id: moduleRow!.active_version_id,
        ...(opts.allowSelfApproval === true ? { allowSelfApproval: true } : {}),
      },
      after: {
        key,
        version: shape.version,
        run_id: runId,
        gate_ids: gateIds,
        assignees: assignees.map((a) => a.id),
        quorum,
        granted_permissions: granted,
        withheld_permissions: withheld,
        adds_capabilities: addsCapabilities,
      },
      actorId: opts.requesterId,
    });

    return {
      moduleId,
      runId,
      flowId,
      gateIds,
      granted,
      withheld,
      addsCapabilities,
      replayed: false,
    };
  });
}

/**
 * Propose a first install through a human approval. Stages the modules row
 * (NULL active version — nothing renders) and opens flow_gates rows the admin
 * decides via the existing worklist. Approval activates through installModule.
 */
export async function requestModuleInstallApproval(
  opts: RequestModuleApprovalOptions,
): Promise<ModuleApprovalRequest> {
  return requestApproval("install", opts);
}

/**
 * Propose an upgrade through a human approval. The live version keeps serving
 * until approval lands; approval activates through upgradeModule (append +
 * supersede + re-project, never history rewrites).
 */
export async function requestModuleUpgradeApproval(
  opts: RequestModuleApprovalOptions & { key: string },
): Promise<ModuleApprovalRequest> {
  return requestApproval("upgrade", opts);
}

function readRunContext(raw: unknown, runId: string): ApprovalRunContext {
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { kind?: unknown }).kind !== "module_approval"
  ) {
    throw new ModuleLifecycleError(
      `approval run ${runId} does not carry a module proposal`,
      500,
    );
  }
  const context = raw as ApprovalRunContext;
  if (
    (context.op !== "install" && context.op !== "upgrade") ||
    typeof context.moduleKey !== "string" ||
    typeof context.version !== "string" ||
    !Array.isArray(context.granted) ||
    typeof context.requesterId !== "string"
  ) {
    throw new ModuleLifecycleError(
      `approval run ${runId} carries a corrupt module proposal`,
      500,
    );
  }
  return context;
}

/**
 * Decide a module approval gate through the engine's decideGate — the same
 * conditional decide, authz, quorum, delegation, and signature enforcement
 * every financial approval rides — then apply the lifecycle outcome:
 *
 * - approve → installModule / upgradeModule with the approved grant (the
 *   installer projects, flips active, supersedes, and audits with the
 *   approver as actor and the decision comment as reason);
 * - reject  → the proposal stays staged and the denial is audited; nothing
 *   activates, deactivates, or deletes;
 * - quorum still collecting → no lifecycle effect; the proposal stays pending.
 *
 * Separation of duties is enforced BEFORE decideGate so a refused
 * self-approval leaves the gate pending, never half-decided.
 */
export async function decideModuleApproval(
  opts: DecideModuleApprovalOptions,
): Promise<ModuleApprovalDecision> {
  const gate = (await db.execute<{ subject_kind: string }>(sql`
    select subject_kind from flow_gates where id = ${opts.gateId} limit 1`)).rows[0];
  if (!gate || gate.subject_kind !== MODULE_VERSION_APPROVAL_SUBJECT) {
    throw new ModuleLifecycleError("gate is not a module approval", 404);
  }
  const outcome = await decideGate(opts);
  if (!outcome.moduleApproval)
    throw new ModuleLifecycleError("gate is not a module approval");
  return outcome.moduleApproval;
}

/** Invoked by the common gate entry point with its private decision executor. */
export async function decideModuleApprovalGate(
  opts: DecideModuleApprovalOptions,
  decide: (args: DecideModuleApprovalOptions) => Promise<DecideGateResult>,
): Promise<ModuleApprovalDecision> {
  const gate = (
    await db.execute<{
      id: string;
      org_id: string;
      run_id: string;
      subject_kind: string;
      subject_id: string;
      status: string;
    }>(sql`
      select id, org_id, run_id, subject_kind, subject_id, status
        from flow_gates where id = ${opts.gateId} limit 1`)
  ).rows[0];
  if (!gate) throw new ModuleLifecycleError("approval not found", 404);
  if (gate.subject_kind !== MODULE_VERSION_APPROVAL_SUBJECT) {
    throw new ModuleLifecycleError(
      `gate ${opts.gateId} is not a module approval`,
      400,
    );
  }
  return withOrg<ModuleApprovalDecision>(gate.org_id, async () => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + gate.org_id}, 0))`,
    );
    const run = (
      await db.execute<{ id: string; status: string; context: unknown }>(sql`
      select id, status, context from flow_runs
       where id = ${gate.run_id} and org_id = ${gate.org_id} limit 1`)
    ).rows[0];
    if (!run)
      throw new ModuleLifecycleError("module approval run not found", 500);
    const context = readRunContext(run.context, run.id);

    const moduleRow = (
      await db.execute<ModuleRow>(sql`
      select id, kind, key, name, description, status, active_version_id, granted_permissions
        from modules where org_id = ${gate.org_id} and id = ${gate.subject_id} for update`)
    ).rows[0];
    if (!moduleRow || moduleRow.kind !== "module" || moduleRow.key !== context.moduleKey) {
      throw new ModuleLifecycleError(
        "module approval subject is no longer staged",
        500,
      );
    }

    if (moduleRow.active_version_id !== context.baseVersionId) {
      throw new ModuleLifecycleError(
        "module changed since this approval was requested; request approval again",
        409,
      );
    }
    try {
      assertModuleSeparationOfDuties(context.requesterId, opts.userId);
    } catch (error) {
      if (error instanceof ModuleCapabilityError) {
        throw new ModuleLifecycleError(
          "the requester cannot approve their own module install",
          403,
        );
      }
      throw error;
    }

    if (opts.decision === "approved") {
      if (!(await actorHasPermission(db, gate.org_id, context.requesterId, "admin.customization.manage"))) {
        throw new ModuleLifecycleError("module requester no longer holds admin.customization.manage", 403);
      }
      for (const permission of context.granted) {
        const requesterHolds = await actorHasPermission(db, gate.org_id, context.requesterId, permission);
        const approverHolds = await actorHasPermission(db, gate.org_id, opts.userId, permission);
        const withinCallerCeiling = opts.approverEffectivePermissions === undefined ||
          permissionSetCovers(new Set(opts.approverEffectivePermissions), permission);
        if (!requesterHolds || !approverHolds || !withinCallerCeiling) {
          throw new ModuleLifecycleError(`module approval authority no longer covers ${permission}; request approval again`, 403);
        }
      }
    }

    const outcome = await decide({
      gateId: opts.gateId,
      decision: opts.decision,
      userId: opts.userId,
      ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
      ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
    });

    if (outcome.resumed === null) {
      return {
        resumed: null,
        moduleId: moduleRow.id,
        versionId: null,
        versionStatus: null,
        runStatus: "waiting",
      };
    }

    if (outcome.resumed === "reject") {
      const reason = opts.comment?.trim() || context.reason;
      await db.transaction(async (tx) => {
        await writeAudit(tx, {
          orgId: gate.org_id,
          table: "modules",
          rowId: moduleRow.id,
          action: "update",
          event: "module_approval_denied",
          reason,
          before: {
            key: moduleRow.key,
            status: moduleRow.status,
            active_version_id: moduleRow.active_version_id,
          },
          after: {
            key: moduleRow.key,
            status: moduleRow.status,
            active_version_id: moduleRow.active_version_id,
            denied_gate_id: opts.gateId,
            denied_version: context.version,
          },
          actorId: opts.userId,
        });
        // Module activation is the subject-specific continuation of the common gate decision.
        await tx.execute(sql`
        update flow_runs set status = 'completed', error = null, finished_at = now(), updated_at = now()
         where id = ${run.id} and org_id = ${gate.org_id}
           and subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}`);
      });
      return {
        resumed: "reject",
        moduleId: moduleRow.id,
        versionId: null,
        versionStatus: null,
        runStatus: "completed",
      };
    }

    // Approve: the installer applies the approved proposal — validation,
    // append-or-converge, projection, supersession, and its own audit rows —
    // with the approver as actor and the decision comment as reason.
    const reason = opts.comment?.trim() || context.reason;
    const effective = context.granted; // Every grant was rechecked against both live principals above.
    const installed =
      context.op === "upgrade"
        ? await upgradeModule({
            orgId: gate.org_id,
            actorId: opts.userId,
            key: context.moduleKey,
            manifest: context.manifest,
            approvalRunId: run.id,
            grantedPermissions: context.granted,
            installerEffectivePermissions: effective,
            reason,
          })
        : await installModule({
            orgId: gate.org_id,
            actorId: opts.userId,
            manifest: context.manifest,
            approvalRunId: run.id,
            grantedPermissions: context.granted,
            installerEffectivePermissions: effective,
            reason,
          });

    if (context.rollback) {
      await markVersionRolledBack({
        orgId: gate.org_id,
        actorId: opts.userId,
        versionId: context.rollback.replacedVersionId,
        reason,
      });
      await writeAudit(db, {
        orgId: gate.org_id,
        table: "modules",
        rowId: moduleRow.id,
        action: "update",
        event: "module_rollback",
        actorId: opts.userId,
        reason,
        before: { active_version_id: context.rollback.replacedVersionId },
        after: {
          active_version_id: installed.versionId,
          restored_from_version_id: context.rollback.restoredFromVersionId,
        },
      });
    }
    const after = await db.transaction(async (tx) => {
      await writeAudit(tx, {
        orgId: gate.org_id,
        table: "modules",
        rowId: moduleRow.id,
        action: "update",
        event:
          context.op === "upgrade"
            ? "module_upgrade_approved"
            : "module_install_approved",
        reason,
        before: {
          key: moduleRow.key,
          status: moduleRow.status,
          active_version_id: moduleRow.active_version_id,
        },
        after: {
          key: moduleRow.key,
          active_version_id: installed.versionId,
          approved_gate_id: opts.gateId,
          approved_version: context.version,
        },
        actorId: opts.userId,
      });
      await tx.execute(sql`
      update flow_runs set status = 'completed', error = null, finished_at = now(), updated_at = now()
       where id = ${run.id} and org_id = ${gate.org_id}
         and subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}`);
      const status =
        (
          await tx.execute<{ status: string }>(sql`
        select status from module_versions
         where org_id = ${gate.org_id} and id = ${installed.versionId} limit 1`)
        ).rows[0]?.status ?? null;
      return status;
    });

    return {
      resumed: "approve",
      moduleId: installed.moduleId,
      versionId: installed.versionId,
      versionStatus: after,
      runStatus: "completed",
    };
  }).catch((error: unknown) => {
    if (error instanceof ModuleInstallError) throw new ModuleLifecycleError(error.message, error.status);
    throw error;
  });
}

/**
 * Withdraw a pending proposal before it is decided. Only the requester (or an
 * org admin) may cancel; decided gates are never rewritten. The staged
 * proposal stays for revision — cancellation removes the ask, not the draft.
 */
export async function cancelModuleApprovalRequest(opts: {
  orgId: string;
  actorId: string;
  moduleId: string;
  reason?: string;
}): Promise<{ moduleId: string; cancelled: number }> {
  if (typeof opts.moduleId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.moduleId)) {
    throw new ModuleLifecycleError("moduleId must be a UUID");
  }
  const reason =
    opts.reason && opts.reason.length > 0 ? opts.reason : "cancelled";
  return await withOrg(opts.orgId, async () => {
    const tx = db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + opts.orgId}, 0))`,
    );
    const moduleRow =
      (
        await tx.execute<ModuleRow>(sql`
        select id, kind, key, name, description, status, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and id = ${opts.moduleId}
          for update`)
      ).rows[0] ?? null;
    if (!moduleRow) throw new ModuleLifecycleError("module not found", 404);
    const pending = await pendingGates(tx, {
      orgId: opts.orgId,
      moduleId: moduleRow.id,
    });
    if (pending.length === 0) return { moduleId: moduleRow.id, cancelled: 0 };

    const runIds = [...new Set(pending.map((g) => g.runId))];
    const contexts = (
      await tx.execute<{ context: ApprovalRunContext }>(sql`
        select context from flow_runs
         where org_id = ${opts.orgId} and id in (${sql.join(
           runIds.map((id) => sql`${id}`),
           sql`, `,
         )})`)
    ).rows.map((r) => r.context);
    const requesterId =
      contexts.find((c) => typeof c?.requesterId === "string")?.requesterId ??
      null;
    const canManage = await actorHasPermission(tx, opts.orgId, opts.actorId, "admin.customization.manage");
    if (opts.actorId !== requesterId && !canManage) {
      throw new ModuleLifecycleError(
        "only the requester or an admin can cancel a module approval",
        403,
      );
    }

    const cancelled = (
      await tx.execute<{ id: string }>(sql`
        update flow_gates set status = 'cancelled', updated_at = now()
         where org_id = ${opts.orgId} and subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
           and subject_id = ${moduleRow.id} and status = 'pending'
        returning id`)
    ).rows;
    await tx.execute(sql`
      update flow_runs set status = 'cancelled', finished_at = now(), updated_at = now()
      where org_id = ${opts.orgId} and id in (${sql.join(
        runIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        and subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}`);
    await writeAudit(tx, {
      orgId: opts.orgId,
      table: "modules",
      rowId: moduleRow.id,
      action: "update",
      event: "module_approval_cancelled",
      reason,
      before: {
        key: moduleRow.key,
        pending_gate_ids: pending.map((g) => g.gateId),
      },
      after: {
        key: moduleRow.key,
        cancelled_gate_ids: cancelled.map((r) => r.id),
      },
      actorId: opts.actorId,
    });
    return { moduleId: moduleRow.id, cancelled: cancelled.length };
  });
}

async function refuseWhilePending(
  tx: SqlExecutor,
  opts: { orgId: string; moduleId: string; key: string },
): Promise<void> {
  const pending = await pendingGates(tx, {
    orgId: opts.orgId,
    moduleId: opts.moduleId,
  });
  if (pending.length > 0) {
    throw new ModuleLifecycleError(
      `module "${opts.key}" has a proposal awaiting approval; cancel it before changing lifecycle state`,
      409,
    );
  }
}

/**
 * Deactivate a module: withdraw its projections and flip it to disabled,
 * never deleting. Delegates to the installer's uninstall (the sole projection
 * writer); refused while a proposal awaits approval.
 */
export async function deactivateModule(opts: {
  orgId: string;
  actorId: string;
  key: string;
  reason?: string;
}): Promise<{ moduleId: string | null; deactivatedProjections: number }> {
  const reason =
    opts.reason && opts.reason.length > 0 ? opts.reason : "deactivate";
  return withOrg(opts.orgId, async () => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + opts.orgId}, 0))`,
    );
    const staged = await db.execute<{ id: string; kind: string }>(sql`
    select id, kind from modules where org_id = ${opts.orgId} and key = ${opts.key} for update`);
    if (staged.rows[0] && staged.rows[0].kind !== "module") throw new ModuleLifecycleError("app-backed modules use the Apps lifecycle", 409);
    const moduleId = staged.rows[0]?.id ?? null;
    if (moduleId) {
      await db.transaction(async (tx) => {
        await refuseWhilePending(tx, {
          orgId: opts.orgId,
          moduleId,
          key: opts.key,
        });
      });
    }
    return uninstallModule({
      orgId: opts.orgId,
      actorId: opts.actorId,
      key: opts.key,
      reason,
    });
  });
}

/**
 * Reactivate a disabled module: re-projects the live version's recorded
 * manifest and flips the module back to installed. Re-asserts the recorded
 * grant exactly (narrowing a grant is a new approval, not a reactivation).
 */
export async function reactivateModule(opts: {
  orgId: string;
  actorId: string;
  key: string;
  reason?: string;
}): Promise<{ moduleId: string; versionId: string }> {
  const reason =
    opts.reason && opts.reason.length > 0 ? opts.reason : "reactivate";
  return withOrg(opts.orgId, async () => {
    return await withOrg(opts.orgId, async () => {
      const tx = db;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + opts.orgId}, 0))`,
      );
      const moduleRow =
        (
          await tx.execute<ModuleRow>(sql`
        select id, kind, key, name, description, status, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and key = ${opts.key}
          for update`)
        ).rows[0] ?? null;
      if (!moduleRow)
        throw new ModuleLifecycleError(
          `module "${opts.key}" is not installed`,
          404,
        );
      if (moduleRow.kind !== "module") throw new ModuleLifecycleError("app-backed modules use the Apps lifecycle", 409);
      if (moduleRow.status !== "disabled") {
        throw new ModuleLifecycleError(
          `module "${opts.key}" is ${moduleRow.status}, not disabled`,
          409,
        );
      }
      if (!moduleRow.active_version_id) {
        throw new ModuleLifecycleError(
          `module "${opts.key}" has no version to reactivate`,
          409,
        );
      }
      await refuseWhilePending(tx, {
        orgId: opts.orgId,
        moduleId: moduleRow.id,
        key: opts.key,
      });
      const active = (
        await tx.execute<{ manifest: unknown; version: string }>(sql`
        select manifest, version from module_versions
         where org_id = ${opts.orgId} and id = ${moduleRow.active_version_id} limit 1`)
      ).rows[0];
      if (!active)
        throw new ModuleLifecycleError("module active version not found", 500);
      const before = {
        key: moduleRow.key,
        status: moduleRow.status,
        active_version_id: moduleRow.active_version_id,
      };
      await writeAudit(tx, {
        orgId: opts.orgId,
        table: "modules",
        rowId: moduleRow.id,
        action: "update",
        event: "module_reactivation_requested",
        reason,
        before,
        after: {
          ...before,
          reactivating_version: active.version,
          granted_permissions: moduleRow.granted_permissions,
        },
        actorId: opts.actorId,
      });
      // The outer tenant transaction also includes installer projection and completion audit.
      const stored = {
        moduleId: moduleRow.id,
        manifest: active.manifest,
        granted: moduleRow.granted_permissions,
        version: active.version,
      };
      return stored;
    }).then(async (stored) => {
      const installed = await installModule({
        orgId: opts.orgId,
        actorId: opts.actorId,
        manifest: stored.manifest,
        grantedPermissions: stored.granted,
        installerEffectivePermissions: stored.granted,
        reason,
      });
      await db.transaction(async (tx) => {
        await writeAudit(tx, {
          orgId: opts.orgId,
          table: "modules",
          rowId: stored.moduleId,
          action: "update",
          event: "module_reactivated",
          reason,
          before: { key: opts.key, status: "disabled" },
          after: {
            key: opts.key,
            status: "installed",
            active_version_id: installed.versionId,
          },
          actorId: opts.actorId,
        });
      });
      return { moduleId: installed.moduleId, versionId: installed.versionId };
    });
  });
}

/**
 * Record that a non-live version was withdrawn by a rollback. The restoring
 * version (3c's append) must already be active: this flips a status, never
 * projections, so marking the live version is refused — supersede it first.
 */
export async function markVersionRolledBack(opts: {
  orgId: string;
  actorId: string;
  versionId: string;
  reason?: string;
}): Promise<{ versionId: string; status: string; replayed: boolean }> {
  const reason =
    opts.reason && opts.reason.length > 0 ? opts.reason : "rollback";
  return await withOrg(opts.orgId, async () => {
    const tx = db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + opts.orgId}, 0))`,
    );
    if (!(await actorHasPermission(tx, opts.orgId, opts.actorId, "admin.customization.manage"))) {
      throw new ModuleLifecycleError("admin.customization.manage is required to roll back a module version", 403);
    }
    const version =
      (
        await tx.execute<{
          id: string;
          module_id: string;
          version: string;
          status: string;
        }>(sql`
        select id, module_id, version, status from module_versions
         where org_id = ${opts.orgId} and id = ${opts.versionId}
         for update`)
      ).rows[0] ?? null;
    if (!version)
      throw new ModuleLifecycleError("module version not found", 404);
    if (version.status === "rolled_back") {
      return { versionId: version.id, status: version.status, replayed: true };
    }
    if (version.status !== "active" && version.status !== "superseded") {
      throw new ModuleLifecycleError(
        `version ${version.version} is ${version.status}; only a live or superseded version can be marked rolled back`,
        409,
      );
    }
    const moduleRow = (
      await tx.execute<{ active_version_id: string | null; key: string; kind: string }>(sql`
        select active_version_id, key, kind from modules
         where org_id = ${opts.orgId} and id = ${version.module_id} limit 1`)
    ).rows[0];
    if (moduleRow?.kind !== "module") throw new ModuleLifecycleError("app-backed modules use the Apps lifecycle", 409);
    if (moduleRow?.active_version_id === version.id) {
      throw new ModuleLifecycleError(
        `version ${version.version} is the active version; activate the restoring version before marking it rolled back`,
        409,
      );
    }
    await tx.execute(sql`
      update module_versions set status = 'rolled_back', updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${opts.orgId} and id = ${version.id}`);
    await writeAudit(tx, {
      orgId: opts.orgId,
      table: "module_versions",
      rowId: version.id,
      action: "update",
      event: "module_version_rolled_back",
      reason,
      before: { version: version.version, status: version.status },
      after: { version: version.version, status: "rolled_back" },
      actorId: opts.actorId,
    });
    return { versionId: version.id, status: "rolled_back", replayed: false };
  });
}
