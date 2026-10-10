import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const crmRealUrl = new URL(
  "../../../../engine/src/crm/crm.ts",
  import.meta.url,
).href;

const mockCrm = `
  import { CrmLifecycleRefusalError } from ${JSON.stringify(crmRealUrl)};
  export * from ${JSON.stringify(crmRealUrl)};
  export async function promoteCrmAccount() {
    throw new CrmLifecycleRefusalError(
      "cannot demote this customer back to prospect while documents are in flight or carry an open balance — resolve in-flight transactions and open balances before changing the stage",
    );
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openbooks/engine/src/crm/crm.ts") {
      return { url: "mock:quote-crm-refusal-crm", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:quote-crm-refusal-crm") {
      return { format: "module", source: mockCrm, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createOrder } = await import("./create.ts");
hooks.deregister();

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * The create boundary maps a CRM lifecycle refusal to a 422 carrying its
 * message — never a 500 with "Save failed". The kernel under test is forced
 * through the refusal with a module double (a real demotion can no longer
 * reach it: quoting only ever advances the lifecycle).
 */
test("an estimate create maps a lifecycle refusal to a 422 with its message", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Estimator", "admin"));
    const partyId = (
      await withBypassContext(() =>
        db.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, display_name, is_active)
          values (${org.orgId}, 'company', 'Refused Customer', true) returning id`),
      )
    ).rows[0]!.id;
    const res = (await withOrgContext(
      org.orgId,
      () =>
        createOrder(
          { kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" },
          { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: null } as never,
          new Request("http://openbooks.test/api/estimates", {
            method: "POST",
            headers: { "Idempotency-Key": randomUUID() },
          }),
          {
            partyId,
            documentDate: org.date,
            lines: [{ itemId: org.items.service, quantity: "1", unitPrice: "100" }],
          } as never,
        ) as Promise<Response>,
    )) as Response;
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error?: unknown };
    assert.match(String(body.error ?? ""), /cannot demote this customer/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
