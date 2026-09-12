import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypass, withOrgContext } from "../db.ts";
import { isCataloguePermission } from "../permissions.ts";
import { isModulePermission } from "./module-catalogue.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";
import {
  ModuleInstallError,
  installModule,
  uninstallModule,
  upgradeModule,
} from "./installer.ts";

const DB = !!env.OPENBOOKS_DB_URL;

/**
 * Live-PG proofs for the module installer (engine/src/modules/installer.ts).
 * Every install, upgrade, and uninstall runs against a scratch org on a real
 * database: projection rows, lifecycle transitions, and audit evidence are
 * all verified against committed Postgres state.
 */

type Fixture = {
  orgId: string;
  actorId: string;
};

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Module Admin", "admin");
    return { orgId: org.orgId, actorId };
  });
}

/** A realistic PageSpec document; the installer stores it opaquely as jsonb. */
function specFor(route: string, extra: Record<string, unknown> = {}) {
  return { specVersion: 1, route, layout: "list", header: [], body: [], ...extra };
}

/** A minimal valid module manifest in the shape parseModuleManifest accepts. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    key: "qilish-report",
    name: "Qilish Report",
    version: "1.0.0",
    description: "A reporting module",
    permissions: ["records.read"],
    contributions: [{ kind: "page", route: "/reports/qilish", spec: specFor("/reports/qilish") }],
    ...overrides,
  };
}

type AuditRow = {
  table_name: string;
  row_id: string;
  action: string;
  changes: { reason?: unknown; before?: unknown; after?: unknown };
  actor_id: string | null;
};

async function auditFor(orgId: string, table: string, rowId: string): Promise<AuditRow[]> {
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

/** Every audit row the installer writes names its actor and carries before/after/reason. */
function assertAudited(rows: AuditRow[], actorId: string) {
  assert.ok(rows.length > 0, "expected at least one audit row");
  for (const row of rows) {
    assert.equal(row.actor_id, actorId, `audit row for ${row.table_name} names its actor`);
    assert.equal(typeof row.changes.reason, "string", `audit row for ${row.table_name} carries a reason`);
    assert.ok("before" in row.changes, `audit row for ${row.table_name} carries before`);
    assert.ok("after" in row.changes, `audit row for ${row.table_name} carries after`);
  }
}

const moduleCount = async (orgId: string): Promise<number> =>
  Number(
    (
      await withOrgContext(orgId, () =>
        db.execute<{ n: string }>(sql`select count(*) as n from modules where org_id = ${orgId}`),
      )
    ).rows[0]!.n,
  );

test(
  "install validates, writes module + version rows, projects the page, and audits every write",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const out = await withBypass(() =>
        installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] }),
      );
      assert.equal(out.outcome, "installed");

      const modules = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{
            id: string;
            key: string;
            status: string;
            active_version_id: string | null;
            granted_permissions: string[];
          }>(sql`select id, key, status, active_version_id, granted_permissions from modules where org_id = ${fx.orgId}`),
        )
      ).rows;
      assert.equal(modules.length, 1);
      assert.equal(modules[0]!.key, "qilish-report");
      assert.equal(modules[0]!.status, "installed");
      assert.deepEqual(modules[0]!.granted_permissions, ["records.read"]);

      const versions = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ id: string; version: string; status: string; manifest: unknown }>(
            sql`select id, version, status, manifest from module_versions where org_id = ${fx.orgId}`,
          ),
        )
      ).rows;
      assert.equal(versions.length, 1);
      assert.equal(versions[0]!.version, "1.0.0");
      assert.equal(versions[0]!.status, "active");
      assert.equal(modules[0]!.active_version_id, versions[0]!.id);
      assert.equal(out.versionId, versions[0]!.id);

      const specs = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ id: string; route: string; spec: unknown; module_version_id: string | null; is_active: boolean }>(
            sql`select id, route, spec, module_version_id, is_active from page_specs where org_id = ${fx.orgId}`,
          ),
        )
      ).rows;
      assert.equal(specs.length, 1);
      assert.equal(specs[0]!.route, "/reports/qilish");
      assert.equal(specs[0]!.module_version_id, versions[0]!.id);
      assert.equal(specs[0]!.is_active, true);
      assert.deepEqual(specs[0]!.spec, specFor("/reports/qilish"));

      assertAudited(await auditFor(fx.orgId, "modules", modules[0]!.id), fx.actorId);
      assertAudited(await auditFor(fx.orgId, "module_versions", versions[0]!.id), fx.actorId);
      const projectionAudit = await auditFor(fx.orgId, "page_specs", specs[0]!.id);
      assert.equal(projectionAudit[0]!.action, "insert");
      assertAudited(projectionAudit, fx.actorId);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "a one-character key installs: the canonical slug rule is 1..64",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const out = await withBypass(() =>
        installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest({ key: "q" }), installerEffectivePermissions: ["records.read"] }),
      );
      assert.equal(out.outcome, "installed");
      const modules = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ key: string }>(sql`select key from modules where org_id = ${fx.orgId}`),
        )
      ).rows;
      assert.deepEqual(modules.map((m) => m.key), ["q"]);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "reinstalling the identical manifest is a no-op: one module row, one version row, one active projection",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const first = await withBypass(() =>
        installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] }),
      );
      const second = await withBypass(() =>
        installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] }),
      );
      assert.equal(second.outcome, "already-installed");
      assert.equal(second.moduleId, first.moduleId);
      assert.equal(second.versionId, first.versionId);
      assert.equal(await moduleCount(fx.orgId), 1);
      const versions = Number(
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(sql`select count(*) as n from module_versions where org_id = ${fx.orgId}`),
          )
        ).rows[0]!.n,
      );
      assert.equal(versions, 1);
      const activeSpecs = Number(
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(
              sql`select count(*) as n from page_specs where org_id = ${fx.orgId} and route = '/reports/qilish' and is_active`,
            ),
          )
        ).rows[0]!.n,
      );
      assert.equal(activeSpecs, 1);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "two concurrent identical installs converge: one installed, one already-installed, zero errors",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const [a, b] = await Promise.all([
        withBypass(() => installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] })),
        withBypass(() => installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] })),
      ]);
      // The loser serializes on the unique keys and converges — raw PG
      // constraint codes never reach callers.
      assert.deepEqual([a.outcome, b.outcome].sort(), ["already-installed", "installed"]);
      assert.equal(a.moduleId, b.moduleId);
      assert.equal(a.versionId, b.versionId);
      assert.equal(await moduleCount(fx.orgId), 1);
      const versions = Number(
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(sql`select count(*) as n from module_versions where org_id = ${fx.orgId}`),
          )
        ).rows[0]!.n,
      );
      assert.equal(versions, 1);
      const activeSpecs = Number(
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(
              sql`select count(*) as n from page_specs where org_id = ${fx.orgId} and route = '/reports/qilish' and is_active`,
            ),
          )
        ).rows[0]!.n,
      );
      assert.equal(activeSpecs, 1);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "reactivating a superseded version audits the transition",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const v1 = manifest();
      await withBypass(() => installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: v1, installerEffectivePermissions: ["records.read"] }));
      await withBypass(() =>
        upgradeModule({
          orgId: fx.orgId,
          actorId: fx.actorId,
          key: "qilish-report",
          manifest: manifest({ version: "1.1.0" }),
          installerEffectivePermissions: ["records.read"],
        }),
      );
      const reactivated = await withBypass(() =>
        installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: v1, installerEffectivePermissions: ["records.read"] }),
      );
      assert.equal(reactivated.outcome, "reactivated");
      const versionAudits = await auditFor(fx.orgId, "module_versions", reactivated.versionId);
      const flips = versionAudits.filter(
        (a) => (a.changes as { event?: string }).event === "module_version_reactivated",
      );
      assert.equal(flips.length, 1);
      assertAudited(flips, fx.actorId);
      const changes = flips[0]!.changes as { before?: { status?: string }; after?: { status?: string } };
      assert.equal(changes.before?.status, "superseded");
      assert.equal(changes.after?.status, "active");
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "reinstalling the same version with a different manifest is refused; upgrade appends and re-projects",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      await withBypass(() => installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] }));
      await assert.rejects(
        withBypass(() =>
          installModule({
            orgId: fx.orgId,
            actorId: fx.actorId,
            manifest: manifest({ name: "Renamed Behind The Same Tag" }),
            installerEffectivePermissions: ["records.read"],
          }),
        ),
        ModuleInstallError,
      );

      const upgraded = await withBypass(() =>
        upgradeModule({
          orgId: fx.orgId,
          actorId: fx.actorId,
          key: "qilish-report",
          manifest: manifest({
            version: "1.1.0",
            contributions: [
              { kind: "page", route: "/reports/qilish", spec: { ...specFor("/reports/qilish"), layout: "detail" } },
              { kind: "page", route: "/reports/qilish-detail", spec: specFor("/reports/qilish-detail") },
            ],
          }),
          installerEffectivePermissions: ["records.read"],
        }),
      );

      const versions = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ id: string; version: string; status: string }>(
            sql`select id, version, status from module_versions where org_id = ${fx.orgId} order by version`,
          ),
        )
      ).rows;
      // Append-style: both version rows survive; the old one is superseded, never rewritten.
      assert.deepEqual(
        versions.map((v) => [v.version, v.status]),
        [
          ["1.0.0", "superseded"],
          ["1.1.0", "active"],
        ],
      );
      const active = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ active_version_id: string }>(
            sql`select active_version_id from modules where org_id = ${fx.orgId} and key = 'qilish-report'`,
          ),
        )
      ).rows[0]!;
      assert.equal(active.active_version_id, upgraded.versionId);

      // The old projection is deactivated but preserved; the route has exactly one live row on the new version.
      const recast = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ module_version_id: string; is_active: boolean }>(
            sql`select module_version_id, is_active from page_specs where org_id = ${fx.orgId} and route = '/reports/qilish' order by created_at`,
          ),
        )
      ).rows;
      assert.equal(recast.length, 2);
      assert.equal(recast.filter((r) => r.is_active).length, 1);
      assert.equal(recast.find((r) => r.is_active)!.module_version_id, upgraded.versionId);
      const detail = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ module_version_id: string; is_active: boolean }>(
            sql`select module_version_id, is_active from page_specs where org_id = ${fx.orgId} and route = '/reports/qilish-detail'`,
          ),
        )
      ).rows;
      assert.equal(detail.length, 1);
      assert.equal(detail[0]!.is_active, true);

      assertAudited(await auditFor(fx.orgId, "modules", upgraded.moduleId), fx.actorId);
      assertAudited(await auditFor(fx.orgId, "module_versions", upgraded.versionId), fx.actorId);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "upgrade withdraws routes the new manifest drops, with audit",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const v1 = manifest({
        key: "prune-report",
        contributions: [
          { kind: "page", route: "/reports/keep", spec: specFor("/reports/keep") },
          { kind: "page", route: "/reports/drop", spec: specFor("/reports/drop") },
        ],
      });
      const first = await withBypass(() =>
        installModule({
          orgId: fx.orgId,
          actorId: fx.actorId,
          manifest: v1,
          installerEffectivePermissions: ["records.read"],
        }),
      );
      const upgraded = await withBypass(() =>
        upgradeModule({
          orgId: fx.orgId,
          actorId: fx.actorId,
          key: "prune-report",
          manifest: manifest({
            key: "prune-report",
            version: "2.0.0",
            contributions: [{ kind: "page", route: "/reports/keep", spec: specFor("/reports/keep") }],
          }),
          installerEffectivePermissions: ["records.read"],
        }),
      );
      // The dropped route keeps its row (history preserved) but goes
      // inactive; the kept route has exactly one live row on the new version.
      const dropped = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ module_version_id: string; is_active: boolean }>(
            sql`select module_version_id, is_active from page_specs where org_id = ${fx.orgId} and route = '/reports/drop'`,
          ),
        )
      ).rows;
      assert.equal(dropped.length, 1);
      assert.equal(dropped[0]!.is_active, false);
      assert.equal(dropped[0]!.module_version_id, first.versionId);
      const kept = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ module_version_id: string; is_active: boolean }>(
            sql`select module_version_id, is_active from page_specs where org_id = ${fx.orgId} and route = '/reports/keep' order by created_at`,
          ),
        )
      ).rows;
      assert.equal(kept.filter((r) => r.is_active).length, 1);
      assert.equal(kept.find((r) => r.is_active)!.module_version_id, upgraded.versionId);
      // The withdrawal is audited with actor, before/after, and reason.
      const dropRowId = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ id: string }>(
            sql`select id from page_specs where org_id = ${fx.orgId} and route = '/reports/drop'`,
          ),
        )
      ).rows[0]!.id;
      const withdrawal = (await auditFor(fx.orgId, "page_specs", dropRowId)).filter(
        (a) => (a.changes as { event?: string }).event === "module_projection_withdrawn",
      );
      assert.equal(withdrawal.length, 1);
      assertAudited(withdrawal, fx.actorId);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "uninstall deactivates projections without deleting; reinstalling reactivates append-style",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      await withBypass(() => installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] }));
      const uninstalled = await withBypass(() =>
        uninstallModule({ orgId: fx.orgId, actorId: fx.actorId, key: "qilish-report" }),
      );
      assert.ok(uninstalled.moduleId);

      const mod = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ status: string }>(
            sql`select status from modules where org_id = ${fx.orgId} and key = 'qilish-report'`,
          ),
        )
      ).rows[0]!;
      assert.equal(mod.status, "disabled");
      // Nothing is deleted: the module, its version, and its projection rows all survive.
      assert.equal(await moduleCount(fx.orgId), 1);
      const liveSpecs = Number(
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(
              sql`select count(*) as n from page_specs where org_id = ${fx.orgId} and route = '/reports/qilish' and is_active`,
            ),
          )
        ).rows[0]!.n,
      );
      assert.equal(liveSpecs, 0);
      const keptSpecs = Number(
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(
              sql`select count(*) as n from page_specs where org_id = ${fx.orgId} and route = '/reports/qilish'`,
            ),
          )
        ).rows[0]!.n,
      );
      assert.equal(keptSpecs, 1);
      assertAudited(await auditFor(fx.orgId, "modules", uninstalled.moduleId!), fx.actorId);

      const reinstalled = await withBypass(() =>
        installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] }),
      );
      assert.equal(reinstalled.outcome, "reactivated");
      const liveAgain = Number(
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(
              sql`select count(*) as n from page_specs where org_id = ${fx.orgId} and route = '/reports/qilish' and is_active`,
            ),
          )
        ).rows[0]!.n,
      );
      assert.equal(liveAgain, 1);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "a module page installs alongside tenant customization: both rows stay active and the org row shadows the module row",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const before = await withBypass(async () => {
        const inserted = await db.execute<{ id: string; updated_at: string }>(sql`
          insert into page_specs (org_id, user_id, route, spec, note, module_version_id, created_by, updated_by)
          values (${fx.orgId}, null, '/reports/qilish', ${JSON.stringify(specFor("/reports/qilish"))}::jsonb,
                  'tenant layout', null, ${fx.actorId}, ${fx.actorId})
          returning id, updated_at`);
        return inserted.rows[0]!;
      });
      // Shadowing coexistence (0111): the tenant row stays exactly as it
      // was and the install succeeds beside it — never a 409, never a
      // deactivation of the other provenance's row.
      const out = await withBypass(() =>
        installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest(), installerEffectivePermissions: ["records.read"] }),
      );
      assert.equal(out.outcome, "installed");
      const orgRow = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ spec: unknown; is_active: boolean; updated_at: string; module_version_id: string | null }>(
            sql`select spec, is_active, updated_at, module_version_id from page_specs where id = ${before.id}`,
          ),
        )
      ).rows[0]!;
      assert.equal(orgRow.is_active, true);
      assert.equal(orgRow.module_version_id, null);
      assert.deepEqual(orgRow.spec, specFor("/reports/qilish"));
      assert.equal(String(orgRow.updated_at), String(before.updated_at));
      const moduleRow = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ id: string; is_active: boolean; module_version_id: string | null }>(
            sql`select id, is_active, module_version_id from page_specs
                 where org_id = ${fx.orgId} and route = '/reports/qilish' and module_version_id is not null`,
          ),
        )
      ).rows;
      assert.equal(moduleRow.length, 1);
      assert.equal(moduleRow[0]!.is_active, true);
      assert.equal(moduleRow[0]!.module_version_id, out.versionId);
      // Resolution shadows: the read-time order (user > org-native > module,
      // owned by pickPageSpecRow in web/lib/page-specs.ts) ranks the
      // org-native row first while both are active.
      const winner = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ id: string }>(sql`
            select id from page_specs
             where org_id = ${fx.orgId} and route = '/reports/qilish' and is_active and user_id is null
             order by module_version_id nulls first, updated_at desc, id
             limit 1`),
        )
      ).rows[0]!;
      assert.equal(winner.id, before.id);
      assertAudited(await auditFor(fx.orgId, "page_specs", moduleRow[0]!.id), fx.actorId);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "invalid manifests are refused before anything is written",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const cases: Array<[string, Record<string, unknown>]> = [
        ["bad slug", manifest({ key: "Bad Key!" })],
        ["bad version", manifest({ version: "v-one" })],
        ["unknown kind", manifest({ contributions: [{ kind: "warp-drive" }] })],
        [
          "structurally valid but not yet projectable",
          manifest({ contributions: [{ kind: "panel", route: "/x", slot: "aside", blocks: [] }] }),
        ],
        [
          "user scope",
          manifest({
            contributions: [{ kind: "page", route: "/x", spec: specFor("/x"), scope: "user" }],
          }),
        ],
        [
          "duplicate routes",
          manifest({
            contributions: [
              { kind: "page", route: "/x", spec: specFor("/x") },
              { kind: "page", route: "/x", spec: specFor("/x") },
            ],
          }),
        ],
        [
          "spec declares another route",
          manifest({ contributions: [{ kind: "page", route: "/x", spec: specFor("/elsewhere") }] }),
        ],
        ["relative route", manifest({ contributions: [{ kind: "page", route: "x", spec: specFor("x") }] })],
        ["non-object spec", manifest({ contributions: [{ kind: "page", route: "/x", spec: 42 }] })],
        ["empty spec object", manifest({ contributions: [{ kind: "page", route: "/x", spec: {} }] })],
        ["garbage manifest", { key: 5 } as unknown as Record<string, unknown>],
      ];
      for (const [label, bad] of cases) {
        await assert.rejects(
          withBypass(() => installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: bad, installerEffectivePermissions: ["records.read"] })),
          ModuleInstallError,
          label,
        );
      }
      // Granting what the manifest never requested is a caller bug, not a narrowing.
      await assert.rejects(
        withBypass(() =>
          installModule({
            orgId: fx.orgId,
            actorId: fx.actorId,
            manifest: manifest({ permissions: [] }),
            grantedPermissions: ["gl.post"],
            installerEffectivePermissions: ["records.read"],
          }),
        ),
        ModuleInstallError,
      );
      assert.equal(await moduleCount(fx.orgId), 0);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "grants resolve through the lattice: unknown names rejected, recorded grant is approved∩requested∩effective",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      // A name the platform never issued is a manifest error at the
      // engine-closed outer backstop — no catalogue passed, none needed.
      await assert.rejects(
        withBypass(() =>
          installModule({
            orgId: fx.orgId,
            actorId: fx.actorId,
            manifest: manifest({ permissions: ["bogus.write"] }),
            installerEffectivePermissions: ["records.read"],
          }),
        ),
        /unknown permission: bogus\.write/,
      );
      assert.equal(await moduleCount(fx.orgId), 0);

      // The installer holds only gl.read: gl.post is requested and approved
      // but withheld, and the audit trail says so.
      const out = await withBypass(() =>
        installModule({
          orgId: fx.orgId,
          actorId: fx.actorId,
          manifest: manifest({ permissions: ["gl.read", "gl.post"] }),
          installerEffectivePermissions: ["gl.read"],
        }),
      );
      assert.equal(out.outcome, "installed");
      const stored = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ granted_permissions: string[] }>(
            sql`select granted_permissions from modules where org_id = ${fx.orgId}`,
          ),
        )
      ).rows[0]!;
      assert.deepEqual(stored.granted_permissions, ["gl.read"]);
      const audits = await auditFor(fx.orgId, "modules", out.moduleId);
      const installAudit = audits.find(
        (a) => (a.changes as { event?: string }).event === "module_install",
      )!;
      assert.deepEqual((installAudit.changes as { after?: { withheld_permissions?: string[] } }).after?.withheld_permissions, [
        "gl.post",
      ]);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "permission boundary is self-sufficient: outer catalogue backstop plus inner vocabulary",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      // Verifier probe verbatim: a lying caller-supplied catalogue listing
      // bogus.write cannot smuggle it past the engine-closed outer layer.
      await assert.rejects(
        withBypass(() =>
          installModule({
            orgId: fx.orgId,
            actorId: fx.actorId,
            manifest: manifest({ permissions: ["bogus.write"] }),
            installerEffectivePermissions: ["bogus.write"],
          }),
        ),
        /unknown permission: bogus\.write/,
      );
      assert.equal(await moduleCount(fx.orgId), 0);

      // Off-vocabulary but real: close.run is a platform permission outside
      // the module vocabulary — outer passes, inner refuses. Both
      // memberships asserted here, never hardcoded.
      assert.equal(isCataloguePermission("close.run"), true);
      assert.equal(isModulePermission("close.run"), false);
      await assert.rejects(
        withBypass(() =>
          installModule({
            orgId: fx.orgId,
            actorId: fx.actorId,
            manifest: manifest({ permissions: ["close.run"] }),
            installerEffectivePermissions: ["close.run"],
          }),
        ),
        /outside the module vocabulary/,
      );
      assert.equal(await moduleCount(fx.orgId), 0);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "omitting the effective set is a compile error and a runtime refusal",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      await assert.rejects(
        // @ts-expect-error: the effective set is required — a caller that cannot state its authority must not install
        withBypass(() => installModule({ orgId: fx.orgId, actorId: fx.actorId, manifest: manifest() })),
        /installerEffectivePermissions.*required/,
      );
      assert.equal(await moduleCount(fx.orgId), 0);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "upgrade of a never-installed module is refused; uninstall of one is a no-op",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      await assert.rejects(
        withBypass(() =>
          upgradeModule({
          orgId: fx.orgId,
          actorId: fx.actorId,
          key: "qilish-report",
          manifest: manifest(),
          installerEffectivePermissions: ["records.read"],
        }),
        ),
        ModuleInstallError,
      );
      const out = await withBypass(() =>
        uninstallModule({ orgId: fx.orgId, actorId: fx.actorId, key: "qilish-report" }),
      );
      assert.equal(out.moduleId, null);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);
