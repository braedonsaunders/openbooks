import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { BUILT_IN_ROLES } from "@openbooks/engine/src/organization/permissions.ts";
import { db, env, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";
import type { ApplicationContext } from "./context";
import type { Authz } from "../authz";
import type { SessionUser } from "../auth";

const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(root + "web/" + specifier.slice(2) + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { applicationContextFromSession } = await import("./context.ts");
const { getSetupRecord, listSetupRecords } = await import("./setup-read.ts");
const { ApplicationError } = await import("./errors.ts");

const DB = !!env.OPENBOOKS_DB_URL;
const ADMIN_PERMISSIONS = ["admin.setup.manage"];
const VIEWER_PERMISSIONS = [...(BUILT_IN_ROLES.viewer?.permissions ?? ["gl.read"])];

function sessionUser(orgId: string, id: string, name: string, roleKey: string, roleName: string): SessionUser {
  return {
    id,
    email: `${id.slice(0, 8)}@scratch.test`,
    name,
    roles: [{ key: roleKey, name: roleName }],
    orgId,
    envKind: "production",
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: id,
    homeOrgId: orgId,
  };
}

function contextFor(
  org: ScratchOrg,
  userId: string,
  name: string,
  roleKey: string,
  roleName: string,
  permissions: string[],
): ApplicationContext {
  const authz: Authz = {
    user: sessionUser(org.orgId, userId, name, roleKey, roleName),
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
  return applicationContextFromSession(authz, "api", randomUUID());
}

async function adminContext(org: ScratchOrg): Promise<ApplicationContext> {
  const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
  return contextFor(org, adminId, "Setup Admin", "admin", "Admin", ADMIN_PERMISSIONS);
}

async function viewerContext(org: ScratchOrg): Promise<ApplicationContext> {
  const { outsiderId } = await withBypassContext(() => seedFlowActors(org.orgId));
  return contextFor(org, outsiderId, "Viewer", "viewer", "Viewer", VIEWER_PERMISSIONS);
}

test("getSetupRecord finds a tax code that a 200-row list page omits", { skip: !DB }, async () => {
  // Wrapped, not baselined: creating a scratch org reaches across tenants, so
  // it runs in the sanctioned bypass context the way every other integration
  // test does. Adding the file to the exposure baseline would have recorded
  // the hole instead of closing it.
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  try {
    const adminA = await adminContext(orgA);
    const adminB = await adminContext(orgB);
    await withOrgContext(orgA.orgId, () => db.execute(sql`
      insert into tax_codes (org_id, code, name)
      select ${orgA.orgId}, 'GET-' || i::text, 'Code ' || i::text
      from generate_series(1, 201) as i`));

    const listed = await withOrgContext(orgA.orgId, () =>
      listSetupRecords(adminA, { entityKey: "tax-codes", limit: 200 }),
    );
    assert.equal(listed.total, 201);
    assert.equal(listed.records.length, 200);
    const listedIds = new Set(listed.records.map((row) => String(row.id)));
    const allIds = (await withOrgContext(orgA.orgId, () => db.execute<{ id: string }>(sql`
      select id from tax_codes where org_id = ${orgA.orgId}`))).rows.map((row) => row.id);
    const omitted = allIds.find((id) => !listedIds.has(id));
    assert.ok(omitted, "the 201st tax code must fall off the 200-row list page");

    const found = await withOrgContext(orgA.orgId, () =>
      getSetupRecord(adminA, { entityKey: "tax-codes", id: omitted }),
    );
    assert.equal(String(found.id), omitted);

    await assert.rejects(
      withOrgContext(orgB.orgId, () => getSetupRecord(adminB, { entityKey: "tax-codes", id: omitted })),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.status, 404);
        assert.match(error.message, /list ids from GET \/api\/v1\/setup\/tax-codes/);
        return true;
      },
    );

    await assert.rejects(
      withOrgContext(orgA.orgId, () => getSetupRecord(adminA, { entityKey: "tax-codes", id: randomUUID() })),
      /list ids from GET \/api\/v1\/setup\/tax-codes/,
    );

    const viewer = await viewerContext(orgA);
    await assert.rejects(
      withOrgContext(orgA.orgId, () => getSetupRecord(viewer, { entityKey: "tax-codes", id: omitted })),
      /forbidden/,
    );
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});
