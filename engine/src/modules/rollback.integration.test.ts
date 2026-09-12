import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypass, withOrgContext } from "../db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";
import { installModule, upgradeModule } from "./installer.ts";
import {
  decideModuleApproval,
  requestModuleInstallApproval,
  requestModuleUpgradeApproval,
} from "./lifecycle.ts";
import {
  ModuleRollbackError,
  moduleApplyRequiresSignature,
  requestRollbackApproval,
  rollbackModuleVersion,
} from "./rollback.ts";

const DB = !!env.OPENBOOKS_DB_URL;

/**
 * Live-PG proofs for signed apply + append-only rollback
 * (engine/src/modules/rollback.ts).
 *
 * Rollback mirrors page-layout restore (web/lib/page-specs.ts:
 * restorePageSpec): history is never rewritten — a NEW version row carries
 * the restored bytes, the replaced version is marked rolled back, and every
 * transition is audited with actor/before/after/reason. Signed apply reuses
 * the flows gates' signatureRequired seam end to end (request → gate row →
 * decideGate enforcement), never a local signature check.
 *
 * Checkout-faithful schema note: this suite runs against THIS tree's
 * schema (0104–0106: one single-occupant partial unique index per route
 * scope), e.g. liveProjectionSpec asserts exactly one live row per route.
 * Under stacked 0111 (provenance-aware page_specs coexistence, owned by
 * the 1d slice + the installer/0111 arbiter joint-fix item) rows coexist
 * and precedence resolves at read time — that coexistence proof belongs
 * to the joint-fix item and the sweep, not here. Rollback's contract is
 * index-shape independent: append a restoring version with the target's
 * bytes, mark the replaced version rolled back, re-project through the
 * installer, and audit every transition.
 */

type Fixture = {
  orgId: string;
  requesterId: string;
  approverId: string;
};

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg();
    const requesterId = await createScratchUser(
      org.orgId,
      "Rollback Requester",
      "admin",
    );
    const approverId = await createScratchUser(
      org.orgId,
      "Rollback Approver",
      "admin",
    );
    await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb
      where org_id = ${org.orgId} and key = 'admin'`);
    return { orgId: org.orgId, requesterId, approverId };
  });
}

async function dropFixture(f: Fixture): Promise<void> {
  await withBypass(() => dropScratchOrg(f.orgId));
}

/** A realistic PageSpec document; `layout` varies between versions (a real schema field). */
function specFor(route: string, layout = "list") {
  return { specVersion: 1, route, layout, header: [], body: [] };
}

/** A minimal valid module manifest in the shape the installer accepts. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    key: "rollback-widget",
    name: "Rollback Widget",
    version: "1.0.0",
    description: "A module exercising signed apply and rollback",
    permissions: [],
    contributions: [
      {
        kind: "page",
        route: "/rollback/widget",
        spec: specFor("/rollback/widget"),
      },
    ],
    ...overrides,
  };
}

const EFFECTIVE = ["records.read", "records.create"];

async function installV1(f: Fixture, signed = false) {
  if (!signed)
    return withBypass(() =>
      installModule({
        orgId: f.orgId,
        actorId: f.requesterId,
        manifest: manifest(),
        installerEffectivePermissions: EFFECTIVE,
      }),
    );
  const request = await requestModuleInstallApproval({
    orgId: f.orgId,
    requesterId: f.requesterId,
    manifest: manifest({ permissions: ["records.read"] }),
    installerEffectivePermissions: EFFECTIVE,
    assignees: [{ type: "user", userId: f.approverId }],
  });
  const decision = await withOrgContext(f.orgId, () =>
    decideModuleApproval({
      gateId: request.gateIds[0]!,
      decision: "approved",
      userId: f.approverId,
      signature: "Rollback Approver",
    }),
  );
  return { versionId: decision.versionId!, moduleId: decision.moduleId };
}

async function upgradeToV2(f: Fixture, signed = false) {
  const proposal = manifest({
    version: "2.0.0",
    permissions: signed ? ["records.read"] : [],
    contributions: [
      {
        kind: "page",
        route: "/rollback/widget",
        spec: specFor("/rollback/widget", "detail"),
      },
    ],
  });
  if (!signed)
    return withBypass(() =>
      upgradeModule({
        orgId: f.orgId,
        actorId: f.requesterId,
        key: "rollback-widget",
        manifest: proposal,
        installerEffectivePermissions: EFFECTIVE,
      }),
    );
  const request = await requestModuleUpgradeApproval({
    orgId: f.orgId,
    requesterId: f.requesterId,
    key: "rollback-widget",
    manifest: proposal,
    installerEffectivePermissions: EFFECTIVE,
    assignees: [{ type: "user", userId: f.approverId }],
  });
  const decision = await withOrgContext(f.orgId, () =>
    decideModuleApproval({
      gateId: request.gateIds[0]!,
      decision: "approved",
      userId: f.approverId,
      signature: "Rollback Approver",
    }),
  );
  return { versionId: decision.versionId!, moduleId: decision.moduleId };
}

async function versionRows(orgId: string, moduleId: string) {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{
        id: string;
        version: string;
        status: string;
        manifest: unknown;
      }>(sql`
        select id, version, status, manifest from module_versions
         where org_id = ${orgId} and module_id = ${moduleId} order by version`),
    )
  ).rows;
}

async function liveProjectionSpec(
  orgId: string,
  route: string,
): Promise<unknown> {
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<{ spec: unknown }>(sql`
        select spec from page_specs
         where org_id = ${orgId} and route = ${route} and is_active and user_id is null`),
    )
  ).rows;
  assert.equal(
    rows.length,
    1,
    `expected exactly one live projection for ${route}`,
  );
  return rows[0]!.spec;
}

type AuditRow = {
  table_name: string;
  row_id: string;
  action: string;
  changes: {
    event?: unknown;
    reason?: unknown;
    before?: unknown;
    after?: unknown;
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

test("capability-bearing versions require a signature; page-only versions do not", () => {
  assert.equal(
    moduleApplyRequiresSignature({ permissions: ["records.read"] }),
    true,
  );
  assert.equal(moduleApplyRequiresSignature({ permissions: [] }), false);
});

test(
  "signed apply works via the gate signature: unsigned refused, signed activates",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const v1 = await installV1(f, true);
      const v2 = await upgradeToV2(f, true);
      assert.ok(v1.versionId !== v2.versionId);

      // The restoring version carries the same capability request, so the
      // rollback approval defaults to signature-required — no caller flag.
      const req = await withBypass(() =>
        requestRollbackApproval({
          orgId: f.orgId,
          requesterId: f.requesterId,
          key: "rollback-widget",
          restoringVersion: "2.0.1",
          installerEffectivePermissions: EFFECTIVE,
          assignees: [{ type: "user", userId: f.approverId }],
          reason: "v2 broke the widget",
        }),
      );
      assert.equal(req.replayed, false);
      assert.equal(req.restoredFrom.version, "1.0.0");
      assert.equal(req.signatureRequired, true);

      await assert.rejects(
        withBypass(() =>
          decideModuleApproval({
            gateId: req.gateIds[0]!,
            decision: "approved",
            userId: f.approverId,
          }),
        ),
        "a capability-bearing apply refuses an unsigned approval",
      );
      const decision = await withBypass(() =>
        decideModuleApproval({
          gateId: req.gateIds[0]!,
          decision: "approved",
          userId: f.approverId,
          comment: "verified in staging",
          signature: "Rollback Approver",
        }),
      );
      assert.equal(decision.resumed, "approve");
      assert.ok(decision.versionId);
      const history = await versionRows(f.orgId, decision.moduleId);
      assert.equal(history.length, 3);
      assert.equal(
        history.find((row) => row.id === v1.versionId)?.status,
        "superseded",
      );
      assert.equal(
        history.find((row) => row.id === v2.versionId)?.status,
        "rolled_back",
      );

      const spec = (await liveProjectionSpec(f.orgId, "/rollback/widget")) as {
        layout?: string;
      };
      assert.equal(spec.layout, "list");
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "rollback appends a restoring version and projections return; history is never rewritten",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const v1 = await installV1(f);
      const v2 = await upgradeToV2(f);
      assert.equal(
        (
          (await liveProjectionSpec(f.orgId, "/rollback/widget")) as {
            layout?: string;
          }
        ).layout,
        "detail",
      );

      const out = await withBypass(() =>
        rollbackModuleVersion({
          orgId: f.orgId,
          actorId: f.approverId,
          key: "rollback-widget",
          restoringVersion: "1.0.1",
          reason: "v2 regressed the widget",
        }),
      );
      assert.equal(out.restoredFromVersionId, v1.versionId);
      assert.equal(out.replacedVersionId, v2.versionId);

      const versions = await versionRows(f.orgId, out.moduleId);
      assert.deepEqual(
        versions.map((v) => [v.version, v.status]),
        [
          ["1.0.0", "superseded"],
          ["1.0.1", "active"],
          ["2.0.0", "rolled_back"],
        ],
      );
      // The restoring version carries the exact bytes v1 ran — pointed at,
      // never edited in place (v1's own row is untouched).
      const v1Row = versions.find((v) => v.version === "1.0.0")!;
      const restoringRow = versions.find((v) => v.version === "1.0.1")!;
      assert.equal(restoringRow.id, out.versionId);
      const v1Manifest = v1Row.manifest as { contributions: unknown };
      const restoringManifest = restoringRow.manifest as {
        contributions: unknown;
        version: string;
      };
      assert.deepEqual(
        restoringManifest.contributions,
        v1Manifest.contributions,
      );
      assert.equal(restoringManifest.version, "1.0.1");

      // Projections return: the live row renders v1 again, pointing at the restoring version.
      const spec = (await liveProjectionSpec(f.orgId, "/rollback/widget")) as {
        layout?: string;
      };
      assert.equal(spec.layout, "list");
      const liveVersion = (
        await withOrgContext(f.orgId, () =>
          db.execute<{ module_version_id: string }>(sql`
            select module_version_id from page_specs
             where org_id = ${f.orgId} and route = '/rollback/widget' and is_active and user_id is null`),
        )
      ).rows[0]!.module_version_id;
      assert.equal(liveVersion, out.versionId);

      // Every transition names its actor and carries before/after/reason.
      const rollbackAudits = (
        await auditFor(f.orgId, "modules", out.moduleId)
      ).filter((r) => r.changes.event === "module_rollback");
      assert.equal(rollbackAudits.length, 1);
      assert.equal(rollbackAudits[0]!.actor_id, f.approverId);
      assert.equal(
        rollbackAudits[0]!.changes.reason,
        "v2 regressed the widget",
      );
      assert.ok("before" in rollbackAudits[0]!.changes);
      assert.ok("after" in rollbackAudits[0]!.changes);
    } finally {
      await dropFixture(f);
    }
  },
);

test(
  "rollback of the active version is refused and changes nothing",
  { skip: !DB },
  async () => {
    const f = await makeFixture();
    try {
      const v1 = await installV1(f);
      const v2 = await upgradeToV2(f);

      await assert.rejects(
        withBypass(() =>
          rollbackModuleVersion({
            orgId: f.orgId,
            actorId: f.approverId,
            key: "rollback-widget",
            targetVersionId: v2.versionId,
            restoringVersion: "1.0.1",
            reason: "mistargeted rollback",
          }),
        ),
        (error: unknown) =>
          error instanceof ModuleRollbackError &&
          /already the live version/.test(error.message),
      );
      await assert.rejects(
        withBypass(() =>
          rollbackModuleVersion({
            orgId: f.orgId,
            actorId: f.approverId,
            key: "rollback-widget",
            targetVersionId: "00000000-0000-0000-0000-000000000000",
            restoringVersion: "1.0.1",
          }),
        ),
        (error: unknown) =>
          error instanceof ModuleRollbackError &&
          /not a version of module/.test(error.message),
      );

      // Refusals change nothing: v2 still live, no restoring version appended.
      const moduleId = (
        await withOrgContext(f.orgId, () =>
          db.execute<{ id: string }>(
            sql`select id from modules where org_id = ${f.orgId} and key = 'rollback-widget'`,
          ),
        )
      ).rows[0]!.id;
      const versions = await versionRows(f.orgId, moduleId);
      assert.deepEqual(
        versions.map((v) => [v.version, v.status]),
        [
          ["1.0.0", "superseded"],
          ["2.0.0", "active"],
        ],
      );
      assert.equal(v1.versionId !== v2.versionId, true);
      assert.equal(
        (
          (await liveProjectionSpec(f.orgId, "/rollback/widget")) as {
            layout?: string;
          }
        ).layout,
        "detail",
      );
    } finally {
      await dropFixture(f);
    }
  },
);

test("rollback with no earlier version is refused", { skip: !DB }, async () => {
  const f = await makeFixture();
  try {
    await installV1(f);
    await assert.rejects(
      withBypass(() =>
        rollbackModuleVersion({
          orgId: f.orgId,
          actorId: f.approverId,
          key: "rollback-widget",
          restoringVersion: "1.0.1",
        }),
      ),
      (error: unknown) =>
        error instanceof ModuleRollbackError &&
        /no earlier version/.test(error.message),
    );
  } finally {
    await dropFixture(f);
  }
});
