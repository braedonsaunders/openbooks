import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypass } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../test-fixtures.ts";
import {
  ABSORBED_APP_MAPPED_PERMISSIONS,
  ABSORBED_APP_MODULE_KIND,
  absorbAppsForOrg,
  projectAppManifestToModuleManifest,
} from "./absorb-apps.ts";
import {
  MODULE_PLATFORM_PERMISSIONS,
  parseModuleManifest,
} from "../../../web/lib/modules/manifest.ts";

const DB = !!env.OPENBOOKS_DB_URL;

/**
 * Live-PG proofs that absorbing an app registers it on the modules
 * lifecycle/audit surface without touching the apps runtime
 * (engine/src/modules/absorb-apps.ts + migration 0109).
 *
 * Scratch orgs are created AFTER all migrations ran, so the migration's own
 * backfill never sees these apps — each test absorbs through
 * absorbAppsForOrg, which repeats 0109 statement-for-statement for one org.
 * The migration SQL itself is proven by the isolated-template scratch-DB
 * gate (it builds the template these tests run against).
 */

type ModuleRow = {
  id: string;
  key: string;
  name: string;
  status: string;
  kind: string;
  appId: string | null;
  grantedPermissions: string[];
  activeVersionId: string | null;
  createdBy: string | null;
};

type VersionRow = {
  id: string;
  version: string;
  status: string;
  manifest: Record<string, unknown>;
};

async function readModule(orgId: string, appId: string): Promise<ModuleRow | undefined> {
  const r = await withBypass(() =>
    db.execute<ModuleRow>(sql`
      select id, key, name, status, kind,
             app_id as "appId",
             granted_permissions as "grantedPermissions",
             active_version_id as "activeVersionId",
             created_by as "createdBy"
        from modules where org_id = ${orgId} and app_id = ${appId}`),
  );
  return r.rows[0];
}

async function readVersions(orgId: string, moduleId: string): Promise<VersionRow[]> {
  const r = await withBypass(() =>
    db.execute<VersionRow>(sql`
      select id, version, status, manifest
        from module_versions where org_id = ${orgId} and module_id = ${moduleId} order by version`),
  );
  return r.rows;
}

type AppFixture = {
  orgId: string;
  actorId: string;
  appId: string;
  versionId: string | null;
};

async function makeApp(opts: {
  key: string;
  status?: "installed" | "disabled";
  withVersion?: boolean;
  granted?: string[];
  /** Bundle-manifest requested permissions; defaults to the granted set. */
  requested?: string[];
  /** undefined → a default description; null → no description. */
  description?: string | null;
}): Promise<AppFixture> {
  const description = opts.description === undefined ? "Desc " + opts.key : opts.description;
  const requested = opts.requested ?? opts.granted ?? ["records.read"];
  return await withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Absorb Caller", "admin");
    const appId = randomUUID();
    await db.execute(sql`
      insert into apps (id, org_id, key, name, description, icon_key, status, granted_permissions, created_by, updated_by)
      values (${appId}, ${org.orgId}, ${opts.key}, ${"App " + opts.key}, ${description},
              'chart', ${opts.status ?? "installed"}, ${(JSON.stringify(opts.granted ?? ["records.read"]))}::jsonb,
              ${actorId}, ${actorId})`);
    let versionId: string | null = null;
    if (opts.withVersion !== false) {
      versionId = randomUUID();
      const manifest = {
        key: opts.key,
        name: "App " + opts.key,
        version: "1.2.0",
        ...(description !== null ? { description } : {}),
        permissions: requested,
        frontend: { entry: "frontend/index.html" },
        endpoints: [],
      };
      await db.execute(sql`
        insert into app_versions (id, org_id, app_id, version, manifest, status, created_by, updated_by)
        values (${versionId}, ${org.orgId}, ${appId}, '1.2.0', ${JSON.stringify(manifest)}::jsonb,
                'active', ${actorId}, ${actorId})`);
      await db.execute(sql`update apps set active_version_id = ${versionId} where id = ${appId} and org_id = ${org.orgId}`);
      await db.execute(sql`
        insert into app_files (org_id, app_id, version_id, path, kind, content_type, content, is_binary, size, created_by, updated_by)
        values (${org.orgId}, ${appId}, ${versionId}, 'frontend/index.html', 'frontend',
                'text/html; charset=utf-8', '<h1>hi</h1>', false, 12, ${actorId}, ${actorId})`);
    }
    return { orgId: org.orgId, actorId, appId, versionId };
  });
}

/** The apps-runtime rows absorb must never touch. */
async function snapshotRuntime(fx: AppFixture) {
  return await withBypass(async () => {
    const app = (
      await db.execute<Record<string, unknown>>(sql`
        select key, name, status, granted_permissions, active_version_id, provisioned, sort_order
          from apps where id = ${fx.appId} and org_id = ${fx.orgId}`)
    ).rows[0];
    const versions = (
      await db.execute<{ n: string }>(sql`
        select count(*) as n from app_versions where app_id = ${fx.appId} and org_id = ${fx.orgId}`)
    ).rows[0]!.n;
    const files = await db.execute<{ path: string; content: string }>(sql`
      select path, content from app_files where app_id = ${fx.appId} and org_id = ${fx.orgId} order by path`);
    return { app, versions, files: files.rows };
  });
}

test("the projector mirrors identity and grants and marks provenance, and refuses bad shapes", () => {
  const appId = randomUUID();
  const versionId = randomUUID();
  const good = projectAppManifestToModuleManifest(
    { id: appId, key: "ledger-lens", name: "Ledger Lens", description: "Sees ledgers", grantedPermissions: ["records.read"] },
    { id: versionId, version: "1.2.0", permissions: ["records.read", "gl.post"] },
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.manifest, {
    key: "ledger-lens",
    name: "Ledger Lens",
    version: "1.2.0",
    description: "Sees ledgers",
    permissions: ["records.read", "gl.post"],
    contributions: [],
    provenance: {
      kind: ABSORBED_APP_MODULE_KIND,
      appId,
      appKey: "ledger-lens",
      appVersionId: versionId,
      unmappedPermissions: [],
    },
  });

  // Narrowing is recorded, never silent; a missing description stays missing.
  const narrowed = projectAppManifestToModuleManifest(
    { id: appId, key: "ledger-lens", name: "Ledger Lens", description: null, grantedPermissions: ["records.read"] },
    { id: versionId, version: "1.2.0", permissions: ["gl.read", "custom.widget.use"] },
  );
  assert.equal(narrowed.ok, true);
  assert.deepEqual(narrowed.manifest?.permissions, ["gl.read"]);
  assert.deepEqual(narrowed.manifest?.provenance.unmappedPermissions, ["custom.widget.use"]);
  assert.ok(narrowed.manifest && !("description" in narrowed.manifest));
  assert.ok(parseModuleManifest(narrowed.manifest).ok);

  const badKey = projectAppManifestToModuleManifest(
    { id: appId, key: "Bad Key!", name: "Bad", description: null, grantedPermissions: [] },
    { id: versionId, version: "1.0.0", permissions: [] },
  );
  assert.equal(badKey.ok, false);
  assert.match(badKey.errors.join("; "), /module key/);

  // The manifest SLUG owns the vocabulary: a 1-char key is valid (0110).
  const singleChar = projectAppManifestToModuleManifest(
    { id: appId, key: "x", name: "X", description: null, grantedPermissions: [] },
    { id: versionId, version: "1.0.0", permissions: [] },
  );
  assert.equal(singleChar.ok, true);
  assert.equal(singleChar.manifest?.key, "x");

  const badVersion = projectAppManifestToModuleManifest(
    { id: appId, key: "ledger-lens", name: "Lens", description: null, grantedPermissions: [] },
    { id: versionId, version: "tomorrow", permissions: [] },
  );
  assert.equal(badVersion.ok, false);
  assert.match(badVersion.errors.join("; "), /1\.0\.0/);
});

test(
  "absorb registers one row plus one active version per app and leaves the apps runtime untouched",
  { skip: !DB },
  async () => {
    const fx = await makeApp({ key: "ledger-lens" });
    try {
      const before = await snapshotRuntime(fx);

      const first = await withBypass(() => absorbAppsForOrg(fx.orgId));
      assert.deepEqual(first, { modulesInserted: 1, versionsInserted: 1, linked: 1 });

      const mod = await readModule(fx.orgId, fx.appId);
      assert.ok(mod);
      assert.equal(mod.key, "ledger-lens");
      assert.equal(mod.name, "App ledger-lens");
      assert.equal(mod.status, "installed");
      assert.equal(mod.kind, "app");
      assert.equal(mod.appId, fx.appId);
      assert.deepEqual(mod.grantedPermissions, ["records.read"]);
      assert.equal(mod.createdBy, fx.actorId);

      const versions = await readVersions(fx.orgId, mod.id);
      assert.equal(versions.length, 1);
      assert.equal(versions[0]!.version, "1.2.0");
      assert.equal(versions[0]!.status, "active");
      assert.equal(mod.activeVersionId, versions[0]!.id);
      const manifest = versions[0]!.manifest;
      assert.deepEqual(manifest["permissions"], ["records.read"]);
      assert.deepEqual(manifest["contributions"], []);
      assert.equal(manifest["description"], "Desc ledger-lens");
      assert.deepEqual(manifest["provenance"], {
        kind: "app",
        appId: fx.appId,
        appKey: "ledger-lens",
        appVersionId: fx.versionId,
        unmappedPermissions: [],
      });
      assert.ok(parseModuleManifest(manifest).ok);

      // The apps runtime is byte-identical: same row, same active bundle, same files.
      assert.deepEqual(await snapshotRuntime(fx), before);

      // A rerun converges: nothing new, nothing doubled.
      const second = await withBypass(() => absorbAppsForOrg(fx.orgId));
      assert.deepEqual(second, { modulesInserted: 0, versionsInserted: 0, linked: 0 });
      assert.equal((await readVersions(fx.orgId, mod.id)).length, 1);
      assert.deepEqual(await snapshotRuntime(fx), before);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "absorb takes a 1-char app key and skips a key outside the manifest SLUG",
  { skip: !DB },
  async () => {
    const tiny = await makeApp({ key: "x" });
    const wild = await makeApp({ key: "Bad Key!", withVersion: false });
    try {
      // 1-char keys are valid manifest SLUGs (0110): absorbed like any other.
      assert.deepEqual(await withBypass(() => absorbAppsForOrg(tiny.orgId)), {
        modulesInserted: 1,
        versionsInserted: 1,
        linked: 1,
      });
      const tinyMod = await readModule(tiny.orgId, tiny.appId);
      assert.ok(tinyMod);
      assert.equal(tinyMod.key, "x");
      assert.equal(tinyMod.kind, "app");
      assert.ok(tinyMod.activeVersionId);

      // Outside the SLUG the app manifest enforces: left for a rename,
      // loudly visible as an apps row with no absorbing module row.
      assert.deepEqual(await withBypass(() => absorbAppsForOrg(wild.orgId)), {
        modulesInserted: 0,
        versionsInserted: 0,
        linked: 0,
      });
      assert.equal(await readModule(wild.orgId, wild.appId), undefined);
    } finally {
      await dropScratchOrg(tiny.orgId);
      await dropScratchOrg(wild.orgId);
    }
  },
);
test("the absorbed permission mirror tracks the module contract catalogue", () => {
  assert.deepEqual([...ABSORBED_APP_MAPPED_PERMISSIONS].sort(), [...MODULE_PLATFORM_PERMISSIONS].sort());
});

test(
  "absorb narrows unmapped permissions into provenance and omits a missing description",
  { skip: !DB },
  async () => {
    const fx = await makeApp({
      key: "odd-perms",
      description: null,
      granted: ["gl.read", "custom.widget.use"],
      requested: ["gl.read", "custom.widget.use"],
    });
    try {
      assert.deepEqual(await withBypass(() => absorbAppsForOrg(fx.orgId)), {
        modulesInserted: 1,
        versionsInserted: 1,
        linked: 1,
      });
      const mod = await readModule(fx.orgId, fx.appId);
      assert.ok(mod);
      // The grant record keeps the admin's actual grants verbatim.
      assert.deepEqual(mod.grantedPermissions, ["gl.read", "custom.widget.use"]);
      const versions = await readVersions(fx.orgId, mod.id);
      assert.equal(versions.length, 1);
      const manifest = versions[0]!.manifest;
      assert.deepEqual(manifest["permissions"], ["gl.read"]);
      assert.deepEqual(manifest["provenance"], {
        kind: "app",
        appId: fx.appId,
        appKey: "odd-perms",
        appVersionId: fx.versionId,
        unmappedPermissions: ["custom.widget.use"],
      });
      assert.ok(!("description" in manifest));
      const parsed = parseModuleManifest(manifest);
      assert.deepEqual(parsed.errors, []);
      assert.ok(parsed.ok);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "absorb handles a versionless app and a disabled app without inventing versions",
  { skip: !DB },
  async () => {
    const bare = await makeApp({ key: "empty-shell", withVersion: false });
    const off = await makeApp({ key: "retired-widget", status: "disabled" });
    try {
      assert.deepEqual(await withBypass(() => absorbAppsForOrg(bare.orgId)), {
        modulesInserted: 1,
        versionsInserted: 0,
        linked: 0,
      });
      const bareMod = await readModule(bare.orgId, bare.appId);
      assert.ok(bareMod);
      assert.equal(bareMod.kind, "app");
      assert.equal(bareMod.activeVersionId, null);
      assert.deepEqual(await readVersions(bare.orgId, bareMod.id), []);

      assert.deepEqual(await withBypass(() => absorbAppsForOrg(off.orgId)), {
        modulesInserted: 1,
        versionsInserted: 1,
        linked: 1,
      });
      const offMod = await readModule(off.orgId, off.appId);
      assert.ok(offMod);
      assert.equal(offMod.status, "disabled");
      const offVersions = await readVersions(off.orgId, offMod.id);
      assert.equal(offVersions.length, 1);
      assert.equal(offVersions[0]!.status, "active");
      assert.equal(offMod.activeVersionId, offVersions[0]!.id);
    } finally {
      await dropScratchOrg(bare.orgId);
      await dropScratchOrg(off.orgId);
    }
  },
);
