import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { searchApplication } = await import("./search-read");
type ApplicationContext = import("./context").ApplicationContext;

test("application search caps the real finder results at the caller's limit", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const alphaId = randomUUID();
  const longerId = randomUUID();
  try {
    await withBypassContext(() => db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${alphaId}, ${org.orgId}, 'customer', 'T1 Search Alpha', true, '{}'::jsonb),
             (${longerId}, ${org.orgId}, 'customer', 'T1 Search Alpha Beta', true, '{}'::jsonb)
    `));
    const context: ApplicationContext = {
      authz: {
        user: { orgId: org.orgId, id: randomUUID() } as ApplicationContext["authz"]["user"],
        permissions: new Set(["parties.read"]),
        allowedSubsidiaryIds: null,
      },
      source: "api",
      requestId: randomUUID(),
      apiKeyId: null,
    };

    const result = await withOrgContext(org.orgId, () => searchApplication(context, {
      q: "T1 Search Alpha",
      limit: 1,
    }));

    assert.deepEqual(result, {
      q: "T1 Search Alpha",
      groups: [{
        type: "contact",
        labelKey: "contacts",
        hits: [{
          id: alphaId,
          type: "contact",
          title: "T1 Search Alpha",
          subtitle: undefined,
          href: `/parties?party=${alphaId}`,
          iconKey: "users",
          badge: undefined,
        }],
      }],
      total: 1,
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
