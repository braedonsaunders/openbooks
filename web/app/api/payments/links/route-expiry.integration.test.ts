import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

// Live-Postgres regression: POST /api/payments/links accepts expiresOn as an
// unvalidated string, so a shape-valid non-day such as February 30 sails
// through and dies in Postgres as a raw DATE failure (HTTP 500 — the route
// only maps PaymentAcceptanceError to 422) instead of failing closed with a
// named 422 and nothing written.
const routeState = Symbol.for("openbooks-payment-links-expiry-test");
;(globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] = {
  authz: null as { user: { orgId: string; id: string } } | null,
};

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks-payment-links-expiry-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return { ...state.authz, permissions: new Set(), allowedSubsidiaryIds: null }
  }
`;

const engineRoot = new URL("../../../../../engine/", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Bare @openbooks/engine/* resolves cross-checkout (worktree node_modules
    // symlinks it to main), which would exercise main's payment-acceptance
    // instead of the worktree copy under test. Pin the engine graph to the
    // worktree so the refusal under test is the one this change adds.
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href, context);
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("payments/links")) {
      return { url: "mock:payment-links-expiry-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:payment-links-expiry-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?payment-links-expiry-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sealJson } = await import("@openbooks/engine/src/platform/secrets.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
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
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-EXPIRY',
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
            ${sealJson({ apiKey: "sk_test_itest", webhookSecret: "whsec_expiry" })}, ${actorId}, ${actorId})`);
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
    authz: { user: { orgId: string; id: string } } | null;
  };
  state.authz = { user: { orgId: org.orgId, id: actorId } };
  return { org, invoiceId };
}

async function post(orgId: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(orgId, () => POST(
      new Request("http://localhost/api/payments/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ));
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } };
  }
}

async function linkCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ count: number }>(sql`
    select count(*)::int as count from payment_links where org_id = ${orgId}`)).rows;
  return rows[0]!.count;
}

test("POST refuses an impossible expiresOn without writing a link", { skip: !DB }, async () => {
  const { org, invoiceId } = await fixture();
  try {
    const result = await post(org.orgId, { provider: "stripe", documentId: invoiceId, expiresOn: "2024-02-30" });
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(await linkCount(org.orgId), 0);
  } finally {
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("POST still creates a link with a real expiresOn", { skip: !DB }, async () => {
  const { org, invoiceId } = await fixture();
  try {
    const result = await post(org.orgId, { provider: "stripe", documentId: invoiceId, expiresOn: "2024-02-29" });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    assert.equal(await linkCount(org.orgId), 1);
  } finally {
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
