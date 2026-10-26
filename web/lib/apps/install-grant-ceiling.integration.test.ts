import assert from "node:assert/strict";
import test from "node:test";
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { installApp, AppError } = await import("./store");

function bundle(permissions: string[]) {
  return {
    manifest: {
      key: "grant-ceiling",
      name: "Grant ceiling",
      version: "1.0.0",
      permissions,
      frontend: { entry: "frontend/index.html" },
    },
    files: [{ path: "frontend/index.html", content: "<p>Grant ceiling</p>" }],
  };
}

test(
  "an administrator cannot grant an App permissions they do not hold",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // An App's calls run as whoever opens it. An installer without gl.post
    // granting it would let the App post journals through every controller
    // who opens the App, so the install refuses and nothing is written.
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const installer = await withBypassContext(async () => {
        const id = await createScratchUser(org.orgId, "App installer", "app_installer");
        await db.execute(sql`update app_roles set permissions = '["apps.manage", "records.read"]'::jsonb
        where org_id = ${org.orgId} and key = 'app_installer'`);
        return id;
      });
      await assert.rejects(
        () =>
          withOrgContext(org.orgId, () =>
            installApp(org.orgId, installer, bundle(["records.read", "gl.post"])),
          ),
        (error: unknown) =>
          error instanceof AppError &&
          error.status === 403 &&
          /do not hold: gl\.post/.test(error.message),
      );
      const apps = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from apps where org_id = ${org.orgId}`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(apps, 0);
      await withOrgContext(org.orgId, () =>
        installApp(org.orgId, installer, bundle(["records.read"])),
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
