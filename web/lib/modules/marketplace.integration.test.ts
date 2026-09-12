import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// marketplace.ts is a server-only module: stub the marker before the first
// import resolves it, the same way web/lib/application integration tests do.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { installModule, uninstallModule, upgradeModule } = await import(
  "@openbooks/engine/src/modules/installer.ts"
);
const {
  ModuleMarketplaceError,
  installModuleFromListing,
  isModuleListingManifest,
  isModulePublished,
  listModuleListings,
  publishModule,
} = await import("./marketplace.ts");

const DB = !!env.OPENBOOKS_DB_URL;

/**
 * Live-PG proof for the module marketplace (web/lib/modules/marketplace.ts).
 * The slice check is end to end across orgs: publish an installed module in
 * org A, install it in org B through installModule(), and show the listing
 * is a frozen snapshot that publisher-side upgrades and uninstalls never
 * move — while org B's install leaves every publisher table untouched.
 *
 * Listings are deployment-wide (one row per key, no org_id), so every test
 * uses its own module key: scratch-org teardown cannot isolate them.
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
function specFor(route: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { specVersion: 1, route, layout: "list", header: [], body: [], ...extra };
}

/** A minimal valid module manifest in the shape the installer accepts. The page route derives from the key so two modules can coexist in one scratch org. */
function manifest(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const route = `/reports/${key}`;
  return {
    key,
    name: "Bazaar Ledger",
    version: "1.0.0",
    description: "A marketplace-probed module",
    permissions: ["records.read"],
    contributions: [{ kind: "page", route, spec: specFor(route) }],
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

/** Every audit row names its actor and carries before/after/reason. */
function assertAudited(rows: AuditRow[], actorId: string) {
  assert.ok(rows.length > 0, "expected at least one audit row");
  for (const row of rows) {
    assert.equal(row.actor_id, actorId, `audit row for ${row.table_name} names its actor`);
    assert.equal(typeof row.changes.reason, "string", `audit row for ${row.table_name} carries a reason`);
    assert.ok("before" in row.changes, `audit row for ${row.table_name} carries before`);
    assert.ok("after" in row.changes, `audit row for ${row.table_name} carries after`);
  }
}

async function auditCount(orgId: string): Promise<number> {
  return Number(
    (
      await withOrgContext(orgId, () =>
        db.execute<{ n: string }>(sql`select count(*) as n from audit_log where org_id = ${orgId}`),
      )
    ).rows[0]!.n,
  );
}

type ListingSnapshot = {
  id: string;
  version: string;
  manifest: unknown;
  files: unknown;
  isActive: boolean;
};

async function listingByKey(key: string): Promise<ListingSnapshot | undefined> {
  return (
    await withBypass(() =>
      db.execute<ListingSnapshot>(sql`
        select id, version, manifest, files, is_active as "isActive"
          from app_listings where key = ${key} limit 1`),
    )
  ).rows[0];
}

/** Install + publish a module in a scratch org; returns the listing id. */
async function publishFixtureModule(fx: Fixture, key: string): Promise<string> {
  await withBypass(() =>
    installModule({
      orgId: fx.orgId,
      actorId: fx.actorId,
      manifest: manifest(key),
      installerEffectivePermissions: ["records.read"],
    }),
  );
  const pub = await withBypass(() => publishModule(fx.orgId, fx.actorId, key));
  assert.ok(pub.id, "publish returns the listing id");
  return pub.id;
}

test(
  "publish in org A, install in org B through the installer — projections, audit, publisher untouched",
  { skip: !DB },
  async () => {
    const key = "bazaar-ledger";
    const publisher = await makeFixture();
    const installer = await makeFixture();
    try {
      const listingId = await publishFixtureModule(publisher, key);

      assert.equal(await withBypass(() => isModulePublished(key)), true);

      const library = await withBypass(() => listModuleListings({ page: 1, perPage: 10 }));
      const entry = library.listings.find((l) => l.key === key);
      assert.ok(entry, "the published module appears in the module library");
      assert.equal(entry.version, "1.0.0");
      assert.equal(entry.publisherOrgId, publisher.orgId);
      const searched = await withBypass(() => listModuleListings({ query: key, page: 1, perPage: 10 }));
      assert.ok(
        searched.listings.some((l) => l.key === key),
        "server-side search finds the published module",
      );

      // Publisher state BEFORE org B installs: any write org B's install
      // makes to org A must show up as a diff here.
      const snapshot = await listingByKey(key);
      const publisherModuleBefore = (
        await withOrgContext(publisher.orgId, () =>
          db.execute<{ id: string; status: string; active_version_id: string | null }>(
            sql`select id, status, active_version_id from modules where org_id = ${publisher.orgId} and key = ${key}`,
          ),
        )
      ).rows;
      const publisherVersionsBefore = (
        await withOrgContext(publisher.orgId, () =>
          db.execute<{ id: string; version: string; status: string; manifest: unknown }>(
            sql`select id, version, status, manifest from module_versions where org_id = ${publisher.orgId}`,
          ),
        )
      ).rows;
      const publisherSpecsBefore = (
        await withOrgContext(publisher.orgId, () =>
          db.execute<{ id: string; route: string; spec: unknown; is_active: boolean }>(
            sql`select id, route, spec, is_active from page_specs where org_id = ${publisher.orgId}`,
          ),
        )
      ).rows;
      const publisherAuditBefore = await auditCount(publisher.orgId);

      const out = await withBypass(() =>
        installModuleFromListing(installer.orgId, installer.actorId, listingId, {
          installerEffectivePermissions: ["records.read"],
        }),
      );
      assert.equal(out.key, key);
      assert.equal(out.outcome, "installed");

      const installed = (
        await withOrgContext(installer.orgId, () =>
          db.execute<{
            id: string;
            key: string;
            status: string;
            active_version_id: string | null;
            granted_permissions: string[];
          }>(
            sql`select id, key, status, active_version_id, granted_permissions from modules where org_id = ${installer.orgId}`,
          ),
        )
      ).rows;
      assert.equal(installed.length, 1);
      assert.equal(installed[0]!.key, key);
      assert.equal(installed[0]!.status, "installed");
      assert.equal(installed[0]!.active_version_id, out.versionId);
      assert.equal(installed[0]!.id, out.moduleId);
      assert.deepEqual(installed[0]!.granted_permissions, ["records.read"]);

      const versions = (
        await withOrgContext(installer.orgId, () =>
          db.execute<{ id: string; version: string; status: string; manifest: unknown }>(
            sql`select id, version, status, manifest from module_versions where org_id = ${installer.orgId}`,
          ),
        )
      ).rows;
      assert.equal(versions.length, 1);
      assert.equal(versions[0]!.version, "1.0.0");
      assert.equal(versions[0]!.status, "active");
      // The install consumed the listing snapshot bytes, not publisher tables.
      assert.deepEqual(versions[0]!.manifest, snapshot!.manifest);

      const specs = (
        await withOrgContext(installer.orgId, () =>
          db.execute<{ id: string; route: string; spec: unknown; module_version_id: string | null; is_active: boolean }>(
            sql`select id, route, spec, module_version_id, is_active from page_specs where org_id = ${installer.orgId}`,
          ),
        )
      ).rows;
      assert.equal(specs.length, 1);
      assert.equal(specs[0]!.route, "/reports/bazaar-ledger");
      assert.equal(specs[0]!.module_version_id, out.versionId);
      assert.equal(specs[0]!.is_active, true);
      assert.deepEqual(specs[0]!.spec, specFor("/reports/bazaar-ledger"));

      // The install is audited in the INSTALLING org with marketplace provenance.
      assertAudited(await auditFor(installer.orgId, "modules", out.moduleId), installer.actorId);
      assertAudited(await auditFor(installer.orgId, "module_versions", out.versionId), installer.actorId);
      const projectionAudit = await auditFor(installer.orgId, "page_specs", specs[0]!.id);
      assertAudited(projectionAudit, installer.actorId);
      for (const row of [
        ...(await auditFor(installer.orgId, "modules", out.moduleId)),
        ...projectionAudit,
      ]) {
        assert.match(
          String(row.changes.reason ?? ""),
          /marketplace install/,
          "marketplace installs record their provenance as the audit reason",
        );
      }

      // Publisher untouched: same rows, same bytes, zero new audit rows.
      assert.deepEqual(
        (
          await withOrgContext(publisher.orgId, () =>
            db.execute<{ id: string; status: string; active_version_id: string | null }>(
              sql`select id, status, active_version_id from modules where org_id = ${publisher.orgId} and key = ${key}`,
            ),
          )
        ).rows,
        publisherModuleBefore,
      );
      assert.deepEqual(
        (
          await withOrgContext(publisher.orgId, () =>
            db.execute<{ id: string; version: string; status: string; manifest: unknown }>(
              sql`select id, version, status, manifest from module_versions where org_id = ${publisher.orgId}`,
            ),
          )
        ).rows,
        publisherVersionsBefore,
      );
      assert.deepEqual(
        (
          await withOrgContext(publisher.orgId, () =>
            db.execute<{ id: string; route: string; spec: unknown; is_active: boolean }>(
              sql`select id, route, spec, is_active from page_specs where org_id = ${publisher.orgId}`,
            ),
          )
        ).rows,
        publisherSpecsBefore,
      );
      assert.equal(await auditCount(publisher.orgId), publisherAuditBefore);
    } finally {
      await withBypass(() => dropScratchOrg(installer.orgId));
      await withBypass(() => dropScratchOrg(publisher.orgId));
    }
  },
);

test(
  "the listing is a frozen snapshot: publisher upgrades and uninstalls never move it",
  { skip: !DB },
  async () => {
    const key = "bazaar-frozen";
    const publisher = await makeFixture();
    const first = await makeFixture();
    const second = await makeFixture();
    const third = await makeFixture();
    try {
      const listingId = await publishFixtureModule(publisher, key);
      const frozen = (await listingByKey(key))!;
      assert.equal(frozen.version, "1.0.0");
      assert.equal(frozen.isActive, true);
      assert.deepEqual(frozen.files, []);

      // The publisher ships v2 with an extra route; the snapshot must not follow.
      await withBypass(() =>
        upgradeModule({
          orgId: publisher.orgId,
          actorId: publisher.actorId,
          key,
          manifest: manifest(key, {
            version: "2.0.0",
            contributions: [
              { kind: "page", route: "/reports/bazaar-frozen", spec: specFor("/reports/bazaar-frozen", { layout: "detail" }) },
              { kind: "page", route: "/reports/bazaar-frozen-detail", spec: specFor("/reports/bazaar-frozen-detail") },
            ],
          }),
          installerEffectivePermissions: ["records.read"],
        }),
      );
      const afterUpgrade = (await listingByKey(key))!;
      assert.equal(afterUpgrade.version, "1.0.0");
      assert.deepEqual(afterUpgrade.manifest, frozen.manifest);

      // A later org installs the FROZEN v1 bytes through the installer.
      const v1 = await withBypass(() =>
        installModuleFromListing(first.orgId, first.actorId, listingId, {
          installerEffectivePermissions: ["records.read"],
        }),
      );
      assert.equal(v1.key, key);
      const v1Version = (
        await withOrgContext(first.orgId, () =>
          db.execute<{ version: string; manifest: unknown }>(
            sql`select version, manifest from module_versions where org_id = ${first.orgId}`,
          ),
        )
      ).rows[0]!;
      assert.equal(v1Version.version, "1.0.0");
      assert.deepEqual(v1Version.manifest, frozen.manifest);
      const v1Specs = (
        await withOrgContext(first.orgId, () =>
          db.execute<{ route: string; spec: unknown; is_active: boolean }>(
            sql`select route, spec, is_active from page_specs where org_id = ${first.orgId} order by route`,
          ),
        )
      ).rows;
      assert.deepEqual(
        v1Specs.map((s) => [s.route, s.is_active]),
        [["/reports/bazaar-frozen", true]],
        "the v2-only route is absent: installs project the snapshot, not the publisher's live rows",
      );
      assert.deepEqual(
        v1Specs[0]!.spec,
        specFor("/reports/bazaar-frozen"),
        "the installed spec is the v1 bytes, not the publisher's v2 layout",
      );

      // Publishing again re-snapshots: the listing moves to v2 only because someone published.
      await withBypass(() => publishModule(publisher.orgId, publisher.actorId, key));
      const resnapshotted = (await listingByKey(key))!;
      assert.equal(resnapshotted.version, "2.0.0");
      const v2 = await withBypass(() =>
        installModuleFromListing(second.orgId, second.actorId, resnapshotted.id, {
          installerEffectivePermissions: ["records.read"],
        }),
      );
      const v2Version = (
        await withOrgContext(second.orgId, () =>
          db.execute<{ version: string }>(sql`select version from module_versions where org_id = ${second.orgId}`),
        )
      ).rows[0]!;
      assert.equal(v2Version.version, "2.0.0");
      assert.equal(v2.key, key);

      // Uninstalling in the publishing org deactivates its own rows but leaves the listing live.
      await withBypass(() => uninstallModule({ orgId: publisher.orgId, actorId: publisher.actorId, key }));
      const afterUninstall = (await listingByKey(key))!;
      assert.equal(afterUninstall.isActive, true);
      assert.equal(afterUninstall.version, "2.0.0");
      assert.deepEqual(afterUninstall.manifest, resnapshotted.manifest);
      const v2Again = await withBypass(() =>
        installModuleFromListing(third.orgId, third.actorId, afterUninstall.id, {
          installerEffectivePermissions: ["records.read"],
        }),
      );
      assert.equal(v2Again.key, key);
      const thirdVersion = (
        await withOrgContext(third.orgId, () =>
          db.execute<{ version: string }>(sql`select version from module_versions where org_id = ${third.orgId}`),
        )
      ).rows[0]!;
      assert.equal(thirdVersion.version, "2.0.0");
    } finally {
      await withBypass(() => dropScratchOrg(third.orgId));
      await withBypass(() => dropScratchOrg(second.orgId));
      await withBypass(() => dropScratchOrg(first.orgId));
      await withBypass(() => dropScratchOrg(publisher.orgId));
    }
  },
);

test(
  "boundaries: unknown modules, unknown listings, app listings, and key ownership",
  { skip: !DB },
  async () => {
    const key = "bazaar-guarded";
    const publisher = await makeFixture();
    const other = await makeFixture();
    try {
      // Publishing something that was never installed is a named 404, never a TypeError.
      const missing = await withBypass(() => publishModule(publisher.orgId, publisher.actorId, key)).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(missing instanceof ModuleMarketplaceError);
      assert.equal(missing.status, 404);
      assert.equal(await withBypass(() => isModulePublished(key)), false);

      // Installing from a listing id that does not exist is a named 404.
      const ghost = await withBypass(() =>
        installModuleFromListing(publisher.orgId, publisher.actorId, "00000000-0000-4000-8000-000000000000", {
          installerEffectivePermissions: ["records.read"],
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(ghost instanceof ModuleMarketplaceError);
      assert.equal(ghost.status, 404);

      // An app-shaped listing is discriminated by manifest shape: invisible to
      // the module surface and refused at the install boundary.
      const appManifest = { key: "plain-app-listing", name: "Plain App", version: "1.0.0", frontend: { entry: "index.html" } };
      await withBypass(() =>
        db.execute(sql`
          insert into app_listings (publisher_org_id, key, name, description, icon_key, version, manifest, files, is_active, created_by, updated_by)
          values (${publisher.orgId}, 'plain-app-listing', 'Plain App', null, 'box', '1.0.0',
                  ${JSON.stringify(appManifest)}::jsonb, '[]'::jsonb, true, ${publisher.actorId}, ${publisher.actorId})`),
      );
      assert.equal(isModuleListingManifest(appManifest), false);
      assert.equal(
        isModuleListingManifest({ contributions: [{ kind: "page" }] }),
        true,
        "a contributions manifest with no frontend key is module-shaped",
      );
      assert.equal(await withBypass(() => isModulePublished("plain-app-listing")), false);
      const library = await withBypass(() => listModuleListings({ page: 1, perPage: 100 }));
      assert.ok(
        library.listings.every((l) => l.key !== "plain-app-listing"),
        "app listings never appear in the module library",
      );
      const appListingId = (await listingByKey("plain-app-listing"))!.id;
      await assert.rejects(
        withBypass(() =>
          installModuleFromListing(publisher.orgId, publisher.actorId, appListingId, {
            installerEffectivePermissions: ["records.read"],
          }),
        ),
        /not a module listing/,
      );

      // One listing per key deployment-wide: only the original publisher org may update it.
      const listingId = await publishFixtureModule(publisher, key);
      assert.ok(listingId);
      await withBypass(() =>
        installModule({
          orgId: other.orgId,
          actorId: other.actorId,
          manifest: manifest(key),
          installerEffectivePermissions: ["records.read"],
        }),
      );
      await assert.rejects(
        withBypass(() => publishModule(other.orgId, other.actorId, key)),
        /already published by another org/,
      );

      // A publish never converts the other kind: a module cannot claim an app listing's key.
      // The app listing is owned by the publishing org itself, so the refusal
      // names the kind collision rather than key ownership.
      await withBypass(() =>
        db.execute(sql`
          insert into app_listings (publisher_org_id, key, name, description, icon_key, version, manifest, files, is_active, created_by, updated_by)
          values (${publisher.orgId}, 'bazaar-claimed', 'Claimed App', null, 'box', '3.0.0',
                  ${JSON.stringify({ key: "bazaar-claimed", name: "Claimed App", version: "3.0.0", frontend: { entry: "index.html" } })}::jsonb,
                  '[]'::jsonb, true, ${publisher.actorId}, ${publisher.actorId})`),
      );
      await withBypass(() =>
        installModule({
          orgId: publisher.orgId,
          actorId: publisher.actorId,
          manifest: manifest("bazaar-claimed"),
          installerEffectivePermissions: ["records.read"],
        }),
      );
      await assert.rejects(
        withBypass(() => publishModule(publisher.orgId, publisher.actorId, "bazaar-claimed")),
        /already published as an app listing/,
      );
    } finally {
      await withBypass(() => dropScratchOrg(other.orgId));
      await withBypass(() => dropScratchOrg(publisher.orgId));
    }
  },
);
