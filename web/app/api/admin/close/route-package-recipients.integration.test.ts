import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A close reporting package with a malformed recipient must fail closed at
// the save boundary (422, nothing written): the delivery worker hands the
// stored list straight to the email queue, whose provider validation throws
// on the first invalid address — after every attached report was rendered —
// so the job burns all three attempts and the close package is never
// delivered, with only worker logs as evidence.

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __closePackageRecipientsUser: state });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/close/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__closePackageRecipientsUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("./route");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
hooks.deregister();

const request = (body: unknown) =>
  new Request("http://close.local/api/admin/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function setup() {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Close Package Admin", "close-admin");
  state.user = { orgId: org.orgId, id: actorId };
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features":{"advancedClose":true}}'::jsonb where id = ${org.orgId}`),
  );
  return { org };
}

test("save-package refuses a malformed recipient without writing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await setup();
  try {
    const response = await withOrgContext(org.orgId, () => POST(request({
      action: "save-package",
      name: "Recipient Contract",
      reports: [{ slug: "trial-balance" }],
      recipients: ["controller@example.com", "not-an-email"],
      delivery: {},
      isActive: true,
    })));
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${await response.text()}`);
    const rows = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from close_reporting_packages
       where org_id = ${org.orgId} and name = 'Recipient Contract'
    `));
    assert.equal(rows.rows[0]!.count, 0, "a refused package must not be stored");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("save-package still stores a fully valid recipient list", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await setup();
  try {
    const response = await withOrgContext(org.orgId, () => POST(request({
      action: "save-package",
      name: "Valid Recipients",
      reports: [{ slug: "trial-balance" }],
      recipients: ["Controller@Example.com"],
      delivery: {},
      isActive: true,
    })));
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${await response.text()}`);
    const rows = (await db.execute<{ recipients: string[] }>(sql`
      select recipients from close_reporting_packages
       where org_id = ${org.orgId} and name = 'Valid Recipients'
    `));
    assert.deepEqual(rows.rows[0]!.recipients, ["Controller@Example.com"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
