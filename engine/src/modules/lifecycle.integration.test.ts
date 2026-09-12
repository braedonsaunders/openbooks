import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypass, withOrgContext } from "../db.ts";
import { worklistGates, decideGate } from "../flows/gates.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";
import {
  ModuleLifecycleError,
  decideModuleApproval,
  requestModuleInstallApproval,
  requestModuleUpgradeApproval,
  cancelModuleApprovalRequest,
  deactivateModule,
  reactivateModule,
  markVersionRolledBack,
} from "./lifecycle.ts";

const DB = !!env.OPENBOOKS_DB_URL;

/**
 * Live-PG proofs for the module lifecycle (engine/src/modules/lifecycle.ts).
 *
 * The lifecycle rides the existing Flows approval machinery — real flow_gates
 * rows decided by the real decideGate, visible in the real approval worklist —
 * and calls the installer only at the moment an approval resolves, so a
 * version is never projected before a human approves it. Every transition is
 * verified against committed Postgres state on a scratch org.
 */

type Fixture = {
  orgId: string;
  requesterId: string;
  approverId: string;
  outsiderId: string;
};

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg();
    const requesterId = await createScratchUser(
      org.orgId,
      "Module Requester",
      "admin",
    );
    const approverId = await createScratchUser(
      org.orgId,
      "Module Approver",
      "admin",
    );
    const outsiderId = await createScratchUser(
      org.orgId,
      "Module Outsider",
      "viewer",
    );
    await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb
      where org_id = ${org.orgId} and key = 'admin'`);
    return { orgId: org.orgId, requesterId, approverId, outsiderId };
  });
}

async function dropFixture(f: Fixture): Promise<void> {
  await withBypass(() => dropScratchOrg(f.orgId));
}

/** A realistic PageSpec document; the installer stores it opaquely as jsonb. */
function specFor(route: string, extra: Record<string, unknown> = {}) {
  return {
    specVersion: 1,
    route,
    layout: "list",
    header: [],
    body: [],
    ...extra,
  };
}

/** A minimal valid module manifest in the shape the installer accepts. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    key: "lifecycle-widget",
    name: "Lifecycle Widget",
    version: "1.0.0",
    description: "A module exercising the approval lifecycle",
    permissions: [],
    contributions: [
      {
        kind: "page",
        route: "/lifecycle/widget",
        spec: specFor("/lifecycle/widget"),
      },
    ],
    ...overrides,
  };
}

type ApprovalOpts = {
  assignees?:
    { type: "user"; userId: string }[] | { type: "role"; role: string }[];
  reason?: string;
  grantedPermissions?: string[];
  installerEffectivePermissions?: readonly string[];
  signatureRequired?: boolean;
  quorum?: "any" | "all";
};

function installRequest(
  f: Fixture,
  m: Record<string, unknown>,
  opts: ApprovalOpts = {},
) {
  return requestModuleInstallApproval({
    orgId: f.orgId,
    requesterId: f.requesterId,
    manifest: m,
    installerEffectivePermissions: opts.installerEffectivePermissions ?? [
      "records.read",
      "records.write",
    ],
    ...(opts.grantedPermissions !== undefined
      ? { grantedPermissions: opts.grantedPermissions }
      : {}),
    assignees: (opts.assignees ?? [
      { type: "user" as const, userId: f.approverId },
    ]) as {
      type: "user";
      userId: string;
    }[],
    ...(opts.quorum !== undefined ? { quorum: opts.quorum } : {}),
    ...(opts.signatureRequired !== undefined
      ? { signatureRequired: opts.signatureRequired }
      : {}),
    reason: opts.reason ?? "lifecycle test",
  });
}

async function moduleRow(orgId: string, key: string) {
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<{
        id: string;
        status: string;
        active_version_id: string | null;
        granted_permissions: string[];
      }>(sql`
        select id, status, active_version_id, granted_permissions
          from modules where org_id = ${orgId} and key = ${key}`),
    )
  ).rows;
  return rows[0] ?? null;
}

async function versionRows(orgId: string, moduleId: string) {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{ id: string; version: string; status: string }>(sql`
        select id, version, status from module_versions
         where org_id = ${orgId} and module_id = ${moduleId} order by version`),
    )
  ).rows;
}

async function liveProjections(orgId: string, moduleId: string) {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{ id: string; route: string }>(sql`
        select s.id, s.route from page_specs s
         join module_versions v on v.org_id = s.org_id and v.id = s.module_version_id
         where s.org_id = ${orgId} and v.module_id = ${moduleId} and s.is_active`),
    )
  ).rows;
}

async function gateRowsForModule(orgId: string, moduleId: string) {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{
        id: string;
        status: string;
        subject_kind: string;
        decided_by: string | null;
      }>(sql`
        select id, status, subject_kind, decided_by from flow_gates
         where org_id = ${orgId} and subject_kind = 'module_version' and subject_id = ${moduleId}
         order by created_at`),
    )
  ).rows;
}

type AuditRow = {
  table_name: string;
  row_id: string;
  action: string;
  changes: {
    reason?: unknown;
    before?: unknown;
    after?: unknown;
    event?: unknown;
  };
  actor_id: string | null;
};

async function auditFor(
  orgId: string,
  table: string,
  rowId: string,
): Promise<AuditRow[]> {
  return (
    await withOrgContext(orgId, () =>
      db.execute<AuditRow>(sql`
        select table_name, row_id, action, changes, actor_id
          from audit_log
         where org_id = ${orgId} and table_name = ${table} and row_id = ${rowId}
         order by at, id`),
    )
  ).rows;
}

/** Every audit row names its actor and carries before/after/reason. */
function assertAudited(rows: AuditRow[], actorId: string) {
  assert.ok(rows.length > 0, "expected at least one audit row");
  for (const row of rows) {
    assert.equal(
      row.actor_id,
      actorId,
      `audit row for ${row.table_name} names its actor`,
    );
    assert.equal(
      typeof row.changes.reason,
      "string",
      `audit row for ${row.table_name} carries a reason`,
    );
    assert.ok(
      "before" in row.changes,
      `audit row for ${row.table_name} carries before`,
    );
    assert.ok(
      "after" in row.changes,
      `audit row for ${row.table_name} carries after`,
    );
  }
}

test(
  "install proposal creates a gate, approval activates the version",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const req = await withBypass(() => installRequest(f, manifest()));
      assert.equal(req.replayed, false);
      assert.equal(req.gateIds.length, 1);

      // The gate is a real flow_gates row on the module, still pending: the
      // proposal projected nothing.
      const gates = await withBypass(() =>
        gateRowsForModule(f.orgId, req.moduleId),
      );
      assert.equal(gates.length, 1);
      assert.equal(gates[0]!.status, "pending");
      assert.equal(gates[0]!.subject_kind, "module_version");
      assert.equal(
        await liveProjections(f.orgId, req.moduleId).then((r) => r.length),
        0,
      );

      // The approver sees it in the EXISTING approval worklist.
      const worklist = await withBypass(() =>
        worklistGates(f.orgId, f.approverId),
      );
      assert.ok(
        worklist.some((g) => g.id === req.gateIds[0]),
        "module gate is visible in the existing approval worklist",
      );

      const decision = await withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
          comment: "looks good",
        }),
      );
      assert.equal(decision.resumed, "approve");
      assert.ok(decision.versionId, "approval produced an active version");

      const mod = await withBypass(() =>
        moduleRow(f.orgId, "lifecycle-widget"),
      );
      assert.equal(mod!.active_version_id, decision.versionId);
      const versions = await withBypass(() =>
        versionRows(f.orgId, req.moduleId),
      );
      assert.deepEqual(
        versions.map((v) => [v.version, v.status]),
        [["1.0.0", "active"]],
      );
      const live = await withBypass(() =>
        liveProjections(f.orgId, req.moduleId),
      );
      assert.equal(live.length, 1);
      assert.equal(live[0]!.route, "/lifecycle/widget");

      // Full audit: staging (requester) + approval linkage (approver) + activation (approver).
      const moduleAudit = await withBypass(() =>
        auditFor(f.orgId, "modules", req.moduleId),
      );
      const byEvent = new Map(
        moduleAudit.map((r) => [r.changes.event as string, r]),
      );
      assertAudited(
        moduleAudit.filter((r) =>
          [
            "module_install_staged",
            "module_install_approval_requested",
          ].includes(r.changes.event as string),
        ),
        f.requesterId,
      );
      assertAudited(
        moduleAudit.filter(
          (r) =>
            ![
              "module_install_staged",
              "module_install_approval_requested",
            ].includes(r.changes.event as string),
        ),
        f.approverId,
      );
      assert.ok(byEvent.has("module_install_staged"), "staging is audited");
      assert.ok(
        byEvent.has("module_install_approval_requested"),
        "the approval request is audited",
      );
      const versionAudit = await withBypass(() =>
        auditFor(f.orgId, "module_versions", decision.versionId!),
      );
      assertAudited(versionAudit, f.approverId);
      assert.ok(
        versionAudit.some((r) => r.changes.reason === "looks good"),
        "activation audit carries the approver's reason",
      );
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "denial leaves the proposal pending and projects nothing",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const req = await withBypass(() => installRequest(f, manifest()));
      const decision = await withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "rejected",
          userId: f.approverId,
          comment: "not yet",
        }),
      );
      assert.equal(decision.resumed, "reject");
      assert.equal(decision.versionId, null);

      const mod = await withBypass(() =>
        moduleRow(f.orgId, "lifecycle-widget"),
      );
      assert.equal(mod!.active_version_id, null, "denial activates no version");
      assert.deepEqual(
        await withBypass(() => versionRows(f.orgId, req.moduleId)),
        [],
      );
      assert.deepEqual(
        await withBypass(() => liveProjections(f.orgId, req.moduleId)),
        [],
      );

      const gates = await withBypass(() =>
        gateRowsForModule(f.orgId, req.moduleId),
      );
      assert.equal(gates[0]!.status, "rejected");

      const moduleAudit = await withBypass(() =>
        auditFor(f.orgId, "modules", req.moduleId),
      );
      const denial = moduleAudit.find(
        (r) => (r.changes.event as string) === "module_approval_denied",
      );
      assert.ok(denial, "denial is audited on the module row");
      assert.equal(denial!.actor_id, f.approverId);
      assert.equal(denial!.changes.reason, "not yet");
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "the requester cannot approve their own proposal",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const req = await withBypass(() => installRequest(f, manifest()));
      await assert.rejects(
        withBypass(() =>
          decideModuleApproval({
            gateId: req.gateIds[0]!,
            decision: "approved",
            userId: f.requesterId,
          }),
        ),
        (error: unknown) =>
          error instanceof ModuleLifecycleError &&
          /own module/.test(error.message),
        "self-approval is refused before the gate is touched",
      );
      const gates = await withBypass(() =>
        gateRowsForModule(f.orgId, req.moduleId),
      );
      assert.equal(
        gates[0]!.status,
        "pending",
        "refused decision leaves the gate pending",
      );
      assert.equal(gates[0]!.decided_by, null);
    } finally {
      await dropFixture(f);
    }
  },
);

test("a non-approver cannot decide a module gate", { skip: !DB }, async () => {
  const f = await makeFixture();
  try {
    const req = await withBypass(() => installRequest(f, manifest()));
    await assert.rejects(
      withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.outsiderId,
        }),
      ),
      "outsider decision is refused by the engine gate",
    );
    const gates = await withBypass(() =>
      gateRowsForModule(f.orgId, req.moduleId),
    );
    assert.equal(gates[0]!.status, "pending");
  } finally {
    await dropFixture(f);
  }
});

test("a decided gate cannot be decided twice", { skip: !DB }, async () => {
  const f = await makeFixture();
  try {
    const req = await withBypass(() => installRequest(f, manifest()));
    await withBypass(() =>
      decideModuleApproval({
        gateId: req.gateIds[0]!,
        decision: "approved",
        userId: f.approverId,
      }),
    );
    await assert.rejects(
      withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
        }),
      ),
      "second decision on a resolved gate is refused",
    );
    const live = await withBypass(() => liveProjections(f.orgId, req.moduleId));
    assert.equal(
      live.length,
      1,
      "no duplicate projection from the refused replay",
    );
  } finally {
    await dropFixture(f);
  }
});

test(
  "requesting the same proposal twice replays the pending gate",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const first = await withBypass(() => installRequest(f, manifest()));
      const second = await withBypass(() => installRequest(f, manifest()));
      assert.equal(second.replayed, true);
      assert.deepEqual(second.gateIds, first.gateIds);
      const gates = await withBypass(() =>
        gateRowsForModule(f.orgId, first.moduleId),
      );
      assert.equal(gates.length, 1, "no duplicate gate rows");
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "upgrade with an added capability requires a gate; approval supersedes",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const first = await withBypass(() => installRequest(f, manifest()));
      const v1 = await withBypass(() =>
        decideModuleApproval({
          gateId: first.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
        }),
      );

      const v2manifest = manifest({
        version: "2.0.0",
        permissions: ["records.read", "records.create"],
        contributions: [
          {
            kind: "page",
            route: "/lifecycle/widget",
            spec: specFor("/lifecycle/widget"),
          },
          {
            kind: "page",
            route: "/lifecycle/extra",
            spec: specFor("/lifecycle/extra"),
          },
        ],
      });
      const req = await withBypass(() =>
        requestModuleUpgradeApproval({
          orgId: f.orgId,
          requesterId: f.requesterId,
          key: "lifecycle-widget",
          manifest: v2manifest,
          installerEffectivePermissions: ["records.read", "records.create"],
          assignees: [{ type: "user", userId: f.approverId }],
          reason: "v2 adds create",
        }),
      );
      assert.deepEqual(
        req.addsCapabilities,
        ["records.create", "records.read"],
        "added capability is reported for the approver",
      );

      // The old version stays live until the approval lands.
      const before = await withBypass(() => versionRows(f.orgId, req.moduleId));
      assert.deepEqual(
        before.map((v) => [v.version, v.status]),
        [["1.0.0", "active"]],
      );

      const decision = await withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
          comment: "v2 approved",
          signature: "Module Approver",
        }),
      );
      assert.equal(decision.resumed, "approve");
      const after = await withBypass(() => versionRows(f.orgId, req.moduleId));
      assert.deepEqual(
        after.map((v) => [v.version, v.status]),
        [
          ["1.0.0", "superseded"],
          ["2.0.0", "active"],
        ],
      );
      assert.notEqual(v1.versionId, decision.versionId);
      const live = await withBypass(() =>
        liveProjections(f.orgId, req.moduleId),
      );
      assert.deepEqual(live.map((r) => r.route).sort(), [
        "/lifecycle/extra",
        "/lifecycle/widget",
      ]);
      const mod = await withBypass(() =>
        moduleRow(f.orgId, "lifecycle-widget"),
      );
      assert.deepEqual(mod!.granted_permissions, [
        "records.create",
        "records.read",
      ]);
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "install while a version is active is refused; upgrade of an unknown module is refused",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const req = await withBypass(() => installRequest(f, manifest()));
      await withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
        }),
      );
      await assert.rejects(
        withBypass(() => installRequest(f, manifest({ version: "1.0.1" }))),
        (error: unknown) =>
          error instanceof ModuleLifecycleError &&
          /upgrade/.test(error.message),
        "install on an active module directs to the upgrade path",
      );
      await assert.rejects(
        withBypass(() =>
          requestModuleUpgradeApproval({
            orgId: f.orgId,
            requesterId: f.requesterId,
            key: "no-such-module",
            manifest: manifest({ key: "no-such-module", version: "1.0.0" }),
            installerEffectivePermissions: ["records.read"],
            assignees: [{ type: "user", userId: f.approverId }],
          }),
        ),
        (error: unknown) =>
          error instanceof ModuleLifecycleError &&
          /not installed/.test(error.message),
        "upgrade of an unknown module is refused",
      );
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "deactivation withdraws projections; reactivation restores them",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const req = await withBypass(() => installRequest(f, manifest()));
      await withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
        }),
      );

      const deactivated = await withBypass(() =>
        deactivateModule({
          orgId: f.orgId,
          actorId: f.approverId,
          key: "lifecycle-widget",
          reason: "taking down",
        }),
      );
      assert.ok(deactivated.moduleId);
      const mod = await withBypass(() =>
        moduleRow(f.orgId, "lifecycle-widget"),
      );
      assert.equal(mod!.status, "disabled");
      assert.deepEqual(
        await withBypass(() => liveProjections(f.orgId, req.moduleId)),
        [],
      );
      const uninstallAudit = await withBypass(() =>
        auditFor(f.orgId, "modules", req.moduleId),
      );
      assert.ok(
        uninstallAudit.some((r) => r.changes.reason === "taking down"),
        "deactivation audit carries its reason",
      );

      await withBypass(() =>
        reactivateModule({
          orgId: f.orgId,
          actorId: f.approverId,
          key: "lifecycle-widget",
          reason: "back up",
        }),
      );
      const revived = await withBypass(() =>
        moduleRow(f.orgId, "lifecycle-widget"),
      );
      assert.equal(revived!.status, "installed");
      const live = await withBypass(() =>
        liveProjections(f.orgId, req.moduleId),
      );
      assert.equal(live.length, 1);
      assert.equal(live[0]!.route, "/lifecycle/widget");
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "a superseded version can be marked rolled back; the active one cannot",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const first = await withBypass(() => installRequest(f, manifest()));
      await withBypass(() =>
        decideModuleApproval({
          gateId: first.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
        }),
      );
      const req = await withBypass(() =>
        requestModuleUpgradeApproval({
          orgId: f.orgId,
          requesterId: f.requesterId,
          key: "lifecycle-widget",
          manifest: manifest({ version: "2.0.0" }),
          installerEffectivePermissions: ["records.read"],
          assignees: [{ type: "user", userId: f.approverId }],
          reason: "v2",
        }),
      );
      const v2 = await withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
        }),
      );
      const versions = await withBypass(() =>
        versionRows(f.orgId, req.moduleId),
      );
      const v1 = versions.find((v) => v.version === "1.0.0")!;

      await withBypass(() =>
        markVersionRolledBack({
          orgId: f.orgId,
          actorId: f.approverId,
          versionId: v1.id,
          reason: "v1 withdrawn after v2 proved stable",
        }),
      );
      const after = await withBypass(() => versionRows(f.orgId, req.moduleId));
      assert.deepEqual(
        after.map((v) => [v.version, v.status]),
        [
          ["1.0.0", "rolled_back"],
          ["2.0.0", "active"],
        ],
      );
      const rollbackAudit = await withBypass(() =>
        auditFor(f.orgId, "module_versions", v1.id),
      );
      assertAudited(rollbackAudit, f.approverId);

      await assert.rejects(
        withBypass(() =>
          markVersionRolledBack({
            orgId: f.orgId,
            actorId: f.approverId,
            versionId: v2.versionId!,
          }),
        ),
        (error: unknown) =>
          error instanceof ModuleLifecycleError && /active/.test(error.message),
        "the live version cannot be marked rolled back",
      );
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "a pending request can be cancelled; a signature gate needs its signature",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const req = await withBypass(() => installRequest(f, manifest()));
      const cancelled = await withBypass(() =>
        cancelModuleApprovalRequest({
          orgId: f.orgId,
          actorId: f.requesterId,
          moduleId: req.moduleId,
          reason: "withdrawing",
        }),
      );
      assert.equal(cancelled.cancelled, 1);
      const gates = await withBypass(() =>
        gateRowsForModule(f.orgId, req.moduleId),
      );
      assert.equal(gates[0]!.status, "cancelled");
      await assert.rejects(
        withBypass(() =>
          decideModuleApproval({
            gateId: req.gateIds[0]!,
            decision: "approved",
            userId: f.approverId,
          }),
        ),
        "a cancelled gate cannot be decided",
      );

      const signed = await withBypass(() =>
        installRequest(
          f,
          manifest({ key: "signed-widget", name: "Signed Widget" }),
          {
            signatureRequired: true,
          },
        ),
      );
      await assert.rejects(
        withBypass(() =>
          decideModuleApproval({
            gateId: signed.gateIds[0]!,
            decision: "approved",
            userId: f.approverId,
          }),
        ),
        "a signature-required approval refuses an unsigned approval",
      );
      const decision = await withBypass(() =>
        decideModuleApproval({
          gateId: signed.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
          signature: "Module Approver",
        }),
      );
      assert.equal(decision.resumed, "approve");
      assert.ok(decision.versionId);
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "common approval worklist activates signed modules and prevents requester bypass",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const request = await installRequest(
        f,
        manifest({ permissions: ["records.read"] }),
      );
      await assert.rejects(
        withOrgContext(f.orgId, () =>
          decideGate({
            gateId: request.gateIds[0]!,
            decision: "approved",
            userId: f.requesterId,
            signature: "Requester",
          }),
        ),
        /own module/,
      );
      await assert.rejects(
        withOrgContext(f.orgId, () =>
          decideGate({
            gateId: request.gateIds[0]!,
            decision: "approved",
            userId: f.approverId,
          }),
        ),
        /signature/,
      );
      const result = await withOrgContext(f.orgId, () =>
        decideGate({
          gateId: request.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
          signature: "Module Approver",
        }),
      );
      assert.equal(result.runStatus, "completed");
      assert.equal(
        (await moduleRow(f.orgId, "lifecycle-widget"))!.active_version_id,
        result.moduleApproval!.versionId,
      );
      assert.equal(
        (await liveProjections(f.orgId, request.moduleId)).length,
        1,
      );
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "concurrent identical requests converge and changed bytes cannot replay a pending label",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const results = await Promise.all([
        installRequest(f, manifest()),
        installRequest(f, manifest()),
      ]);
      assert.equal(results.filter((r) => r.replayed).length, 1);
      assert.deepEqual(results[0]!.gateIds, results[1]!.gateIds);
      await assert.rejects(
        installRequest(f, manifest({ name: "Different proposal" })),
        /different proposal/,
      );
      assert.equal(
        (await gateRowsForModule(f.orgId, results[0]!.moduleId)).length,
        1,
      );
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "activation conflict rolls back the decision and can be retried after resolution",
  { skip: !DB },
  async () => {
    const { installModule, uninstallModule } = await import("./installer.ts");
    const f = await makeFixture();
    try {
      await withOrgContext(f.orgId, () =>
        installModule({
          orgId: f.orgId,
          actorId: f.requesterId,
          manifest: manifest({ key: "existing-owner" }),
          installerEffectivePermissions: [],
        }),
      );
      const request = await installRequest(
        f,
        manifest({ permissions: ["records.read"] }),
      );
      const decide = () =>
        withOrgContext(f.orgId, () =>
          decideGate({
            gateId: request.gateIds[0]!,
            decision: "approved",
            userId: f.approverId,
            signature: "Module Approver",
          }),
        );
      await assert.rejects(decide);
      const gate = (await gateRowsForModule(f.orgId, request.moduleId))[0]!;
      assert.equal(gate.status, "pending");
      assert.equal(gate.decided_by, null);
      assert.equal((await versionRows(f.orgId, request.moduleId)).length, 0);
      await withOrgContext(f.orgId, () =>
        uninstallModule({
          orgId: f.orgId,
          actorId: f.approverId,
          key: "existing-owner",
        }),
      );
      assert.equal((await decide()).runStatus, "completed");
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "installer cannot activate capabilities without approval or bypass a pending gate with a page-only write",
  { skip: !DB },
  async () => {
    const { installModule } = await import("./installer.ts");
    const f = await makeFixture();
    try {
      await assert.rejects(
        withOrgContext(f.orgId, () =>
          installModule({
            orgId: f.orgId,
            actorId: f.requesterId,
            manifest: manifest({ permissions: ["records.read"] }),
            installerEffectivePermissions: ["records.read"],
          }),
        ),
        /signed approval/,
      );
      const request = await installRequest(
        f,
        manifest({ permissions: ["records.read"] }),
      );
      await assert.rejects(
        withOrgContext(f.orgId, () =>
          installModule({
            orgId: f.orgId,
            actorId: f.requesterId,
            manifest: manifest({ version: "2.0.0" }),
            installerEffectivePermissions: [],
          }),
        ),
        /awaiting approval/,
      );
      assert.equal(
        (await moduleRow(f.orgId, "lifecycle-widget"))!.active_version_id,
        null,
      );
      assert.equal(
        (await gateRowsForModule(f.orgId, request.moduleId))[0]!.status,
        "pending",
      );
    } finally {
      await dropFixture(f);
    }
  },
);

test("module apply refuses foreign subject gates before deciding them", { skip: !DB }, async () => {
  const f = await makeFixture();
  try {
    const request = await installRequest(f, manifest());
    await withOrgContext(f.orgId, () => db.execute(sql`
      update flow_gates set subject_kind = 'invoice' where org_id = ${f.orgId} and id = ${request.gateIds[0]!}`));
    await assert.rejects(withOrgContext(f.orgId, () => decideModuleApproval({
      gateId: request.gateIds[0]!, decision: "approved", userId: f.approverId,
    })), /not a module approval/);
    const gate = (await withOrgContext(f.orgId, () => db.execute<{ status: string }>(sql`
      select status from flow_gates where org_id = ${f.orgId} and id = ${request.gateIds[0]!}`))).rows[0]!;
    assert.equal(gate.status, "pending");
  } finally { await dropFixture(f); }
});

test("common approval rechecks current requester and approver capability grants", { skip: !DB }, async () => {
  for (const revokeRequester of [true, false]) {
    const f = await makeFixture();
    try {
      const request = await installRequest(f, manifest({ permissions: ["records.read"] }));
      const revokedUserId = revokeRequester ? f.requesterId : f.approverId;
      await withOrgContext(f.orgId, () => db.execute(sql`
        insert into user_permission_overrides (org_id, user_id, permission, effect)
        values (${f.orgId}, ${revokedUserId}, 'records.read', 'deny')`));
      await assert.rejects(withOrgContext(f.orgId, () => decideGate({
        gateId: request.gateIds[0]!, decision: "approved", userId: f.approverId, signature: "Reviewed",
      })), /authority no longer covers records.read/);
      assert.equal((await gateRowsForModule(f.orgId, request.moduleId))[0]!.status, "pending");
      assert.equal((await moduleRow(f.orgId, "lifecycle-widget"))!.active_version_id, null);
    } finally { await dropFixture(f); }
  }
});
