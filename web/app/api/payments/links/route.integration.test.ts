import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const routeState = Symbol.for("openbooks-payment-links-route-test");
;(globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] = {
  authz: null as { user: { orgId: string; id: string } } | null,
};

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks-payment-links-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return { ...state.authz, permissions: new Set(), allowedSubsidiaryIds: null }
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("payments/links")) {
      return { url: "mock:payment-links-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:payment-links-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?payment-links-boundary-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sealJson } = await import("@openbooks/engine/src/platform/secrets.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/testing/fixtures.ts",
);

function request(body: unknown): Request {
  return new Request("http://localhost/api/payments/links", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("payment-link API rejects a malformed bank reference before any link write", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, actorId } = await withBypassContext(async () => {
    const seeded = await createScratchOrg();
    const seededActor = await createScratchUser(seeded.orgId, "Payment links", "admin");
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"onlinePayments":true}'::jsonb)
       where id = ${seeded.orgId}
    `);
    return { org: seeded, actorId: seededActor };
  });
  try {
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = { user: { orgId: org.orgId, id: actorId } };

    const before = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from payment_links where org_id = ${org.orgId}
    `);
    const response = await POST(request({
      provider: "stripe",
      documentId: randomUUID(),
      bankAccountId: "not-a-uuid",
    }));
    assert.equal(response.status, 400);
    const after = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from payment_links where org_id = ${org.orgId}
    `);
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
  } finally {
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

async function linkFixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Payment links", "admin");
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"onlinePayments":true}'::jsonb)
       where id = ${org.orgId}
    `);
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-LINKSTATE',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${invoiceId} and org_id = ${org.orgId}`);
    await withOrgContext(org.orgId, () => postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }));
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
              ${sealJson({ apiKey: "sk_test_itest", webhookSecret: "whsec_linkstate" })}, ${actorId}, ${actorId})`);
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = { user: { orgId: org.orgId, id: actorId } };
    return { org, invoiceId };
  });
}

async function getLinks(orgId: string, invoiceId: string) {
  const response = await withOrgContext(orgId, () =>
    GET(new Request(`http://localhost/api/payments/links?documentId=${invoiceId}`)));
  return { status: response.status, json: (await response.json()) as {
    links: { id: string; token: string; tokenState: string }[];
  } };
}

test("a mintable link lists with a usable token", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, invoiceId } = await linkFixture();
  try {
    const created = await withOrgContext(org.orgId, () => POST(request({
      provider: "stripe",
      documentId: invoiceId,
    })));
    assert.equal(created.status, 201);
    const listed = await getLinks(org.orgId, invoiceId);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.links.length, 1);
    assert.equal(listed.json.links[0]!.tokenState, "ok");
    assert.ok(listed.json.links[0]!.token.length > 0, "an ok link carries its pay token");
  } finally {
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a tampered sealed token lists the link as unavailable with no URL", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, invoiceId } = await linkFixture();
  try {
    const created = await withOrgContext(org.orgId, () => POST(request({
      provider: "stripe",
      documentId: invoiceId,
    })));
    assert.equal(created.status, 201);
    const linkId = ((await created.json()) as { id: string }).id;
    await db.execute(sql`
      update payment_links set token_sealed = 'tampered' where id = ${linkId} and org_id = ${org.orgId}
    `);
    const listed = await getLinks(org.orgId, invoiceId);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.links.length, 1);
    assert.equal(listed.json.links[0]!.tokenState, "unsealable");
    assert.equal(listed.json.links[0]!.token, "", "an unsealable link carries no token to build a URL from");
  } finally {
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
